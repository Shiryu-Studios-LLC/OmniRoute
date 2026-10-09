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
    apiKeyId: string;
    localAiEnabled: boolean;
    mcpEnabled: boolean;
    updatedAt: string;
    audit: CloudComplianceAuditInput;
  }
): Promise<CloudTenantSettings | null> {
  if (typeof input.localAiEnabled !== "boolean" || typeof input.mcpEnabled !== "boolean") {
    throw new TypeError("Tenant feature settings must be booleans");
  }
  const result = await db.batch([
    db
      .prepare(
        `UPDATE cloud_tenant_settings
            SET local_ai_enabled = ?, mcp_enabled = ?, updated_at = ?
          WHERE tenant_id = ?
            AND EXISTS (
              SELECT 1 FROM cloud_customer_memberships m
              JOIN cloud_customer_api_keys k
                ON k.tenant_id = m.tenant_id AND k.membership_id = m.id
              JOIN tenants t ON t.id = m.tenant_id
              WHERE m.tenant_id = cloud_tenant_settings.tenant_id
                AND m.id = ? AND m.is_active = 1 AND m.role IN ('owner', 'admin')
                AND k.id = ? AND k.revoked_at IS NULL
                AND (k.expires_at IS NULL OR k.expires_at > ?)
                AND t.kind = 'customer' AND t.is_active = 1
            )`
      )
      .bind(
        input.localAiEnabled ? 1 : 0,
        input.mcpEnabled ? 1 : 0,
        input.updatedAt,
        input.tenantId,
        input.membershipId,
        input.apiKeyId,
        input.updatedAt
      ),
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
