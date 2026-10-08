import type { CloudDb } from "./db";

export const GATEWAY_IDEMPOTENCY_WINDOW_MS = 10 * 60_000;
export const GATEWAY_IDEMPOTENCY_LEASE_MS = 60_000;
export const GATEWAY_IDEMPOTENCY_MAX_RESPONSE_BYTES = 128 * 1024;

const KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

export interface GatewayIdempotencyScope {
  tenantId: string;
  principalId: string;
  apiKeyId: string;
}

export interface GatewayIdempotencyClaim {
  keyHash: string;
  tenantId: string;
  principalId: string;
  apiKeyId: string;
  fingerprintHash: string;
  requestId: string;
  state: "pending" | "completed";
  rateLimitChecked: boolean;
  attemptAudited: boolean;
  createdAt: string;
  expiresAt: string;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  responseStatus: number | null;
  responseJson: string | null;
}

interface IdempotencyRow {
  key_hash: string;
  tenant_id: string;
  principal_id: string;
  api_key_id: string;
  fingerprint_hash: string;
  request_id: string;
  state: "pending" | "completed";
  rate_limit_checked: number;
  attempt_audited: number;
  created_at: string;
  expires_at: string;
  claim_token: string | null;
  lease_expires_at: string | null;
  response_status: number | null;
  response_json: string | null;
}

export type GatewayIdempotencyClaimResult =
  | { kind: "claimed"; claim: GatewayIdempotencyClaim }
  | { kind: "in_progress"; claim: GatewayIdempotencyClaim }
  | { kind: "replay"; claim: GatewayIdempotencyClaim; response: unknown; status: number }
  | { kind: "conflict" }
  | { kind: "capacity" };

function mapRow(row: IdempotencyRow): GatewayIdempotencyClaim {
  return {
    keyHash: row.key_hash,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    apiKeyId: row.api_key_id,
    fingerprintHash: row.fingerprint_hash,
    requestId: row.request_id,
    state: row.state,
    rateLimitChecked: row.rate_limit_checked === 1,
    attemptAudited: row.attempt_audited === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    claimToken: row.claim_token,
    leaseExpiresAt: row.lease_expires_at,
    responseStatus: row.response_status,
    responseJson: row.response_json,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function isCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("gateway idempotency") && message.includes("capacity");
}

async function getByHash(db: CloudDb, keyHash: string): Promise<GatewayIdempotencyClaim | null> {
  const row = await db
    .prepare<IdempotencyRow>("SELECT * FROM cloud_gateway_idempotency WHERE key_hash = ? LIMIT 1")
    .bind(keyHash)
    .first();
  return row ? mapRow(row) : null;
}

async function resultForExisting(
  db: CloudDb,
  keyHash: string,
  fingerprintHash: string,
  scope: GatewayIdempotencyScope,
  claimToken: string
): Promise<GatewayIdempotencyClaimResult> {
  const claim = await getByHash(db, keyHash);
  if (!claim) return { kind: "capacity" };
  if (
    claim.tenantId !== scope.tenantId ||
    claim.principalId !== scope.principalId ||
    claim.apiKeyId !== scope.apiKeyId ||
    claim.fingerprintHash !== fingerprintHash
  ) {
    return { kind: "conflict" };
  }
  if (claim.state === "completed" && claim.responseJson !== null && claim.responseStatus !== null) {
    try {
      return {
        kind: "replay",
        claim,
        response: JSON.parse(claim.responseJson) as unknown,
        status: claim.responseStatus,
      };
    } catch {
      return { kind: "capacity" };
    }
  }
  if (claim.claimToken === claimToken) return { kind: "claimed", claim };
  return { kind: "in_progress", claim };
}

/** Atomically claims a tenant-global key and takes over only after a bounded lease. */
export async function claimGatewayIdempotency(
  db: CloudDb,
  input: {
    key: string;
    scope: GatewayIdempotencyScope;
    operation: { deviceId: string; capability: string; payload: unknown };
    requestId: string;
    claimToken: string;
    nowMs: number;
  }
): Promise<GatewayIdempotencyClaimResult> {
  if (!KEY_PATTERN.test(input.key)) return { kind: "conflict" };
  const createdAt = new Date(input.nowMs).toISOString();
  const expiresAt = new Date(input.nowMs + GATEWAY_IDEMPOTENCY_WINDOW_MS).toISOString();
  const leaseExpiresAt = new Date(input.nowMs + GATEWAY_IDEMPOTENCY_LEASE_MS).toISOString();
  // Tenant-scoped hashing keeps one tenant's client key from colliding with or blocking another.
  // The raw key remains transient and is never persisted.
  const keyHash = await sha256(JSON.stringify([input.scope.tenantId, input.key]));
  const fingerprintHash = await sha256(
    canonicalJson({
      tenantId: input.scope.tenantId,
      principalId: input.scope.principalId,
      apiKeyId: input.scope.apiKeyId,
      deviceId: input.operation.deviceId,
      capability: input.operation.capability,
      payload: input.operation.payload,
    })
  );

  try {
    await db
      .prepare("DELETE FROM cloud_gateway_idempotency WHERE expires_at <= ?")
      .bind(createdAt)
      .run();
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO cloud_gateway_idempotency (
           key_hash, tenant_id, principal_id, api_key_id, fingerprint_hash, request_id,
           state, created_at, expires_at, claim_token, lease_expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
      )
      .bind(
        keyHash,
        input.scope.tenantId,
        input.scope.principalId,
        input.scope.apiKeyId,
        fingerprintHash,
        input.requestId,
        createdAt,
        expiresAt,
        input.claimToken,
        leaseExpiresAt
      )
      .run();
    const changes = Number(inserted.meta?.changes ?? 0);
    if (changes === 1) {
      const claim = await getByHash(db, keyHash);
      if (claim) return { kind: "claimed", claim };
    }

    const existing = await getByHash(db, keyHash);
    if (!existing) return { kind: "capacity" };
    if (
      existing.tenantId !== input.scope.tenantId ||
      existing.principalId !== input.scope.principalId ||
      existing.apiKeyId !== input.scope.apiKeyId ||
      existing.fingerprintHash !== fingerprintHash
    ) {
      return { kind: "conflict" };
    }
    if (existing.state === "completed") {
      if (existing.responseJson === null || existing.responseStatus === null) {
        return { kind: "capacity" };
      }
      try {
        return {
          kind: "replay",
          claim: existing,
          response: JSON.parse(existing.responseJson) as unknown,
          status: existing.responseStatus,
        };
      } catch {
        return { kind: "capacity" };
      }
    }
    if (existing.leaseExpiresAt && existing.leaseExpiresAt > createdAt) {
      return { kind: "in_progress", claim: existing };
    }

    const takeover = await db
      .prepare(
        `UPDATE cloud_gateway_idempotency
            SET claim_token = ?, lease_expires_at = ?
          WHERE key_hash = ? AND state = 'pending' AND expires_at > ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
      )
      .bind(input.claimToken, leaseExpiresAt, keyHash, createdAt, createdAt)
      .run();
    if (Number(takeover.meta?.changes ?? 0) === 1) {
      const claim = await getByHash(db, keyHash);
      if (claim) return { kind: "claimed", claim };
    }
    return resultForExisting(db, keyHash, fingerprintHash, input.scope, input.claimToken);
  } catch (error) {
    if (isCapacityError(error)) return { kind: "capacity" };
    throw error;
  }
}

/** Releases an unfinished operation for a later retry without discarding its stable request ID. */
export async function releaseGatewayIdempotencyClaim(
  db: CloudDb,
  claim: GatewayIdempotencyClaim,
  claimToken: string,
  nowMs: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE cloud_gateway_idempotency SET lease_expires_at = ?
        WHERE key_hash = ? AND tenant_id = ? AND fingerprint_hash = ?
          AND state = 'pending' AND claim_token = ?`
    )
    .bind(
      new Date(nowMs).toISOString(),
      claim.keyHash,
      claim.tenantId,
      claim.fingerprintHash,
      claimToken
    )
    .run();
}

/** Marks a pre-execution check only after it succeeded, so retries can safely resume it. */
export async function markGatewayIdempotencyPreflight(
  db: CloudDb,
  claim: GatewayIdempotencyClaim,
  claimToken: string,
  check: "rate_limit_checked" | "attempt_audited"
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_idempotency SET ${check} = 1
        WHERE key_hash = ? AND tenant_id = ? AND fingerprint_hash = ?
          AND state = 'pending' AND claim_token = ?`
    )
    .bind(claim.keyHash, claim.tenantId, claim.fingerprintHash, claimToken)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/** Stores one bounded JSON response. The claim token is a compare-and-swap owner. */
export async function completeGatewayIdempotency(
  db: CloudDb,
  claim: GatewayIdempotencyClaim,
  claimToken: string,
  response: unknown,
  status: number,
  nowMs: number
): Promise<GatewayIdempotencyClaimResult> {
  if (!Number.isInteger(status) || status < 200 || status > 599) return { kind: "capacity" };
  let responseJson: string;
  try {
    responseJson = JSON.stringify(response);
  } catch {
    return { kind: "capacity" };
  }
  if (
    typeof responseJson !== "string" ||
    new TextEncoder().encode(responseJson).byteLength > GATEWAY_IDEMPOTENCY_MAX_RESPONSE_BYTES
  ) {
    return { kind: "capacity" };
  }

  await db
    .prepare(
      `UPDATE cloud_gateway_idempotency
          SET state = 'completed', claim_token = NULL, lease_expires_at = NULL,
              response_status = ?, response_json = ?
        WHERE key_hash = ? AND tenant_id = ? AND fingerprint_hash = ?
          AND state = 'pending' AND claim_token = ? AND expires_at > ?`
    )
    .bind(
      status,
      responseJson,
      claim.keyHash,
      claim.tenantId,
      claim.fingerprintHash,
      claimToken,
      new Date(nowMs).toISOString()
    )
    .run();
  const stored = await getByHash(db, claim.keyHash);
  if (
    stored?.tenantId === claim.tenantId &&
    stored.fingerprintHash === claim.fingerprintHash &&
    stored.state === "completed" &&
    stored.responseJson !== null &&
    stored.responseStatus !== null
  ) {
    try {
      return {
        kind: "replay",
        claim: stored,
        response: JSON.parse(stored.responseJson) as unknown,
        status: stored.responseStatus,
      };
    } catch {
      return { kind: "capacity" };
    }
  }
  return { kind: "capacity" };
}
