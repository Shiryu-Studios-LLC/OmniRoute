import {
  prepareCloudComplianceAuditInsert,
  type CloudComplianceAuditInput,
} from "./complianceAudit";
import type { CloudDb } from "./db";
import {
  decryptCloudCredential,
  encryptCloudCredential,
  isCloudCredentialEnvelope,
} from "./credentialEncryption";

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

export interface CloudTenantOidcDraftCredentials extends CloudTenantOidcDraft {
  clientSecret: string;
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

/** Decrypts a draft only for the current owner/admin session inside the Worker auth flow. */
export async function getCloudTenantOidcDraftCredentials(
  db: CloudDb,
  encryptionKey: string | undefined,
  authorization: CloudTenantOidcDraftAuthorization,
  expectedUpdatedAt: string
): Promise<CloudTenantOidcDraftCredentials | null> {
  const row = await db
    .prepare<DraftRow & { client_secret_encrypted: string }>(
      `SELECT draft.tenant_id, draft.issuer, draft.client_id, draft.client_secret_encrypted,
              draft.scopes_json, draft.created_at, draft.updated_at
         FROM cloud_tenant_oidc_config_drafts draft
        WHERE draft.tenant_id = ? AND draft.updated_at = ? AND ${sessionPredicate()}
        LIMIT 1`
    )
    .bind(authorization.tenantId, expectedUpdatedAt, ...sessionBindings(authorization))
    .first();
  if (!row) return null;
  if (!isCloudCredentialEnvelope(row.client_secret_encrypted)) {
    throw new Error("OIDC draft client secret is not encrypted");
  }
  const clientSecret = await decryptCloudCredential(row.client_secret_encrypted, encryptionKey, {
    tenantId: authorization.tenantId,
    connectionId: "tenant-oidc-pending-draft",
    field: "clientSecret",
  });
  return { ...mapDraft(row), clientSecret };
}

export async function countOtherCloudTenantOidcIdentities(
  db: CloudDb,
  authorization: CloudTenantOidcDraftAuthorization
): Promise<number | null> {
  const row = await db
    .prepare<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM cloud_tenant_oidc_identities identity
        WHERE identity.tenant_id = ? AND identity.membership_id <> ?
          AND ${sessionPredicate()}`
    )
    .bind(authorization.tenantId, authorization.membershipId, ...sessionBindings(authorization))
    .first();
  return row ? Number(row.count) : null;
}

/** Atomically promotes one verified draft identity, invalidates old sessions/links, and audits. */
export async function promoteCloudTenantOidcDraft(
  db: CloudDb,
  input: {
    stateHash: string;
    tenantId: string;
    membershipId: string;
    sessionTokenHash: string;
    draftUpdatedAt: string;
    configUpdatedAt: string;
    otherIdentityCount: number;
    issuer: string;
    clientId: string;
    subject: string;
    identityId: string;
    timestamp: string;
    nowMs: number;
    audit: CloudComplianceAuditInput;
  }
): Promise<{ identityLinksInvalidated: number; sessionsInvalidated: number } | null> {
  const markState = db
    .prepare(
      `UPDATE cloud_tenant_oidc_login_states
          SET promotion_applied_at_ms = ?
        WHERE state_hash = ? AND purpose = 'draft_promotion'
          AND consumed_at_ms = ? AND expires_at_ms > ?
          AND promotion_applied_at_ms IS NULL
          AND tenant_id = ? AND issuer = ? AND client_id = ?
          AND promotion_session_hash = ? AND promotion_membership_id = ?
          AND promotion_draft_updated_at = ? AND promotion_config_updated_at = ?
          AND promotion_other_identity_count = ?
          AND EXISTS (
            SELECT 1 FROM cloud_tenant_oidc_config_drafts draft
             WHERE draft.tenant_id = ? AND draft.updated_at = ?
               AND draft.issuer = ? AND draft.client_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM cloud_tenant_oidc_configs config
             WHERE config.tenant_id = ? AND config.updated_at = ?
               AND config.issuer <> ? AND config.is_enabled = 1
          )
          AND EXISTS (
            SELECT 1 FROM cloud_tenant_oidc_sessions session
            JOIN cloud_customer_memberships membership
              ON membership.tenant_id = session.tenant_id AND membership.id = session.membership_id
             AND membership.is_active = 1 AND membership.role = 'owner'
            JOIN cloud_tenant_oidc_identities identity
              ON identity.tenant_id = session.tenant_id AND identity.id = session.identity_id
             AND identity.membership_id = session.membership_id
            JOIN cloud_tenant_oidc_configs config
              ON config.tenant_id = identity.tenant_id AND config.issuer = identity.issuer
             AND config.is_enabled = 1 AND config.updated_at = ?
            JOIN tenants tenant ON tenant.id = session.tenant_id
             AND tenant.kind = 'customer' AND tenant.is_active = 1
             WHERE session.token_hash = ? AND session.tenant_id = ?
               AND session.membership_id = ? AND session.revoked_at_ms IS NULL
               AND session.expires_at_ms > ?
          )
          AND (
            SELECT COUNT(*) FROM cloud_tenant_oidc_identities identity
             WHERE identity.tenant_id = ? AND identity.membership_id <> ?
          ) = ?
          AND NOT EXISTS (
            SELECT 1 FROM cloud_tenant_oidc_identities identity
             WHERE identity.tenant_id = ? AND identity.issuer = ?
               AND identity.subject = ? AND identity.membership_id <> ?
          )`
    )
    .bind(
      input.nowMs,
      input.stateHash,
      input.nowMs,
      input.nowMs,
      input.tenantId,
      input.issuer,
      input.clientId,
      input.sessionTokenHash,
      input.membershipId,
      input.draftUpdatedAt,
      input.configUpdatedAt,
      input.otherIdentityCount,
      input.tenantId,
      input.draftUpdatedAt,
      input.issuer,
      input.clientId,
      input.tenantId,
      input.configUpdatedAt,
      input.issuer,
      input.configUpdatedAt,
      input.sessionTokenHash,
      input.tenantId,
      input.membershipId,
      input.nowMs,
      input.tenantId,
      input.membershipId,
      input.otherIdentityCount,
      input.tenantId,
      input.issuer,
      input.subject,
      input.membershipId
    );
  const updateConfig = db
    .prepare(
      `UPDATE cloud_tenant_oidc_configs
          SET issuer = ?, client_id = ?,
              client_secret_encrypted = (
                SELECT draft.client_secret_encrypted FROM cloud_tenant_oidc_config_drafts draft
                 WHERE draft.tenant_id = ? AND draft.updated_at = ?
              ),
              scopes_json = (
                SELECT draft.scopes_json FROM cloud_tenant_oidc_config_drafts draft
                 WHERE draft.tenant_id = ? AND draft.updated_at = ?
              ),
              is_enabled = 1, updated_at = ?
        WHERE tenant_id = ? AND updated_at = ?
          AND EXISTS (
            SELECT 1 FROM cloud_tenant_oidc_login_states state
             WHERE state.state_hash = ? AND state.promotion_applied_at_ms = ?
          )`
    )
    .bind(
      input.issuer,
      input.clientId,
      input.tenantId,
      input.draftUpdatedAt,
      input.tenantId,
      input.draftUpdatedAt,
      input.timestamp,
      input.tenantId,
      input.configUpdatedAt,
      input.stateHash,
      input.nowMs
    );
  const revokeSessions = db
    .prepare(
      `UPDATE cloud_tenant_oidc_sessions SET revoked_at_ms = ?
        WHERE tenant_id = ? AND revoked_at_ms IS NULL
          AND EXISTS (
            SELECT 1 FROM cloud_tenant_oidc_login_states state
             WHERE state.state_hash = ? AND state.promotion_applied_at_ms = ?
          )`
    )
    .bind(input.nowMs, input.tenantId, input.stateHash, input.nowMs);
  const deleteIdentities = db
    .prepare(
      `DELETE FROM cloud_tenant_oidc_identities
        WHERE tenant_id = ?
          AND EXISTS (
            SELECT 1 FROM cloud_tenant_oidc_login_states state
            JOIN cloud_tenant_oidc_configs config ON config.tenant_id = state.tenant_id
             WHERE state.state_hash = ? AND state.promotion_applied_at_ms = ?
               AND config.issuer = ? AND config.updated_at = ?
          )`
    )
    .bind(input.tenantId, input.stateHash, input.nowMs, input.issuer, input.timestamp);
  const insertIdentity = db
    .prepare(
      `INSERT INTO cloud_tenant_oidc_identities
         (id, tenant_id, issuer, subject, membership_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM cloud_tenant_oidc_login_states state
          JOIN cloud_tenant_oidc_configs config ON config.tenant_id = state.tenant_id
           WHERE state.state_hash = ? AND state.promotion_applied_at_ms = ?
             AND config.issuer = ? AND config.updated_at = ?
        )
          AND EXISTS (
            SELECT 1 FROM cloud_customer_memberships membership
             WHERE membership.tenant_id = ? AND membership.id = ?
               AND membership.is_active = 1 AND membership.role = 'owner'
          )`
    )
    .bind(
      input.identityId,
      input.tenantId,
      input.issuer,
      input.subject,
      input.membershipId,
      input.timestamp,
      input.stateHash,
      input.nowMs,
      input.issuer,
      input.timestamp,
      input.tenantId,
      input.membershipId
    );
  const deleteDraft = db
    .prepare(
      `DELETE FROM cloud_tenant_oidc_config_drafts
        WHERE tenant_id = ? AND updated_at = ?
          AND EXISTS (
            SELECT 1 FROM cloud_tenant_oidc_login_states state
            JOIN cloud_tenant_oidc_configs config ON config.tenant_id = state.tenant_id
             WHERE state.state_hash = ? AND state.promotion_applied_at_ms = ?
               AND config.issuer = ? AND config.updated_at = ?
          )`
    )
    .bind(
      input.tenantId,
      input.draftUpdatedAt,
      input.stateHash,
      input.nowMs,
      input.issuer,
      input.timestamp
    );
  const audit = prepareCloudComplianceAuditInsert(db, input.audit, {
    requirePreviousStatementChange: true,
  }).statement;

  const results = await db.batch([
    markState,
    updateConfig,
    revokeSessions,
    deleteIdentities,
    insertIdentity,
    deleteDraft,
    audit,
  ]);
  const changes = results.map((result) =>
    result && typeof result === "object" && "meta" in result
      ? Number((result as { meta?: { changes?: unknown } }).meta?.changes ?? 0)
      : 0
  );
  if (
    changes[0] !== 1 ||
    changes[1] !== 1 ||
    changes[2]! < 1 ||
    changes[3]! < 1 ||
    changes[4] !== 1 ||
    changes[5] !== 1 ||
    changes[6] !== 1
  ) {
    return null;
  }
  return {
    identityLinksInvalidated: changes[3] ?? 0,
    sessionsInvalidated: changes[2] ?? 0,
  };
}

/** Records only a sanitized validation outcome if the owner/admin session is still active. */
export async function recordCloudTenantOidcDraftValidation(
  db: CloudDb,
  input: {
    authorization: CloudTenantOidcDraftAuthorization;
    expectedDraftUpdatedAt: string;
    audit: CloudComplianceAuditInput;
  }
): Promise<"recorded" | "session_inactive" | "draft_changed"> {
  const { record } = prepareCloudComplianceAuditInsert(db, input.audit);
  const result = await db
    .prepare(
      `INSERT INTO cloud_compliance_audit (
         id, tenant_id, timestamp, action, actor, target, details_json,
         ip_address, resource_type, status, request_id, metadata_json
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${sessionPredicate()}
            AND EXISTS (
              SELECT 1 FROM cloud_tenant_oidc_config_drafts draft
               WHERE draft.tenant_id = ? AND draft.updated_at = ?
            )`
    )
    .bind(
      record.id,
      record.tenantId,
      record.timestamp,
      record.action,
      record.actor,
      record.target,
      record.details === null ? null : JSON.stringify(record.details),
      record.ipAddress,
      record.resourceType,
      record.status,
      record.requestId,
      record.metadata === null ? null : JSON.stringify(record.metadata),
      ...sessionBindings(input.authorization),
      input.authorization.tenantId,
      input.expectedDraftUpdatedAt
    )
    .run();
  if (!result.success) throw new Error("OIDC draft validation audit write failed");
  if (Number(result.meta?.changes ?? 0) === 1) return "recorded";
  const activeSession = await db
    .prepare<{ active: number }>(`SELECT ${sessionPredicate()} AS active`)
    .bind(...sessionBindings(input.authorization))
    .first();
  return activeSession?.active === 1 ? "draft_changed" : "session_inactive";
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
