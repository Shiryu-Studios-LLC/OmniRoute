-- Tenant-owned device credentials and advertised gateway capabilities.
CREATE TABLE IF NOT EXISTS cloud_gateway_devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_gateway_devices_tenant_active
  ON cloud_gateway_devices(tenant_id, revoked_at, id);
