-- Tenant-owned MCP endpoint configuration for the cloud management plane.
-- The Worker stores credentials but does not connect to these endpoints.
CREATE TABLE IF NOT EXISTS cloud_tenant_mcp_servers (
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  transport TEXT NOT NULL CHECK (transport IN ('sse', 'streamable_http')),
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  credential_encrypted TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_tenant_mcp_servers_active_name
  ON cloud_tenant_mcp_servers(tenant_id, is_active, name, id);
