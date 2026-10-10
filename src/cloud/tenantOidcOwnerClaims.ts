import type { CloudDb } from "./db";
import {
  prepareCloudComplianceAuditInsert,
  type CloudComplianceAuditInput,
} from "./complianceAudit";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const CLOUD_TENANT_OIDC_OWNER_CLAIM_TTL_MS = 15 * 60 * 1000;

export interface CloudTenantOidcOwnerClaim {
  tenantId: string;
  issuer: string;
  expectedSubject: string;
  expiresAtMs: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function hashCloudTenantOidcOwnerClaim(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createCode(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createCloudTenantOidcOwnerClaimCode(): Promise<{
  code: string;
  codeHash: string;
}> {
  const code = createCode();
  return { code, codeHash: await hashCloudTenantOidcOwnerClaim(code) };
}

function hasOneChange(result: unknown): boolean {
  if (!result || typeof result !== "object" || !("meta" in result)) return false;
  return Number((result as { meta?: { changes?: unknown } }).meta?.changes ?? 0) === 1;
}

/** Issue or reissue a digest-only first-owner claim, but only before any owner exists. */
export async function issueCloudTenantOidcOwnerClaim(
  db: CloudDb,
  input: {
    tenantId: string;
    code: string;
    codeHash: string;
    expectedSubject: string;
    nowMs: number;
    expiresAtMs: number;
    audit: CloudComplianceAuditInput;
  }
): Promise<{ code: string; expiresAtMs: number } | null> {
  if (
    !ID_PATTERN.test(input.tenantId) ||
    !/^[A-Za-z0-9_-]{40,128}$/.test(input.code) ||
    !HASH_PATTERN.test(input.codeHash) ||
    typeof input.expectedSubject !== "string" ||
    input.expectedSubject.length < 1 ||
    input.expectedSubject.length > 512 ||
    !Number.isSafeInteger(input.nowMs) ||
    !Number.isSafeInteger(input.expiresAtMs) ||
    input.expiresAtMs <= input.nowMs ||
    input.expiresAtMs - input.nowMs > CLOUD_TENANT_OIDC_OWNER_CLAIM_TTL_MS
  ) {
    throw new TypeError("Invalid first-owner claim");
  }
  if ((await hashCloudTenantOidcOwnerClaim(input.code)) !== input.codeHash) {
    throw new TypeError("First-owner claim digest does not match its code");
  }

  const expiresAtMs = input.expiresAtMs;
  const statement = db
    .prepare(
      `INSERT INTO cloud_tenant_oidc_owner_claims
         (tenant_id, issuer, code_hash, expected_subject, created_at_ms, expires_at_ms,
          consumed_at_ms, consumed_nonce)
       SELECT tenant.id, config.issuer, ?, ?, ?, ?, NULL, NULL
         FROM tenants AS tenant
         JOIN cloud_tenant_oidc_configs AS config ON config.tenant_id = tenant.id
          AND config.is_enabled = 1
        WHERE tenant.id = ? AND tenant.kind = 'customer' AND tenant.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM cloud_customer_memberships membership
             WHERE membership.tenant_id = tenant.id AND membership.role = 'owner'
               AND membership.is_active = 1
          )
       ON CONFLICT(tenant_id) DO UPDATE SET
         issuer = excluded.issuer,
         code_hash = excluded.code_hash,
         expected_subject = excluded.expected_subject,
         created_at_ms = excluded.created_at_ms,
         expires_at_ms = excluded.expires_at_ms,
         consumed_at_ms = NULL,
         consumed_nonce = NULL
       WHERE EXISTS (
         SELECT 1 FROM tenants AS tenant
         JOIN cloud_tenant_oidc_configs AS config ON config.tenant_id = tenant.id
          AND config.is_enabled = 1 AND config.issuer = excluded.issuer
          WHERE tenant.id = excluded.tenant_id AND tenant.kind = 'customer' AND tenant.is_active = 1
       ) AND NOT EXISTS (
         SELECT 1 FROM cloud_customer_memberships membership
          WHERE membership.tenant_id = excluded.tenant_id AND membership.role = 'owner'
            AND membership.is_active = 1
       )`
    )
    .bind(input.codeHash, input.expectedSubject, input.nowMs, input.expiresAtMs, input.tenantId);
  const audit = prepareCloudComplianceAuditInsert(db, input.audit, {
    requirePreviousStatementChange: true,
  }).statement;
  const results = await db.batch([statement, audit]);
  if (!results.every(hasOneChange)) return null;
  return { code: input.code, expiresAtMs };
}

export async function getPendingCloudTenantOidcOwnerClaim(
  db: CloudDb,
  input: { tenantId: string; codeHash: string; nowMs: number }
): Promise<CloudTenantOidcOwnerClaim | null> {
  if (!ID_PATTERN.test(input.tenantId) || !HASH_PATTERN.test(input.codeHash)) return null;
  const row = await db
    .prepare<{
      tenant_id: string;
      issuer: string;
      expected_subject: string;
      expires_at_ms: number;
    }>(
      `SELECT claim.tenant_id, claim.issuer, claim.expected_subject, claim.expires_at_ms
         FROM cloud_tenant_oidc_owner_claims AS claim
         JOIN tenants AS tenant ON tenant.id = claim.tenant_id
           AND tenant.kind = 'customer' AND tenant.is_active = 1
         JOIN cloud_tenant_oidc_configs AS config
           ON config.tenant_id = claim.tenant_id AND config.issuer = claim.issuer
          AND config.is_enabled = 1
        WHERE claim.tenant_id = ? AND claim.code_hash = ?
          AND claim.consumed_at_ms IS NULL AND claim.expires_at_ms > ?
          AND NOT EXISTS (
            SELECT 1 FROM cloud_customer_memberships membership
             WHERE membership.tenant_id = claim.tenant_id AND membership.role = 'owner'
               AND membership.is_active = 1
          )
        LIMIT 1`
    )
    .bind(input.tenantId, input.codeHash, input.nowMs)
    .first();
  return row
    ? {
        tenantId: row.tenant_id,
        issuer: row.issuer,
        expectedSubject: row.expected_subject,
        expiresAtMs: row.expires_at_ms,
      }
    : null;
}

export async function getPendingCloudTenantOidcOwnerClaimByHash(
  db: CloudDb,
  codeHash: string,
  nowMs: number
): Promise<CloudTenantOidcOwnerClaim | null> {
  if (!HASH_PATTERN.test(codeHash)) return null;
  const row = await db
    .prepare<{
      tenant_id: string;
      issuer: string;
      expected_subject: string;
      expires_at_ms: number;
    }>(
      `SELECT claim.tenant_id, claim.issuer, claim.expected_subject, claim.expires_at_ms
         FROM cloud_tenant_oidc_owner_claims AS claim
         JOIN tenants AS tenant ON tenant.id = claim.tenant_id
           AND tenant.kind = 'customer' AND tenant.is_active = 1
         JOIN cloud_tenant_oidc_configs AS config
           ON config.tenant_id = claim.tenant_id AND config.issuer = claim.issuer
          AND config.is_enabled = 1
        WHERE claim.code_hash = ? AND claim.consumed_at_ms IS NULL
          AND claim.expires_at_ms > ?
          AND NOT EXISTS (
            SELECT 1 FROM cloud_customer_memberships membership
             WHERE membership.tenant_id = claim.tenant_id AND membership.role = 'owner'
               AND membership.is_active = 1
          )
        LIMIT 1`
    )
    .bind(codeHash, nowMs)
    .first();
  return row
    ? {
        tenantId: row.tenant_id,
        issuer: row.issuer,
        expectedSubject: row.expected_subject,
        expiresAtMs: row.expires_at_ms,
      }
    : null;
}

/** Consume a claim and create the first owner, exact OIDC link, and audit row in one D1 batch. */
export async function acceptCloudTenantOidcOwnerClaim(
  db: CloudDb,
  input: {
    tenantId: string;
    codeHash: string;
    claim: CloudTenantOidcOwnerClaim;
    issuer: string;
    subject: string;
    nowMs: number;
  }
): Promise<{ membershipId: string; principalId: string; identityId: string } | null> {
  if (
    !ID_PATTERN.test(input.tenantId) ||
    !HASH_PATTERN.test(input.codeHash) ||
    input.claim.tenantId !== input.tenantId ||
    input.claim.issuer !== input.issuer ||
    input.claim.expectedSubject !== input.subject ||
    typeof input.subject !== "string" ||
    input.subject.length < 1 ||
    input.subject.length > 512 ||
    !Number.isSafeInteger(input.nowMs) ||
    input.claim.expiresAtMs <= input.nowMs
  ) {
    return null;
  }

  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const timestampMs = input.nowMs;
  const timestamp = new Date(timestampMs).toISOString();
  const membershipId = crypto.randomUUID();
  const principalId = `oidc-${crypto.randomUUID()}`;
  const identityId = crypto.randomUUID();
  const auditId = crypto.randomUUID();

  const consume = db
    .prepare(
      `UPDATE cloud_tenant_oidc_owner_claims SET consumed_at_ms = ?, consumed_nonce = ?
        WHERE tenant_id = ? AND code_hash = ? AND issuer = ? AND expected_subject = ?
          AND consumed_at_ms IS NULL AND expires_at_ms > ?
          AND EXISTS (
            SELECT 1 FROM tenants AS tenant
            JOIN cloud_tenant_oidc_configs AS config
              ON config.tenant_id = tenant.id AND config.issuer = ? AND config.is_enabled = 1
            WHERE tenant.id = cloud_tenant_oidc_owner_claims.tenant_id
              AND tenant.kind = 'customer' AND tenant.is_active = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM cloud_customer_memberships membership
             WHERE membership.tenant_id = cloud_tenant_oidc_owner_claims.tenant_id
               AND membership.role = 'owner' AND membership.is_active = 1
          )`
    )
    .bind(
      timestampMs,
      nonce,
      input.tenantId,
      input.codeHash,
      input.issuer,
      input.subject,
      timestampMs,
      input.issuer
    );
  const createMembership = db
    .prepare(
      `INSERT INTO cloud_customer_memberships
         (id, tenant_id, principal_id, role, is_active, created_at, updated_at)
       SELECT ?, claim.tenant_id, ?, 'owner', 1, ?, ?
         FROM cloud_tenant_oidc_owner_claims AS claim
        WHERE claim.tenant_id = ? AND claim.code_hash = ? AND claim.issuer = ?
          AND claim.consumed_at_ms = ? AND claim.consumed_nonce = ?
          AND NOT EXISTS (
            SELECT 1 FROM cloud_customer_memberships membership
             WHERE membership.tenant_id = claim.tenant_id AND membership.role = 'owner'
               AND membership.is_active = 1
          )`
    )
    .bind(
      membershipId,
      principalId,
      timestamp,
      timestamp,
      input.tenantId,
      input.codeHash,
      input.issuer,
      timestampMs,
      nonce
    );
  const createIdentity = db
    .prepare(
      `INSERT INTO cloud_tenant_oidc_identities
         (id, tenant_id, issuer, subject, membership_id, created_at)
       SELECT ?, membership.tenant_id, ?, ?, membership.id, ?
         FROM cloud_customer_memberships AS membership
         JOIN cloud_tenant_oidc_owner_claims AS claim ON claim.tenant_id = membership.tenant_id
        WHERE membership.tenant_id = ? AND membership.id = ? AND membership.role = 'owner'
          AND membership.is_active = 1 AND claim.code_hash = ? AND claim.issuer = ?
          AND claim.consumed_at_ms = ? AND claim.consumed_nonce = ?
          AND EXISTS (
            SELECT 1 FROM cloud_tenant_oidc_configs config
             WHERE config.tenant_id = membership.tenant_id AND config.issuer = ?
               AND config.is_enabled = 1
          )`
    )
    .bind(
      identityId,
      input.issuer,
      input.subject,
      timestamp,
      input.tenantId,
      membershipId,
      input.codeHash,
      input.issuer,
      timestampMs,
      nonce,
      input.issuer
    );
  const audit = db
    .prepare(
      `INSERT INTO cloud_compliance_audit
         (id, tenant_id, timestamp, action, actor, target, resource_type, status, metadata_json)
       SELECT ?, identity.tenant_id, ?, 'customer.oidc.owner.bootstrap.accepted',
              membership.id, membership.id, 'customer-membership', 'success', ?
         FROM cloud_tenant_oidc_owner_claims AS claim
         JOIN cloud_customer_memberships AS membership
           ON membership.tenant_id = claim.tenant_id AND membership.id = ?
         JOIN cloud_tenant_oidc_identities AS identity
           ON identity.tenant_id = membership.tenant_id AND identity.membership_id = membership.id
        WHERE claim.tenant_id = ? AND claim.code_hash = ? AND claim.issuer = ?
          AND claim.consumed_at_ms = ? AND claim.consumed_nonce = ?
          AND identity.issuer = ? AND identity.subject = ?`
    )
    .bind(
      auditId,
      timestamp,
      JSON.stringify({ role: "owner" }),
      membershipId,
      input.tenantId,
      input.codeHash,
      input.issuer,
      timestampMs,
      nonce,
      input.issuer,
      input.subject
    );

  const results = await db.batch([consume, createMembership, createIdentity, audit]);
  if (!results.every(hasOneChange)) return null;
  return { membershipId, principalId, identityId };
}
