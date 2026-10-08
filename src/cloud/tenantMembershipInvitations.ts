import type { CloudDb } from "./db";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ROLE_PATTERN = /^(admin|member|viewer)$/;
export const CLOUD_TENANT_MEMBERSHIP_INVITATION_TTL_MS = 15 * 60 * 1000;

export interface CloudTenantMembershipInvitation {
  id: string;
  tenantId: string;
  issuer: string;
  role: "admin" | "member" | "viewer";
  expiresAtMs: number;
}

interface InvitationRow {
  id: string;
  tenant_id: string;
  issuer: string;
  role: CloudTenantMembershipInvitation["role"];
  expires_at_ms: number;
}

function validChanges(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const meta = (result as { meta?: unknown }).meta;
  return Boolean(
    meta && typeof meta === "object" && Number((meta as { changes?: unknown }).changes) === 1
  );
}

function requireHash(value: string): string {
  if (!HASH_PATTERN.test(value)) throw new TypeError("Invalid invitation hash");
  return value;
}

/** Create a role-limited invitation and its audit record in one D1 batch. */
export async function createCloudTenantMembershipInvitation(
  db: CloudDb,
  input: {
    id: string;
    codeHash: string;
    tenantId: string;
    issuer: string;
    issuerMembershipId: string;
    role: string;
    nowMs: number;
    expiresAtMs: number;
  }
): Promise<boolean> {
  requireHash(input.codeHash);
  if (
    !ID_PATTERN.test(input.id) ||
    !ID_PATTERN.test(input.tenantId) ||
    !ID_PATTERN.test(input.issuerMembershipId) ||
    !ROLE_PATTERN.test(input.role) ||
    !Number.isSafeInteger(input.nowMs) ||
    !Number.isSafeInteger(input.expiresAtMs) ||
    input.expiresAtMs <= input.nowMs ||
    input.expiresAtMs - input.nowMs > CLOUD_TENANT_MEMBERSHIP_INVITATION_TTL_MS
  ) {
    throw new TypeError("Invalid membership invitation");
  }
  const timestamp = new Date(input.nowMs).toISOString();
  const auditId = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO cloud_tenant_membership_invitations
           (id, tenant_id, issuer, role, code_hash, issued_by_membership_id,
            created_at_ms, expires_at_ms)
         SELECT ?, tenant.id, config.issuer, ?, ?, membership.id, ?, ?
           FROM tenants AS tenant
           JOIN cloud_customer_memberships AS membership
             ON membership.tenant_id = tenant.id AND membership.id = ?
           JOIN cloud_tenant_oidc_configs AS config
             ON config.tenant_id = tenant.id AND config.issuer = ? AND config.is_enabled = 1
          WHERE tenant.id = ? AND tenant.kind = 'customer' AND tenant.is_active = 1
            AND membership.is_active = 1 AND membership.role IN ('owner', 'admin')`
      )
      .bind(
        input.id,
        input.role,
        input.codeHash,
        input.nowMs,
        input.expiresAtMs,
        input.issuerMembershipId,
        input.issuer,
        input.tenantId
      ),
    db
      .prepare(
        `INSERT INTO cloud_compliance_audit
           (id, tenant_id, timestamp, action, actor, target, resource_type, status, metadata_json)
         SELECT ?, tenant_id, ?, 'customer.membership.invitation.created',
                issued_by_membership_id, id, 'customer-membership-invitation', 'success', ?
           FROM cloud_tenant_membership_invitations WHERE id = ? AND code_hash = ?`
      )
      .bind(
        auditId,
        timestamp,
        JSON.stringify({ invitationId: input.id, role: input.role }),
        input.id,
        input.codeHash
      ),
  ]);
  return validChanges(results[0]) && validChanges(results[1]);
}

export async function getPendingCloudTenantMembershipInvitation(
  db: CloudDb,
  codeHash: string,
  nowMs: number
): Promise<CloudTenantMembershipInvitation | null> {
  requireHash(codeHash);
  const row = await db
    .prepare<InvitationRow>(
      `SELECT invitation.id, invitation.tenant_id, invitation.issuer, invitation.role,
              invitation.expires_at_ms
         FROM cloud_tenant_membership_invitations AS invitation
         JOIN tenants AS tenant ON tenant.id = invitation.tenant_id
           AND tenant.kind = 'customer' AND tenant.is_active = 1
         JOIN cloud_tenant_oidc_configs AS config
           ON config.tenant_id = invitation.tenant_id AND config.issuer = invitation.issuer
          AND config.is_enabled = 1
        WHERE invitation.code_hash = ? AND invitation.consumed_at_ms IS NULL
          AND invitation.expires_at_ms > ?
        LIMIT 1`
    )
    .bind(codeHash, nowMs)
    .first();
  return row
    ? {
        id: row.id,
        tenantId: row.tenant_id,
        issuer: row.issuer,
        role: row.role,
        expiresAtMs: row.expires_at_ms,
      }
    : null;
}

/** Attach the verified OIDC subject and consume the invite atomically with an audit row. */
export async function acceptCloudTenantMembershipInvitation(
  db: CloudDb,
  input: {
    codeHash: string;
    invitation: CloudTenantMembershipInvitation;
    issuer: string;
    subject: string;
    nowMs: number;
  }
): Promise<{ membershipId: string; principalId: string; identityId: string } | null> {
  requireHash(input.codeHash);
  if (
    input.issuer !== input.invitation.issuer ||
    typeof input.subject !== "string" ||
    input.subject.length < 1 ||
    input.subject.length > 512 ||
    !Number.isSafeInteger(input.nowMs) ||
    input.invitation.expiresAtMs <= input.nowMs
  ) {
    return null;
  }
  const timestampMs = input.nowMs;
  const timestamp = new Date(timestampMs).toISOString();
  const consumeNonce = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = `oidc-${crypto.randomUUID()}`;
  const identityId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE cloud_tenant_membership_invitations SET consumed_at_ms = ?, consumed_nonce = ?
          WHERE code_hash = ? AND id = ? AND tenant_id = ? AND issuer = ? AND role = ?
            AND consumed_at_ms IS NULL AND expires_at_ms > ?
            AND EXISTS (
              SELECT 1 FROM tenants AS tenant
              JOIN cloud_tenant_oidc_configs AS config
                ON config.tenant_id = tenant.id AND config.issuer = ? AND config.is_enabled = 1
              WHERE tenant.id = cloud_tenant_membership_invitations.tenant_id
                AND tenant.kind = 'customer' AND tenant.is_active = 1
            )`
      )
      .bind(
        timestampMs,
        consumeNonce,
        input.codeHash,
        input.invitation.id,
        input.invitation.tenantId,
        input.issuer,
        input.invitation.role,
        timestampMs,
        input.issuer
      ),
    db
      .prepare(
        `INSERT INTO cloud_customer_memberships
           (id, tenant_id, principal_id, role, is_active, created_at, updated_at)
         SELECT ?, tenant_id, ?, role, 1, ?, ? FROM cloud_tenant_membership_invitations
          WHERE code_hash = ? AND consumed_nonce = ? AND consumed_at_ms = ?`
      )
      .bind(
        membershipId,
        principalId,
        timestamp,
        timestamp,
        input.codeHash,
        consumeNonce,
        timestampMs
      ),
    db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_identities
           (id, tenant_id, issuer, subject, membership_id, created_at)
         SELECT ?, invitation.tenant_id, invitation.issuer, ?, membership.id, ?
           FROM cloud_tenant_membership_invitations AS invitation
           JOIN cloud_customer_memberships AS membership
             ON membership.tenant_id = invitation.tenant_id AND membership.id = ?
          WHERE invitation.code_hash = ? AND invitation.consumed_nonce = ?
            AND invitation.consumed_at_ms = ? AND invitation.issuer = ?`
      )
      .bind(
        identityId,
        input.subject,
        timestamp,
        membershipId,
        input.codeHash,
        consumeNonce,
        timestampMs,
        input.issuer
      ),
    db
      .prepare(
        `INSERT INTO cloud_compliance_audit
           (id, tenant_id, timestamp, action, actor, target, resource_type, status, metadata_json)
         SELECT ?, membership.tenant_id, ?, 'customer.membership.invitation.accepted',
                membership.principal_id, membership.id, 'customer-membership-invitation',
                'success', ?
           FROM cloud_tenant_membership_invitations AS invitation
           JOIN cloud_customer_memberships AS membership
             ON membership.tenant_id = invitation.tenant_id AND membership.id = ?
           JOIN cloud_tenant_oidc_identities AS identity
             ON identity.tenant_id = membership.tenant_id AND identity.membership_id = membership.id
          WHERE invitation.code_hash = ? AND invitation.consumed_nonce = ?
            AND invitation.consumed_at_ms = ? AND identity.issuer = ? AND identity.subject = ?`
      )
      .bind(
        auditId,
        timestamp,
        JSON.stringify({ invitationId: input.invitation.id, role: input.invitation.role }),
        membershipId,
        input.codeHash,
        consumeNonce,
        timestampMs,
        input.issuer,
        input.subject
      ),
  ]);
  if (!results.every(validChanges)) return null;
  return { membershipId, principalId, identityId };
}

export async function cleanupExpiredCloudTenantMembershipInvitations(
  db: CloudDb,
  nowMs = Date.now(),
  batchSize = 500
): Promise<number> {
  const limit = Math.max(1, Math.min(1000, Math.floor(batchSize)));
  const result = await db
    .prepare(
      `DELETE FROM cloud_tenant_membership_invitations WHERE rowid IN (
         SELECT rowid FROM cloud_tenant_membership_invitations
          WHERE expires_at_ms <= ? OR (consumed_at_ms IS NOT NULL AND consumed_at_ms <= ?)
          ORDER BY expires_at_ms, id LIMIT ?
       )`
    )
    .bind(nowMs, nowMs - 24 * 60 * 60 * 1000, limit)
    .run();
  return Number(result.meta?.changes ?? 0);
}
