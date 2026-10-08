import type { CloudDb } from "./db";

export type CloudCustomerRole = "owner" | "admin" | "member" | "viewer";

export interface CloudCustomerIdentity {
  tenantId: string;
  principalId: string;
  role: CloudCustomerRole;
  membershipId: string;
  apiKeyId: string;
}

export interface IssuedCloudCustomerApiKey {
  id: string;
  tenantId: string;
  membershipId: string;
  /** Returned only by issuance. Persist only keyHash. */
  token: string;
  createdAt: string;
  expiresAt: string | null;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ROLE_SET = new Set<CloudCustomerRole>(["owner", "admin", "member", "viewer"]);
const TOKEN_PREFIX = "orc_live_";

function requireId(value: string, field: string): string {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${field} must be a 1–128 character identifier`);
  return value;
}

function requireRole(role: string): CloudCustomerRole {
  if (!ROLE_SET.has(role as CloudCustomerRole)) throw new TypeError("Invalid customer role");
  return role as CloudCustomerRole;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${TOKEN_PREFIX}${base64Url(bytes)}`;
}

/** Create a customer membership. Call only after platform-admin authorization. */
export async function createCloudCustomerMembership(
  db: CloudDb,
  input: { tenantId: string; principalId: string; role: CloudCustomerRole; now?: string }
): Promise<{ id: string; tenantId: string; principalId: string; role: CloudCustomerRole }> {
  requireId(input.tenantId, "tenantId");
  requireId(input.principalId, "principalId");
  const role = requireRole(input.role);
  const now = input.now ?? new Date().toISOString();
  const tenant = await db
    .prepare<{ id: string; kind: string; is_active: number }>(
      "SELECT id, kind, is_active FROM tenants WHERE id = ? LIMIT 1"
    )
    .bind(input.tenantId)
    .first();
  if (!tenant || tenant.kind !== "customer" || tenant.is_active !== 1) {
    throw new TypeError("Customer tenant is unavailable");
  }
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO cloud_customer_memberships
         (id, tenant_id, principal_id, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(id, input.tenantId, input.principalId, role, now, now)
    .run();
  if (
    !result.success ||
    (result.meta?.changes !== undefined && Number(result.meta.changes) !== 1)
  ) {
    throw new Error("Customer membership could not be created");
  }
  return { id, tenantId: input.tenantId, principalId: input.principalId, role };
}

/** Issue a random tenant-bound key. The raw token is returned once and is never stored. */
export async function issueCloudCustomerApiKey(
  db: CloudDb,
  input: { tenantId: string; membershipId: string; expiresAt?: string | null; now?: string }
): Promise<IssuedCloudCustomerApiKey> {
  requireId(input.tenantId, "tenantId");
  requireId(input.membershipId, "membershipId");
  const now = input.now ?? new Date().toISOString();
  const requestedExpiry = input.expiresAt ?? null;
  const expiryMs = requestedExpiry === null ? null : Date.parse(requestedExpiry);
  if (expiryMs !== null && (!Number.isFinite(expiryMs) || expiryMs <= Date.parse(now))) {
    throw new TypeError("expiresAt must be a future timestamp");
  }
  // Store a normalized UTC timestamp because auth compares timestamps in D1.
  const expiresAt = expiryMs === null ? null : new Date(expiryMs).toISOString();
  const membership = await db
    .prepare<{ id: string }>(
      `SELECT m.id
         FROM cloud_customer_memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.tenant_id = ? AND m.id = ? AND m.is_active = 1
          AND t.kind = 'customer' AND t.is_active = 1
        LIMIT 1`
    )
    .bind(input.tenantId, input.membershipId)
    .first();
  if (!membership) throw new TypeError("Customer membership is unavailable");

  const token = createToken();
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO cloud_customer_api_keys
         (id, tenant_id, membership_id, key_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, input.tenantId, input.membershipId, await hashToken(token), now, expiresAt)
    .run();
  if (
    !result.success ||
    (result.meta?.changes !== undefined && Number(result.meta.changes) !== 1)
  ) {
    throw new Error("Customer API key could not be issued");
  }
  return {
    id,
    tenantId: input.tenantId,
    membershipId: input.membershipId,
    token,
    createdAt: now,
    expiresAt,
  };
}

/** Revoke one key within the explicitly selected tenant. Call only after platform-admin authorization. */
export async function revokeCloudCustomerApiKey(
  db: CloudDb,
  input: { tenantId: string; apiKeyId: string; now?: string }
): Promise<boolean> {
  requireId(input.tenantId, "tenantId");
  requireId(input.apiKeyId, "apiKeyId");
  const result = await db
    .prepare(
      `UPDATE cloud_customer_api_keys SET revoked_at = ?
        WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`
    )
    .bind(input.now ?? new Date().toISOString(), input.tenantId, input.apiKeyId)
    .run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}

/** Resolve a bearer secret to authoritative D1 membership identity; callers supply no tenant ID. */
export async function authenticateCloudCustomerApiKey(
  db: CloudDb,
  token: string,
  now = new Date().toISOString()
): Promise<CloudCustomerIdentity | null> {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > 128)
    return null;
  const keyHash = await hashToken(token);
  const row = await db
    .prepare<{
      api_key_id: string;
      tenant_id: string;
      membership_id: string;
      principal_id: string;
      role: string;
    }>(
      `SELECT k.id AS api_key_id, k.tenant_id, k.membership_id, m.principal_id, m.role
         FROM cloud_customer_api_keys k
         JOIN cloud_customer_memberships m
           ON m.tenant_id = k.tenant_id AND m.id = k.membership_id
         JOIN tenants t ON t.id = k.tenant_id
        WHERE k.key_hash = ? AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > ?)
          AND m.is_active = 1 AND t.is_active = 1 AND t.kind = 'customer'
        LIMIT 1`
    )
    .bind(keyHash, now)
    .first();
  if (!row || !ROLE_SET.has(row.role as CloudCustomerRole)) return null;
  return {
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    role: row.role as CloudCustomerRole,
    membershipId: row.membership_id,
    apiKeyId: row.api_key_id,
  };
}
