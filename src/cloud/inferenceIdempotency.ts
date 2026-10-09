import type { CloudDb } from "./db";

export const CLOUD_INFERENCE_IDEMPOTENCY_RESPONSE_TTL_MS = 24 * 60 * 60 * 1000;
/** Accepted idempotency keys are retained for 30 days, then may be reused. */
export const CLOUD_INFERENCE_IDEMPOTENCY_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CLOUD_INFERENCE_IDEMPOTENCY_CLAIM_LEASE_MS = 2 * 60 * 1000;
export const CLOUD_INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES = 128 * 1024;
export const CLOUD_INFERENCE_IDEMPOTENCY_CLEANUP_BATCH_SIZE = 200;
export const CLOUD_INFERENCE_IDEMPOTENCY_TENANT_CAP = 10_000;
export const CLOUD_INFERENCE_IDEMPOTENCY_GLOBAL_CAP = 250_000;

const KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const MAX_CANONICAL_REQUEST_BYTES = 1024 * 1024;
const MAX_CLEANUP_BATCH_SIZE = 1000;
const HKDF_SALT = new TextEncoder().encode("omniroute-cloud-inference-idempotency-v1");
const REQUEST_HASH_PURPOSE = "cloud-inference-request-fingerprint-v1";

export interface CloudInferenceIdempotencyScope {
  tenantId: string;
  principalId: string;
  apiKeyId: string;
}

export interface CloudInferenceIdempotencyClaim extends CloudInferenceIdempotencyScope {
  idempotencyKeyHash: string;
  requestHash: string;
  requestId: string;
  claimToken: string;
}

interface IdempotencyRow {
  tenant_id: string;
  principal_id: string;
  api_key_id: string;
  idempotency_key_hash: string;
  request_hash: string;
  request_id: string;
  claim_token: string | null;
  state: "claimed" | "completed" | "outcome_unavailable";
  claimed_at_ms: number;
  claim_expires_at_ms: number | null;
  response_expires_at_ms: number;
  response_status: number | null;
  response_body: string | null;
  tombstone_expires_at_ms: number;
}

export type CloudInferenceIdempotencyResult =
  | { kind: "claimed"; claim: CloudInferenceIdempotencyClaim }
  | { kind: "in_progress"; requestId: string; retryAfterMs: number }
  | { kind: "replay"; requestId: string; status: number; body: string }
  | { kind: "conflict" }
  | { kind: "outcome_unavailable"; requestId: string }
  | { kind: "capacity" };

export type CompleteCloudInferenceIdempotencyResult =
  { kind: "completed" } | { kind: "outcome_unavailable" } | { kind: "not_claim_owner" };

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeRequestHashSecret(secret: string): Uint8Array {
  if (typeof secret !== "string" || !/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(secret)) {
    throw new Error("Invalid cloud inference idempotency request hash secret");
  }
  let decoded: string;
  try {
    decoded = atob(secret);
  } catch {
    throw new Error("Invalid cloud inference idempotency request hash secret");
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32 || btoa(decoded) !== secret) {
    throw new Error("Invalid cloud inference idempotency request hash secret");
  }
  return bytes;
}

export function isCloudInferenceIdempotencySecret(secret: string | undefined): boolean {
  if (secret === undefined) return false;
  try {
    decodeRequestHashSecret(secret);
    return true;
  } catch {
    return false;
  }
}

async function scopedHmac(
  secret: Uint8Array,
  purpose: string,
  scope: CloudInferenceIdempotencyScope,
  value: string
): Promise<string> {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: new TextEncoder().encode(purpose) },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"]
  );
  const input = JSON.stringify([scope.tenantId, scope.principalId, scope.apiKeyId, value]);
  return hex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)))
  );
}

async function sha256(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  );
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Inference idempotency request is not JSON-safe");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error("Inference idempotency request is not JSON-safe");
  }
  if (ancestors.has(value)) throw new Error("Inference idempotency request contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Inference idempotency request must use plain JSON objects");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export async function hashCanonicalCloudInferenceRequest(
  request: unknown,
  scope: CloudInferenceIdempotencyScope,
  requestHashSecret: string
): Promise<string> {
  validateScope(scope);
  const canonical = canonicalJson(request);
  if (new TextEncoder().encode(canonical).byteLength > MAX_CANONICAL_REQUEST_BYTES) {
    throw new Error("Inference idempotency request exceeds the canonical hash size limit");
  }
  return scopedHmac(
    decodeRequestHashSecret(requestHashSecret),
    REQUEST_HASH_PURPOSE,
    scope,
    canonical
  );
}

function validateScope(scope: CloudInferenceIdempotencyScope): void {
  for (const [name, value] of Object.entries(scope)) {
    if (
      typeof value !== "string" ||
      value.trim().length < 1 ||
      value !== value.trim() ||
      value.length > 128
    ) {
      throw new Error(`Invalid inference idempotency ${name}`);
    }
  }
}

function isCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("cloud inference idempotency") && message.includes("capacity");
}

async function getRow(
  db: CloudDb,
  scope: CloudInferenceIdempotencyScope,
  idempotencyKeyHash: string
): Promise<IdempotencyRow | null> {
  return db
    .prepare<IdempotencyRow>(
      `SELECT * FROM cloud_inference_idempotency
       WHERE tenant_id = ? AND principal_id = ? AND api_key_id = ? AND idempotency_key_hash = ?
       LIMIT 1`
    )
    .bind(scope.tenantId, scope.principalId, scope.apiKeyId, idempotencyKeyHash)
    .first();
}

function rowMatchesScopeAndHash(
  row: IdempotencyRow,
  scope: CloudInferenceIdempotencyScope,
  requestHash: string
): boolean {
  return (
    row.tenant_id === scope.tenantId &&
    row.principal_id === scope.principalId &&
    row.api_key_id === scope.apiKeyId &&
    row.request_hash === requestHash
  );
}

async function makeOutcomeUnavailable(
  db: CloudDb,
  row: IdempotencyRow,
  nowMs: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE cloud_inference_idempotency
          SET state = 'outcome_unavailable', claim_token = NULL, claim_expires_at_ms = NULL,
              response_status = NULL, response_body = NULL, updated_at_ms = ?
        WHERE tenant_id = ? AND principal_id = ? AND api_key_id = ? AND idempotency_key_hash = ?
          AND state IN ('claimed', 'completed')`
    )
    .bind(nowMs, row.tenant_id, row.principal_id, row.api_key_id, row.idempotency_key_hash)
    .run();
}

async function existingResult(
  db: CloudDb,
  row: IdempotencyRow,
  scope: CloudInferenceIdempotencyScope,
  requestHash: string,
  claimToken: string,
  nowMs: number
): Promise<CloudInferenceIdempotencyResult> {
  if (!rowMatchesScopeAndHash(row, scope, requestHash)) return { kind: "conflict" };
  if (row.state === "outcome_unavailable") {
    return { kind: "outcome_unavailable", requestId: row.request_id };
  }
  if (row.state === "completed") {
    if (
      row.response_expires_at_ms <= nowMs ||
      row.response_body === null ||
      row.response_status === null
    ) {
      await makeOutcomeUnavailable(db, row, nowMs);
      return { kind: "outcome_unavailable", requestId: row.request_id };
    }
    return {
      kind: "replay",
      requestId: row.request_id,
      status: row.response_status,
      body: row.response_body,
    };
  }
  if (row.claim_token === claimToken) {
    return {
      kind: "claimed",
      claim: {
        tenantId: row.tenant_id,
        principalId: row.principal_id,
        apiKeyId: row.api_key_id,
        idempotencyKeyHash: row.idempotency_key_hash,
        requestHash: row.request_hash,
        requestId: row.request_id,
        claimToken,
      },
    };
  }
  if (row.claim_expires_at_ms !== null && row.claim_expires_at_ms > nowMs) {
    return {
      kind: "in_progress",
      requestId: row.request_id,
      retryAfterMs: row.claim_expires_at_ms - nowMs,
    };
  }
  await makeOutcomeUnavailable(db, row, nowMs);
  return { kind: "outcome_unavailable", requestId: row.request_id };
}

/**
 * Atomically claim a tenant/key/principal-scoped key. Claims are never taken
 * over after a lease expires: an uncertain upstream call remains blocked through the 30-day
 * tombstone window instead of risking an immediate duplicate dispatch.
 */
export async function claimCloudInferenceIdempotency(
  db: CloudDb,
  input: {
    key: string;
    scope: CloudInferenceIdempotencyScope;
    request: unknown;
    /** Dedicated Worker secret, canonical base64 encoding of exactly 32 random bytes. */
    requestHashSecret: string;
    nowMs?: number;
  }
): Promise<CloudInferenceIdempotencyResult> {
  validateScope(input.scope);
  const secret = decodeRequestHashSecret(input.requestHashSecret);
  if (!KEY_PATTERN.test(input.key)) return { kind: "conflict" };
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid idempotency clock value");
  const canonicalRequest = canonicalJson(input.request);
  if (new TextEncoder().encode(canonicalRequest).byteLength > MAX_CANONICAL_REQUEST_BYTES) {
    throw new Error("Inference idempotency request exceeds the canonical hash size limit");
  }
  const [requestHash, idempotencyKeyHash] = await Promise.all([
    scopedHmac(secret, REQUEST_HASH_PURPOSE, input.scope, canonicalRequest),
    // The client key is high entropy. Keep its stable digest so HMAC key rotation
    // cannot produce a second ledger identity and redispatch the same request.
    sha256(input.key),
  ]);
  const claimToken = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const claimExpiresAtMs = nowMs + CLOUD_INFERENCE_IDEMPOTENCY_CLAIM_LEASE_MS;
  const responseExpiresAtMs = nowMs + CLOUD_INFERENCE_IDEMPOTENCY_RESPONSE_TTL_MS;

  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO cloud_inference_idempotency (
           tenant_id, principal_id, api_key_id, idempotency_key_hash, request_hash,
           request_id, claim_token, state, claimed_at_ms, claim_expires_at_ms,
           response_expires_at_ms, response_status, response_body, created_at_ms, updated_at_ms,
           tombstone_expires_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, NULL, NULL, ?, ?, ?)`
      )
      .bind(
        input.scope.tenantId,
        input.scope.principalId,
        input.scope.apiKeyId,
        idempotencyKeyHash,
        requestHash,
        requestId,
        claimToken,
        nowMs,
        claimExpiresAtMs,
        responseExpiresAtMs,
        nowMs,
        nowMs,
        nowMs + CLOUD_INFERENCE_IDEMPOTENCY_TOMBSTONE_TTL_MS
      )
      .run();
    const row = await getRow(db, input.scope, idempotencyKeyHash);
    if (!row) return { kind: "capacity" };
    if (row.claim_token === claimToken) {
      return {
        kind: "claimed",
        claim: {
          ...input.scope,
          idempotencyKeyHash,
          requestHash,
          requestId,
          claimToken,
        },
      };
    }
    return existingResult(db, row, input.scope, requestHash, claimToken, nowMs);
  } catch (error) {
    if (isCapacityError(error)) return { kind: "capacity" };
    throw error;
  }
}

/** Store a bounded response while retaining the compact key tombstone through its 30-day window. */
export async function completeCloudInferenceIdempotency(
  db: CloudDb,
  claim: CloudInferenceIdempotencyClaim,
  input: { status: number; body: string },
  nowMs = Date.now()
): Promise<CompleteCloudInferenceIdempotencyResult> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid idempotency clock value");
  if (
    !Number.isInteger(input.status) ||
    input.status < 200 ||
    input.status > 599 ||
    typeof input.body !== "string"
  ) {
    await markCloudInferenceOutcomeUnavailable(db, claim, nowMs);
    return { kind: "outcome_unavailable" };
  }
  if (
    new TextEncoder().encode(input.body).byteLength > CLOUD_INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES
  ) {
    await markCloudInferenceOutcomeUnavailable(db, claim, nowMs);
    return { kind: "outcome_unavailable" };
  }

  const result = await db
    .prepare(
      `UPDATE cloud_inference_idempotency
          SET state = 'completed', claim_token = NULL, claim_expires_at_ms = NULL,
              response_status = ?, response_body = ?, response_expires_at_ms = ?, updated_at_ms = ?
        WHERE tenant_id = ? AND principal_id = ? AND api_key_id = ?
          AND idempotency_key_hash = ? AND request_hash = ?
          AND state = 'claimed' AND claim_token = ? AND claim_expires_at_ms > ?
          AND response_expires_at_ms > ?`
    )
    .bind(
      input.status,
      input.body,
      nowMs + CLOUD_INFERENCE_IDEMPOTENCY_RESPONSE_TTL_MS,
      nowMs,
      claim.tenantId,
      claim.principalId,
      claim.apiKeyId,
      claim.idempotencyKeyHash,
      claim.requestHash,
      claim.claimToken,
      nowMs,
      nowMs
    )
    .run();
  if (Number(result.meta?.changes ?? 0) === 1) return { kind: "completed" };
  const existing = await getRow(db, claim, claim.idempotencyKeyHash);
  if (
    existing?.state === "claimed" &&
    existing.claim_expires_at_ms !== null &&
    existing.claim_expires_at_ms <= nowMs
  ) {
    await makeOutcomeUnavailable(db, existing, nowMs);
    return { kind: "outcome_unavailable" };
  }
  if (existing?.state === "outcome_unavailable") return { kind: "outcome_unavailable" };
  return { kind: "not_claim_owner" };
}

/**
 * Closes an uncertain claim after upstream dispatch or response serialization
 * failure. The tombstone blocks redispatch through its 30-day retention window.
 */
export async function markCloudInferenceOutcomeUnavailable(
  db: CloudDb,
  claim: CloudInferenceIdempotencyClaim,
  nowMs = Date.now()
): Promise<boolean> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid idempotency clock value");
  const result = await db
    .prepare(
      `UPDATE cloud_inference_idempotency
          SET state = 'outcome_unavailable', claim_token = NULL, claim_expires_at_ms = NULL,
              response_status = NULL, response_body = NULL, updated_at_ms = ?
        WHERE tenant_id = ? AND principal_id = ? AND api_key_id = ?
          AND idempotency_key_hash = ? AND request_hash = ?
          AND state = 'claimed' AND claim_token = ?`
    )
    .bind(
      nowMs,
      claim.tenantId,
      claim.principalId,
      claim.apiKeyId,
      claim.idempotencyKeyHash,
      claim.requestHash,
      claim.claimToken
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/**
 * Clear expired response bodies and delete tombstones after the documented
 * 30-day retention window. The combined work per invocation stays bounded.
 */
export async function cleanupExpiredCloudInferenceResponses(
  db: CloudDb,
  options: { nowMs?: number; batchSize?: number } = {}
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid idempotency clock value");
  const requestedBatchSize = options.batchSize ?? CLOUD_INFERENCE_IDEMPOTENCY_CLEANUP_BATCH_SIZE;
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.max(1, Math.min(MAX_CLEANUP_BATCH_SIZE, Math.floor(requestedBatchSize)))
    : CLOUD_INFERENCE_IDEMPOTENCY_CLEANUP_BATCH_SIZE;
  const tombstones = await db
    .prepare(
      `DELETE FROM cloud_inference_idempotency
        WHERE (tenant_id, principal_id, api_key_id, idempotency_key_hash) IN (
          SELECT tenant_id, principal_id, api_key_id, idempotency_key_hash
            FROM cloud_inference_idempotency
           WHERE tombstone_expires_at_ms <= ?
           ORDER BY tombstone_expires_at_ms, tenant_id, principal_id, api_key_id, idempotency_key_hash
           LIMIT ?
        )`
    )
    .bind(nowMs, batchSize)
    .run();
  const deletedCount = Number(tombstones.meta?.changes ?? 0);
  const remainingBatchSize = batchSize - deletedCount;
  if (remainingBatchSize === 0) return deletedCount;

  const responses = await db
    .prepare(
      `UPDATE cloud_inference_idempotency
          SET state = 'outcome_unavailable', claim_token = NULL, claim_expires_at_ms = NULL,
              response_status = NULL, response_body = NULL, updated_at_ms = ?
        WHERE (tenant_id, principal_id, api_key_id, idempotency_key_hash) IN (
          SELECT tenant_id, principal_id, api_key_id, idempotency_key_hash
            FROM cloud_inference_idempotency
           WHERE (state = 'completed' AND response_body IS NOT NULL AND response_expires_at_ms <= ?)
              OR (state = 'claimed' AND claim_expires_at_ms <= ?)
           ORDER BY CASE WHEN state = 'completed' THEN response_expires_at_ms ELSE claim_expires_at_ms END,
                    tenant_id, principal_id, api_key_id, idempotency_key_hash
           LIMIT ?
        )`
    )
    .bind(nowMs, nowMs, nowMs, remainingBatchSize)
    .run();
  return deletedCount + Number(responses.meta?.changes ?? 0);
}
