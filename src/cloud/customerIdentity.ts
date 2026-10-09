import type { CloudDb } from "./db";
import {
  prepareCloudComplianceAuditInsert,
  type CloudComplianceAuditInput,
} from "./complianceAudit";

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

export interface CloudCustomerApiKeyPortalAuthorization {
  sessionTokenHash: string;
  nowMs: number;
}

export class CloudCustomerApiKeyPortalAuthorizationError extends Error {
  constructor() {
    super("Customer API key portal authorization is no longer valid");
    this.name = "CloudCustomerApiKeyPortalAuthorizationError";
  }
}

export interface CloudCustomerMembership {
  id: string;
  tenantId: string;
  principalId: string;
  role: CloudCustomerRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export class CloudLastActiveOwnerError extends Error {
  constructor() {
    super("A customer tenant must keep at least one active owner");
    this.name = "CloudLastActiveOwnerError";
  }
}

export class CloudMembershipConflictError extends Error {
  constructor() {
    super("Customer membership changed during update");
    this.name = "CloudMembershipConflictError";
  }
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

/** Read one membership within its tenant partition. */
export async function getCloudCustomerMembership(
  db: CloudDb,
  tenantId: string,
  membershipId: string
): Promise<CloudCustomerMembership | null> {
  const row = await db
    .prepare<{
      id: string;
      tenant_id: string;
      principal_id: string;
      role: CloudCustomerRole;
      is_active: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, tenant_id, principal_id, role, is_active, created_at, updated_at
         FROM cloud_customer_memberships
        WHERE tenant_id = ? AND id = ? LIMIT 1`
    )
    .bind(tenantId, membershipId)
    .first();
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    role: row.role,
    isActive: row.is_active !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Update a tenant membership and permanently revoke its API keys when deactivated. */
export async function updateCloudCustomerMembership(
  db: CloudDb,
  input: {
    tenantId: string;
    membershipId: string;
    role: CloudCustomerRole;
    isActive: boolean;
    expectedUpdatedAt?: string;
    actorMembershipId?: string;
    audit?: CloudComplianceAuditInput;
    now?: string;
  }
): Promise<CloudCustomerMembership | null> {
  requireId(input.tenantId, "tenantId");
  requireId(input.membershipId, "membershipId");
  const role = requireRole(input.role);
  const now = input.now ?? new Date().toISOString();
  if (
    input.expectedUpdatedAt !== undefined &&
    (!Number.isFinite(Date.parse(input.expectedUpdatedAt)) ||
      new Date(input.expectedUpdatedAt).toISOString() !== input.expectedUpdatedAt)
  ) {
    throw new TypeError("Invalid expectedUpdatedAt");
  }
  if (input.actorMembershipId !== undefined) {
    requireId(input.actorMembershipId, "actorMembershipId");
  }
  const updateMembership = db
    .prepare(
      `UPDATE cloud_customer_memberships
          SET role = ?, is_active = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?
          AND (? IS NULL OR updated_at = ?)
          AND (
            ? IS NULL OR EXISTS (
              SELECT 1 FROM cloud_customer_memberships actor
               WHERE actor.tenant_id = ? AND actor.id = ? AND actor.is_active = 1
                 AND actor.role IN ('owner', 'admin')
                 AND (actor.role = 'owner' OR cloud_customer_memberships.role <> 'owner')
            )
          )
          AND (
            role <> 'owner' OR is_active = 0 OR (? = 'owner' AND ? = 1)
            OR EXISTS (
              SELECT 1 FROM cloud_customer_memberships other
               WHERE other.tenant_id = ? AND other.id <> ?
                 AND other.role = 'owner' AND other.is_active = 1
            )
          )`
    )
    .bind(
      role,
      input.isActive ? 1 : 0,
      now,
      input.tenantId,
      input.membershipId,
      input.expectedUpdatedAt ?? null,
      input.expectedUpdatedAt ?? null,
      input.actorMembershipId ?? null,
      input.tenantId,
      input.actorMembershipId ?? null,
      role,
      input.isActive ? 1 : 0,
      input.tenantId,
      input.membershipId
    );
  const statements = [updateMembership];
  if (input.audit) {
    statements.push(
      prepareCloudComplianceAuditInsert(db, input.audit, {
        requirePreviousStatementChange: true,
      }).statement
    );
  }
  if (!input.isActive) {
    statements.push(
      db
        .prepare(
          `UPDATE cloud_customer_api_keys SET revoked_at = ?
            WHERE tenant_id = ? AND membership_id = ? AND revoked_at IS NULL
              AND changes() = 1
              AND EXISTS (
                SELECT 1 FROM cloud_customer_memberships
                 WHERE tenant_id = ? AND id = ? AND is_active = 0 AND updated_at = ?
              )`
        )
        .bind(now, input.tenantId, input.membershipId, input.tenantId, input.membershipId, now)
    );
  }
  const results = await db.batch(statements);
  const updateChanges =
    typeof results[0] === "object" && results[0] !== null && "meta" in results[0]
      ? Number((results[0] as { meta?: { changes?: unknown } }).meta?.changes)
      : Number.NaN;
  if (input.expectedUpdatedAt !== undefined && updateChanges !== 1) {
    const unchangedOwner = await getCloudCustomerMembership(db, input.tenantId, input.membershipId);
    const actor = input.actorMembershipId
      ? await db
          .prepare<{ role: CloudCustomerRole; is_active: number }>(
            `SELECT role, is_active FROM cloud_customer_memberships
              WHERE tenant_id = ? AND id = ? LIMIT 1`
          )
          .bind(input.tenantId, input.actorMembershipId)
          .first()
      : null;
    const actorMayChangeOwner =
      input.actorMembershipId === undefined || (actor?.role === "owner" && actor.is_active === 1);
    if (
      unchangedOwner?.updatedAt === input.expectedUpdatedAt &&
      unchangedOwner.role === "owner" &&
      unchangedOwner.isActive &&
      actorMayChangeOwner &&
      (role !== "owner" || !input.isActive)
    ) {
      const otherActiveOwner = await db
        .prepare<{ count: number }>(
          `SELECT COUNT(*) AS count FROM cloud_customer_memberships
            WHERE tenant_id = ? AND id <> ? AND role = 'owner' AND is_active = 1`
        )
        .bind(input.tenantId, input.membershipId)
        .first();
      if (Number(otherActiveOwner?.count ?? 0) === 0) throw new CloudLastActiveOwnerError();
    }
    throw new CloudMembershipConflictError();
  }
  if (
    results.some(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        "success" in result &&
        result.success === false
    )
  ) {
    throw new Error("Customer membership could not be updated");
  }
  const updated = await getCloudCustomerMembership(db, input.tenantId, input.membershipId);
  if (!updated) return null;
  if (updated.role !== role || updated.isActive !== input.isActive) {
    if (updated.role === "owner" && updated.isActive) throw new CloudLastActiveOwnerError();
    throw new Error("Customer membership could not be updated");
  }
  return updated;
}

/** Issue a random tenant-bound key. The raw token is returned once and is never stored. */
export async function issueCloudCustomerApiKey(
  db: CloudDb,
  input: {
    tenantId: string;
    membershipId: string;
    expiresAt?: string | null;
    portalAuthorization?: CloudCustomerApiKeyPortalAuthorization;
    audit?: CloudComplianceAuditInput;
    now?: string;
  }
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
  const insert = input.portalAuthorization
    ? db
        .prepare(
          `INSERT INTO cloud_customer_api_keys
             (id, tenant_id, membership_id, key_hash, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1
                FROM cloud_tenant_oidc_sessions AS session
                JOIN tenants AS tenant ON tenant.id = session.tenant_id
                  AND tenant.kind = 'customer' AND tenant.is_active = 1
                JOIN cloud_customer_memberships AS membership
                  ON membership.tenant_id = session.tenant_id
                 AND membership.id = session.membership_id
                 AND membership.is_active = 1 AND membership.role IN ('owner', 'admin')
                JOIN cloud_tenant_oidc_identities AS identity
                  ON identity.tenant_id = session.tenant_id
                 AND identity.id = session.identity_id
                 AND identity.membership_id = session.membership_id
                JOIN cloud_tenant_oidc_configs AS config
                  ON config.tenant_id = identity.tenant_id AND config.issuer = identity.issuer
                 AND config.is_enabled = 1
               WHERE session.token_hash = ? AND session.tenant_id = ?
                 AND session.membership_id = ? AND session.revoked_at_ms IS NULL
                 AND session.expires_at_ms > ?
            )`
        )
        .bind(
          id,
          input.tenantId,
          input.membershipId,
          await hashToken(token),
          now,
          expiresAt,
          input.portalAuthorization.sessionTokenHash,
          input.tenantId,
          input.membershipId,
          input.portalAuthorization.nowMs
        )
    : db
        .prepare(
          `INSERT INTO cloud_customer_api_keys
             (id, tenant_id, membership_id, key_hash, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(id, input.tenantId, input.membershipId, await hashToken(token), now, expiresAt);
  const results = input.audit
    ? await db.batch([
        insert,
        prepareCloudComplianceAuditInsert(db, input.audit, {
          requirePreviousStatementChange: true,
        }).statement,
      ])
    : [await insert.run()];
  if (
    results.some(
      (result) =>
        !result || typeof result !== "object" || !("success" in result) || result.success === false
    )
  ) {
    throw new Error("Customer API key could not be issued");
  }
  const insertResult = results[0] as { meta?: { changes?: unknown } };
  if (
    (input.portalAuthorization && Number(insertResult.meta?.changes) !== 1) ||
    (insertResult.meta?.changes !== undefined && Number(insertResult.meta.changes) !== 1)
  ) {
    if (input.portalAuthorization && Number(insertResult.meta?.changes) !== 1) {
      throw new CloudCustomerApiKeyPortalAuthorizationError();
    }
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
  input: {
    tenantId: string;
    apiKeyId: string;
    membershipId?: string;
    portalAuthorization?: CloudCustomerApiKeyPortalAuthorization;
    audit?: CloudComplianceAuditInput;
    now?: string;
  }
): Promise<boolean> {
  requireId(input.tenantId, "tenantId");
  requireId(input.apiKeyId, "apiKeyId");
  if (input.membershipId !== undefined) requireId(input.membershipId, "membershipId");
  const update = input.portalAuthorization
    ? db
        .prepare(
          `UPDATE cloud_customer_api_keys SET revoked_at = ?
            WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL
              AND (? IS NULL OR membership_id = ?)
              AND EXISTS (
                SELECT 1
                  FROM cloud_tenant_oidc_sessions AS session
                  JOIN tenants AS tenant ON tenant.id = session.tenant_id
                    AND tenant.kind = 'customer' AND tenant.is_active = 1
                  JOIN cloud_customer_memberships AS membership
                    ON membership.tenant_id = session.tenant_id
                   AND membership.id = session.membership_id
                   AND membership.is_active = 1 AND membership.role IN ('owner', 'admin')
                  JOIN cloud_tenant_oidc_identities AS identity
                    ON identity.tenant_id = session.tenant_id
                   AND identity.id = session.identity_id
                   AND identity.membership_id = session.membership_id
                  JOIN cloud_tenant_oidc_configs AS config
                    ON config.tenant_id = identity.tenant_id AND config.issuer = identity.issuer
                   AND config.is_enabled = 1
                 WHERE session.token_hash = ? AND session.tenant_id = ?
                   AND session.membership_id = ? AND session.revoked_at_ms IS NULL
                   AND session.expires_at_ms > ?
              )`
        )
        .bind(
          input.now ?? new Date().toISOString(),
          input.tenantId,
          input.apiKeyId,
          input.membershipId ?? null,
          input.membershipId ?? null,
          input.portalAuthorization.sessionTokenHash,
          input.tenantId,
          input.membershipId,
          input.portalAuthorization.nowMs
        )
    : db
        .prepare(
          `UPDATE cloud_customer_api_keys SET revoked_at = ?
            WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL
              AND (? IS NULL OR membership_id = ?)`
        )
        .bind(
          input.now ?? new Date().toISOString(),
          input.tenantId,
          input.apiKeyId,
          input.membershipId ?? null,
          input.membershipId ?? null
        );
  const results = input.audit
    ? await db.batch([
        update,
        prepareCloudComplianceAuditInsert(db, input.audit, {
          requirePreviousStatementChange: true,
        }).statement,
      ])
    : [await update.run()];
  const result = results[0] as { success?: boolean; meta?: { changes?: unknown } } | undefined;
  return (
    result?.success === true &&
    (result.meta?.changes === undefined || Number(result.meta.changes) === 1) &&
    results.every(
      (entry) =>
        !!entry && typeof entry === "object" && "success" in entry && entry.success !== false
    )
  );
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
