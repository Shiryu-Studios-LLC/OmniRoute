import type { CloudDb } from "./db";
import {
  prepareCloudComplianceAuditInsert,
  type CloudComplianceAuditInput,
} from "./complianceAudit";

export interface CloudTenantSettings {
  tenantId: string;
  localAiEnabled: boolean;
  mcpEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CloudTenantSettingsAuthorization =
  { type: "api_key"; apiKeyId: string } | { type: "oidc_session"; sessionTokenHash: string };

interface CloudTenantSettingsRow {
  tenant_id: string;
  local_ai_enabled: number;
  mcp_enabled: number;
  created_at: string;
  updated_at: string;
}

/** Read settings by tenant ID. Callers must authorize the tenant before reading. */
export async function getCloudTenantSettings(
  db: CloudDb,
  tenantId: string
): Promise<CloudTenantSettings | null> {
  const row = await db
    .prepare<CloudTenantSettingsRow>(
      `SELECT tenant_id, local_ai_enabled, mcp_enabled, created_at, updated_at
         FROM cloud_tenant_settings
        WHERE tenant_id = ? LIMIT 1`
    )
    .bind(tenantId)
    .first<CloudTenantSettingsRow>();

  return row
    ? {
        tenantId: row.tenant_id,
        localAiEnabled: row.local_ai_enabled !== 0,
        mcpEnabled: row.mcp_enabled !== 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

/** Update customer opt-in settings and atomically write the audit record. */
export async function updateCloudTenantSettings(
  db: CloudDb,
  input: {
    tenantId: string;
    membershipId: string;
    authorization: CloudTenantSettingsAuthorization;
    localAiEnabled?: boolean;
    mcpEnabled?: boolean;
    updatedAt: string;
    audit: CloudComplianceAuditInput;
  }
): Promise<CloudTenantSettings | null> {
  if (
    (input.localAiEnabled !== undefined && typeof input.localAiEnabled !== "boolean") ||
    (input.mcpEnabled !== undefined && typeof input.mcpEnabled !== "boolean") ||
    (input.localAiEnabled === undefined && input.mcpEnabled === undefined)
  ) {
    throw new TypeError("At least one tenant feature setting must be a boolean");
  }
  if (input.audit.tenantId !== input.tenantId) {
    throw new TypeError("Tenant settings audit tenant must match the target tenant");
  }
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (input.localAiEnabled !== undefined) {
    assignments.push("local_ai_enabled = ?");
    values.push(input.localAiEnabled ? 1 : 0);
  }
  if (input.mcpEnabled !== undefined) {
    assignments.push("mcp_enabled = ?");
    values.push(input.mcpEnabled ? 1 : 0);
  }
  assignments.push("updated_at = ?");
  values.push(input.updatedAt, input.tenantId);
  const authorization = settingsAuthorizationPredicate("settings", input, input.updatedAt);
  const authorizedTarget = `EXISTS (
    SELECT 1 FROM cloud_tenant_settings settings
     WHERE settings.tenant_id = ? AND ${authorization.sql}
  )`;
  const canUpdate = await db
    .prepare<{ allowed: number }>(
      `SELECT 1 AS allowed FROM cloud_tenant_settings settings
        WHERE settings.tenant_id = ? AND ${authorization.sql} LIMIT 1`
    )
    .bind(input.tenantId, ...authorization.values)
    .first();
  if (!canUpdate) return null;

  const preparedAudit = prepareCloudComplianceAuditInsert(db, input.audit, {
    where: { sql: authorizedTarget, values: [input.tenantId, ...authorization.values] },
  });
  values.push(...authorization.values, preparedAudit.record.id, preparedAudit.record.action);
  const result = await db.batch([
    preparedAudit.statement,
    db
      .prepare(
        `UPDATE cloud_tenant_settings AS settings SET ${assignments.join(", ")}
          WHERE settings.tenant_id = ? AND ${authorization.sql}
            AND changes() = 1
            AND EXISTS (
              SELECT 1 FROM cloud_compliance_audit audit
               WHERE audit.id = ? AND audit.tenant_id = settings.tenant_id
                 AND audit.action = ?
            )`
      )
      .bind(...values),
    db
      .prepare(
        `INSERT INTO cloud_tenant_settings (tenant_id, local_ai_enabled, mcp_enabled, created_at, updated_at)
         SELECT settings.tenant_id, settings.local_ai_enabled, settings.mcp_enabled,
                settings.created_at, settings.updated_at
           FROM cloud_tenant_settings settings
          WHERE settings.tenant_id = ? AND changes() != 1
            AND EXISTS (
              SELECT 1 FROM cloud_compliance_audit audit
               WHERE audit.id = ? AND audit.tenant_id = settings.tenant_id
                 AND audit.action = ?
            )`
      )
      .bind(input.tenantId, preparedAudit.record.id, preparedAudit.record.action),
  ]);
  const auditResult = result[0];
  const updateResult = result[1];
  const guardResult = result[2];
  if (
    result.length !== 3 ||
    !isSuccessfulBatchResult(auditResult) ||
    !isSuccessfulBatchResult(updateResult) ||
    !isSuccessfulBatchResult(guardResult)
  ) {
    throw new Error("D1 customer settings update batch failed");
  }
  const updateChanges =
    "meta" in updateResult && typeof updateResult.meta === "object" && updateResult.meta !== null
      ? Number((updateResult.meta as { changes?: unknown }).changes)
      : Number.NaN;
  if (!Number.isSafeInteger(updateChanges) || updateChanges < 0) {
    throw new Error("D1 customer settings update returned invalid state");
  }
  const auditChanges =
    "meta" in auditResult && typeof auditResult.meta === "object" && auditResult.meta !== null
      ? (auditResult.meta as { changes?: unknown }).changes
      : undefined;
  const guardChanges =
    "meta" in guardResult && typeof guardResult.meta === "object" && guardResult.meta !== null
      ? (guardResult.meta as { changes?: unknown }).changes
      : undefined;
  if (updateChanges !== 1 || auditChanges !== 1 || guardChanges !== 0) {
    throw new Error("D1 customer settings audit and update were not completed together");
  }
  return getCloudTenantSettings(db, input.tenantId);
}

function settingsAuthorizationPredicate(
  settingsAlias: string,
  input: {
    membershipId: string;
    authorization: CloudTenantSettingsAuthorization;
  },
  now: string
): { sql: string; values: unknown[] } {
  const credentialCheck =
    input.authorization.type === "oidc_session"
      ? `EXISTS (
          SELECT 1 FROM cloud_tenant_oidc_sessions session
           WHERE session.tenant_id = membership.tenant_id
             AND session.membership_id = membership.id
             AND session.token_hash = ? AND session.revoked_at_ms IS NULL
             AND session.expires_at_ms > ?
        )`
      : `EXISTS (
          SELECT 1 FROM cloud_customer_api_keys api_key
           WHERE api_key.tenant_id = membership.tenant_id
             AND api_key.membership_id = membership.id
             AND api_key.id = ? AND api_key.revoked_at IS NULL
             AND (api_key.expires_at IS NULL OR api_key.expires_at > ?)
        )`;
  return {
    sql: `EXISTS (
      SELECT 1 FROM cloud_customer_memberships membership
      JOIN tenants tenant ON tenant.id = membership.tenant_id
       WHERE membership.tenant_id = ${settingsAlias}.tenant_id
         AND membership.id = ? AND membership.is_active = 1
         AND membership.role IN ('owner', 'admin')
         AND tenant.kind = 'customer' AND tenant.is_active = 1
         AND ${credentialCheck}
    )`,
    values: [
      input.membershipId,
      input.authorization.type === "oidc_session"
        ? input.authorization.sessionTokenHash
        : input.authorization.apiKeyId,
      input.authorization.type === "oidc_session" ? Date.parse(now) : now,
    ],
  };
}

function isSuccessfulBatchResult(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && "success" in value && value.success === true
  );
}
