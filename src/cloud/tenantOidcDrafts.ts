import {
  prepareCloudComplianceAuditInsert,
  type CloudComplianceAuditInput,
} from "./complianceAudit";
import type { CloudDb } from "./db";
import { encryptCloudCredential } from "./credentialEncryption";

const DEFAULT_SCOPES = ["openid", "profile", "email"];
export const CLOUD_TENANT_OIDC_DRAFT_PATH = "/__cloud/auth/oidc-draft";

export interface CloudTenantOidcDraft {
  tenantId: string;
  issuer: string;
  clientId: string;
  scopes: string[];
  hasClientSecret: true;
  createdAt: string;
  updatedAt: string;
}

export interface CloudTenantOidcDraftAuthorization {
  tenantId: string;
  membershipId: string;
  sessionTokenHash: string;
  nowMs: number;
}

interface DraftRow {
  tenant_id: string;
  issuer: string;
  client_id: string;
  scopes_json: string;
  created_at: string;
  updated_at: string;
}

function mapDraft(row: DraftRow): CloudTenantOidcDraft {
  return {
    tenantId: row.tenant_id,
    issuer: row.issuer,
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    hasClientSecret: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sessionPredicate(): string {
  return `EXISTS (
    SELECT 1
      FROM cloud_tenant_oidc_sessions s
      JOIN cloud_customer_memberships m
        ON m.tenant_id = s.tenant_id AND m.id = s.membership_id
      JOIN cloud_tenant_oidc_identities i
        ON i.tenant_id = s.tenant_id AND i.id = s.identity_id
       AND i.membership_id = s.membership_id
      JOIN cloud_tenant_oidc_configs c
        ON c.tenant_id = i.tenant_id AND c.issuer = i.issuer AND c.is_enabled = 1
      JOIN tenants t ON t.id = s.tenant_id AND t.kind = 'customer' AND t.is_active = 1
     WHERE s.token_hash = ? AND s.tenant_id = ? AND s.membership_id = ?
       AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ?
       AND m.is_active = 1 AND m.role IN ('owner', 'admin')
  )`;
}

function sessionBindings(auth: CloudTenantOidcDraftAuthorization): unknown[] {
  return [auth.sessionTokenHash, auth.tenantId, auth.membershipId, auth.nowMs];
}

function requireDraftInput(input: {
  issuer: unknown;
  clientId: unknown;
  clientSecret: unknown;
  scopes: unknown;
}): { issuer: string; clientId: string; clientSecret: string; scopes: string[] } {
  if (
    typeof input.issuer !== "string" ||
    input.issuer.length < 1 ||
    input.issuer.length > 500 ||
    input.issuer !== input.issuer.trim()
  ) {
    throw new TypeError("Invalid OIDC issuer");
  }
  try {
    const issuer = new URL(input.issuer);
    if (
      issuer.protocol !== "https:" ||
      issuer.username !== "" ||
      issuer.password !== "" ||
      issuer.search !== "" ||
      issuer.hash !== ""
    ) {
      throw new TypeError("Invalid OIDC issuer");
    }
  } catch {
    throw new TypeError("Invalid OIDC issuer");
  }
  if (
    typeof input.clientId !== "string" ||
    input.clientId.length < 1 ||
    input.clientId.length > 200 ||
    input.clientId !== input.clientId.trim()
  ) {
    throw new TypeError("Invalid OIDC clientId");
  }
  if (
    typeof input.clientSecret !== "string" ||
    input.clientSecret.length < 1 ||
    input.clientSecret.length > 500
  ) {
    throw new TypeError("Invalid OIDC clientSecret");
  }
  const scopes = input.scopes === undefined ? DEFAULT_SCOPES : input.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    scopes.length > 20 ||
    scopes.some(
      (scope) =>
        typeof scope !== "string" ||
        scope.length < 1 ||
        scope.length > 100 ||
        scope !== scope.trim()
    ) ||
    new Set(scopes).size !== scopes.length ||
    !scopes.includes("openid")
  ) {
    throw new TypeError("Invalid OIDC scopes");
  }
  return {
    issuer: input.issuer,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    scopes,
  };
}

export async function getCloudTenantOidcDraft(
  db: CloudDb,
  authorization: CloudTenantOidcDraftAuthorization
): Promise<CloudTenantOidcDraft | null> {
  const row = await db
    .prepare<DraftRow>(
      `SELECT draft.tenant_id, draft.issuer, draft.client_id, draft.scopes_json,
              draft.created_at, draft.updated_at
         FROM cloud_tenant_oidc_config_drafts draft
        WHERE draft.tenant_id = ? AND ${sessionPredicate()}
        LIMIT 1`
    )
    .bind(authorization.tenantId, ...sessionBindings(authorization))
    .first<DraftRow>();
  return row ? mapDraft(row) : null;
}

export async function saveCloudTenantOidcDraft(
  db: CloudDb,
  encryptionKey: string | undefined,
  input: {
    authorization: CloudTenantOidcDraftAuthorization;
    issuer: unknown;
    clientId: unknown;
    clientSecret: unknown;
    scopes: unknown;
    timestamp: string;
    audit: CloudComplianceAuditInput;
  }
): Promise<CloudTenantOidcDraft | null> {
  const value = requireDraftInput(input);
  const encryptedSecret = await encryptCloudCredential(value.clientSecret, encryptionKey, {
    tenantId: input.authorization.tenantId,
    connectionId: "tenant-oidc-pending-draft",
    field: "clientSecret",
  });
  const existing = await db
    .prepare<{ created_at: string }>(
      `SELECT created_at FROM cloud_tenant_oidc_config_drafts WHERE tenant_id = ?`
    )
    .bind(input.authorization.tenantId)
    .first();
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_config_drafts
           (tenant_id, issuer, client_id, client_secret_encrypted, scopes_json,
            created_by_membership_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE 1 = 1 AND ${sessionPredicate()}
         ON CONFLICT(tenant_id) DO UPDATE SET
           issuer = excluded.issuer,
           client_id = excluded.client_id,
           client_secret_encrypted = excluded.client_secret_encrypted,
           scopes_json = excluded.scopes_json,
           created_by_membership_id = excluded.created_by_membership_id,
           updated_at = excluded.updated_at`
      )
      .bind(
        input.authorization.tenantId,
        value.issuer,
        value.clientId,
        encryptedSecret,
        JSON.stringify(value.scopes),
        input.authorization.membershipId,
        existing?.created_at ?? input.timestamp,
        input.timestamp,
        ...sessionBindings(input.authorization)
      ),
    prepareCloudComplianceAuditInsert(db, input.audit, {
      requirePreviousStatementChange: true,
    }).statement,
  ]);
  const changes =
    typeof result[0] === "object" && result[0] !== null && "meta" in result[0]
      ? Number((result[0] as { meta?: { changes?: unknown } }).meta?.changes)
      : 0;
  if (changes !== 1) return null;
  return getCloudTenantOidcDraft(db, input.authorization);
}

export async function deleteCloudTenantOidcDraft(
  db: CloudDb,
  input: {
    authorization: CloudTenantOidcDraftAuthorization;
    audit: CloudComplianceAuditInput;
  }
): Promise<boolean> {
  const result = await db.batch([
    db
      .prepare(
        `DELETE FROM cloud_tenant_oidc_config_drafts
          WHERE tenant_id = ? AND ${sessionPredicate()}`
      )
      .bind(input.authorization.tenantId, ...sessionBindings(input.authorization)),
    prepareCloudComplianceAuditInsert(db, input.audit, {
      requirePreviousStatementChange: true,
    }).statement,
  ]);
  return (
    typeof result[0] === "object" &&
    result[0] !== null &&
    "meta" in result[0] &&
    Number((result[0] as { meta?: { changes?: unknown } }).meta?.changes) === 1
  );
}
