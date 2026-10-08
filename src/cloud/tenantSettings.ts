import type { CloudDb } from "./db";

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
