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
  values.push(input.updatedAt, input.tenantId, input.membershipId);
  const authorizationClause =
    input.authorization.type === "oidc_session"
      ? `EXISTS (
        SELECT 1 FROM cloud_customer_memberships m
        JOIN cloud_tenant_oidc_sessions s
          ON s.tenant_id = m.tenant_id AND s.membership_id = m.id
        JOIN tenants t ON t.id = m.tenant_id
        WHERE m.tenant_id = cloud_tenant_settings.tenant_id
          AND m.id = ? AND m.is_active = 1 AND m.role IN ('owner', 'admin')
          AND s.token_hash = ? AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ?
          AND t.kind = 'customer' AND t.is_active = 1
      )`
      : `EXISTS (
        SELECT 1 FROM cloud_customer_memberships m
        JOIN cloud_customer_api_keys k
          ON k.tenant_id = m.tenant_id AND k.membership_id = m.id
        JOIN tenants t ON t.id = m.tenant_id
        WHERE m.tenant_id = cloud_tenant_settings.tenant_id
          AND m.id = ? AND m.is_active = 1 AND m.role IN ('owner', 'admin')
          AND k.id = ? AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > ?)
          AND t.kind = 'customer' AND t.is_active = 1
      )`;
  values.push(
    input.authorization.type === "oidc_session"
      ? input.authorization.sessionTokenHash
      : input.authorization.apiKeyId,
    input.authorization.type === "oidc_session" ? Date.parse(input.updatedAt) : input.updatedAt
  );
  const result = await db.batch([
    db
      .prepare(
        `UPDATE cloud_tenant_settings SET ${assignments.join(", ")}
          WHERE tenant_id = ? AND ${authorizationClause}`
      )
      .bind(...values),
    prepareCloudComplianceAuditInsert(db, input.audit, {
      requirePreviousStatementChange: true,
    }).statement,
  ]);
  const updateChanges =
    typeof result[0] === "object" && result[0] !== null && "meta" in result[0]
      ? Number((result[0] as { meta?: { changes?: unknown } }).meta?.changes)
      : Number.NaN;
  if (updateChanges !== 1) return null;
  return getCloudTenantSettings(db, input.tenantId);
}
