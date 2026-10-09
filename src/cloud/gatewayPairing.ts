import type { CloudDb } from "./db";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface IssuedGatewayPairing {
  id: string;
  code: string;
  codeHash: string;
  expiresAt: string;
}

export interface ConsumedGatewayPairing {
  tenantId: string;
  deviceId: string;
  credential: string;
  codeHash: string;
  issuedBy: string;
  apiKeyId: string;
}

function requireId(value: string, field: string): string {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${field} must be a valid identifier`);
  return value;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hashGatewayPairingCode(code: string): Promise<string> {
  return sha256(code);
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function successfulChanges(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const row = result as { success?: unknown; meta?: { changes?: unknown } };
  return row.success === true && Number(row.meta?.changes ?? 0) === 1;
}

/** Issue a five-minute code; only its SHA-256 digest is persisted. */
export async function issueCloudGatewayPairing(
  db: CloudDb,
  input: {
    tenantId: string;
    membershipId: string;
    apiKeyId: string;
    issuedBy: string;
    now?: string;
  }
): Promise<IssuedGatewayPairing> {
  requireId(input.tenantId, "tenantId");
  requireId(input.membershipId, "membershipId");
  requireId(input.apiKeyId, "apiKeyId");
  requireId(input.issuedBy, "issuedBy");
  const now = new Date(input.now ?? new Date().toISOString());
  if (!Number.isFinite(now.getTime())) throw new TypeError("Invalid pairing issue time");
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const id = crypto.randomUUID();
  const code = randomToken();
  const codeHash = await sha256(code);
  const result = await db
    .prepare(
      `INSERT INTO cloud_gateway_pairings
         (id, tenant_id, membership_id, api_key_id, issued_by, code_hash, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM cloud_customer_memberships m
          JOIN cloud_customer_api_keys k
            ON k.tenant_id = m.tenant_id AND k.membership_id = m.id
          JOIN tenants t ON t.id = m.tenant_id
          JOIN cloud_tenant_settings s ON s.tenant_id = t.id
          WHERE m.tenant_id = ? AND m.id = ? AND m.principal_id = ?
            AND m.is_active = 1 AND m.role IN ('owner', 'admin')
            AND k.id = ? AND k.revoked_at IS NULL
            AND (k.expires_at IS NULL OR k.expires_at > ?)
            AND t.kind = 'customer' AND t.is_active = 1
            AND s.local_ai_enabled = 1
        )`
    )
    .bind(
      id,
      input.tenantId,
      input.membershipId,
      input.apiKeyId,
      input.issuedBy,
      codeHash,
      expiresAt,
      createdAt,
      input.tenantId,
      input.membershipId,
      input.issuedBy,
      input.apiKeyId,
      createdAt
    )
    .run();
  if (!successfulChanges(result))
    throw new TypeError("Pairing is not permitted for this customer key");
  return { id, code, codeHash, expiresAt };
}

/** Consume a pairing grant and create its device in one atomic D1 batch. */
export async function consumeCloudGatewayPairing(
  db: CloudDb,
  input: { code: string; now?: string }
): Promise<ConsumedGatewayPairing | null> {
  if (typeof input.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.code)) return null;
  const now = new Date(input.now ?? new Date().toISOString());
  if (!Number.isFinite(now.getTime())) throw new TypeError("Invalid pairing exchange time");
  const timestamp = now.toISOString();
  const codeHash = await sha256(input.code);
  // Read return metadata before the atomic consume/create/audit batch. If this
  // read fails, no device is created and its one-time credential cannot be lost.
  const pairing = await db
    .prepare<{ tenant_id: string; issued_by: string; api_key_id: string }>(
      `SELECT tenant_id, issued_by, api_key_id FROM cloud_gateway_pairings
        WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM cloud_tenant_settings s
            JOIN tenants t ON t.id = s.tenant_id
            WHERE s.tenant_id = cloud_gateway_pairings.tenant_id
              AND s.local_ai_enabled = 1 AND t.kind = 'customer' AND t.is_active = 1
          )
        LIMIT 1`
    )
    .bind(codeHash, timestamp)
    .first();
  if (!pairing) return null;
  const consumeNonce = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const credential = randomToken();
  const credentialHash = await sha256(credential);
  if (!HASH_PATTERN.test(credentialHash))
    throw new Error("Invalid generated device credential hash");
  const auditId = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE cloud_gateway_pairings
            SET consumed_at = ?, consumed_nonce = ?
          WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
            AND EXISTS (
              SELECT 1 FROM cloud_customer_memberships m
              JOIN cloud_customer_api_keys k
                ON k.tenant_id = m.tenant_id AND k.membership_id = m.id
              JOIN tenants t ON t.id = m.tenant_id
              JOIN cloud_tenant_settings s ON s.tenant_id = t.id
              WHERE m.tenant_id = cloud_gateway_pairings.tenant_id
                AND m.id = cloud_gateway_pairings.membership_id
                AND m.principal_id = cloud_gateway_pairings.issued_by
                AND m.is_active = 1 AND m.role IN ('owner', 'admin')
                AND k.id = cloud_gateway_pairings.api_key_id AND k.revoked_at IS NULL
                AND (k.expires_at IS NULL OR k.expires_at > ?)
                AND t.kind = 'customer' AND t.is_active = 1
                AND s.local_ai_enabled = 1
            )`
      )
      .bind(timestamp, consumeNonce, codeHash, timestamp, timestamp),
    db
      .prepare(
        `INSERT INTO cloud_gateway_devices
           (id, tenant_id, credential_hash, capabilities_json, created_at)
         SELECT ?, tenant_id, ?, '[]', ? FROM cloud_gateway_pairings
          WHERE code_hash = ? AND consumed_nonce = ? AND consumed_at = ?`
      )
      .bind(deviceId, credentialHash, timestamp, codeHash, consumeNonce, timestamp),
    db
      .prepare(
        `INSERT INTO cloud_compliance_audit
           (id, tenant_id, timestamp, action, actor, target, resource_type, status, metadata_json)
         SELECT ?, tenant_id, ?, 'gateway.device.pair.exchange', issued_by, ?,
                'gateway-device-pairing', 'success', ?
           FROM cloud_gateway_pairings
          WHERE code_hash = ? AND consumed_nonce = ? AND consumed_at = ?
            AND EXISTS (SELECT 1 FROM cloud_gateway_devices WHERE id = ? AND tenant_id = cloud_gateway_pairings.tenant_id)`
      )
      .bind(
        auditId,
        timestamp,
        codeHash,
        JSON.stringify({ pairingHash: codeHash }),
        codeHash,
        consumeNonce,
        timestamp,
        deviceId
      ),
  ]);
  if (!successfulChanges(results[1]) || !successfulChanges(results[2])) return null;
  return {
    tenantId: pairing.tenant_id,
    deviceId,
    credential,
    codeHash,
    issuedBy: pairing.issued_by,
    apiKeyId: pairing.api_key_id,
  };
}

export async function deleteCloudGatewayPairing(db: CloudDb, id: string): Promise<void> {
  if (!ID_PATTERN.test(id)) throw new TypeError("Invalid pairing ID");
  await db
    .prepare("DELETE FROM cloud_gateway_pairings WHERE id = ? AND consumed_at IS NULL")
    .bind(id)
    .run();
}

/** Reclaim expired pairing grants in one bounded batch during the Worker schedule. */
export async function cleanupExpiredCloudGatewayPairings(
  db: CloudDb,
  options: { now?: string; batchSize?: number } = {}
): Promise<number> {
  const timestamp = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError("Invalid pairing cleanup time");
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new RangeError("pairing cleanup batchSize must be between 1 and 1000");
  }
  const result = await db
    .prepare(
      `DELETE FROM cloud_gateway_pairings
        WHERE id IN (
          SELECT id FROM cloud_gateway_pairings
           WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?
        )`
    )
    .bind(new Date(timestamp).toISOString(), batchSize)
    .run();
  const changes = Number(result.meta?.changes ?? 0);
  if (!result.success || !Number.isSafeInteger(changes) || changes < 0 || changes > batchSize) {
    throw new Error("D1 pairing cleanup returned invalid state");
  }
  return changes;
}
