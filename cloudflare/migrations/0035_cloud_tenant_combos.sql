-- Tenant-owned routing combo definitions. Runtime secrets and provider credentials
-- are deliberately excluded from this control-plane record.
CREATE TABLE IF NOT EXISTS cloud_tenant_combos (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  data_json TEXT NOT NULL CHECK (json_valid(data_json) AND length(data_json) <= 65536),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_tenant_combos_active
  ON cloud_tenant_combos(tenant_id, is_active, updated_at);
