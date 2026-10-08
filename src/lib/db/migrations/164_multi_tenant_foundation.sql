-- 164_multi_tenant_foundation.sql
-- Establishes the tenant boundary while preserving the existing installation as
-- the Shiryu platform/admin tenant. Existing customer-facing state is backfilled
-- into that tenant so this migration is non-destructive.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'customer'
    CHECK (kind IN ('platform_admin', 'customer')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner'
    CHECK (role IN ('owner', 'admin', 'member', 'maintenance')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, principal_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant ON tenant_members(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_members_principal ON tenant_members(principal_id);

INSERT OR IGNORE INTO tenants (
  id, name, slug, kind, is_active, created_at, updated_at
) VALUES (
  'tenant_shiryu_admin',
  'Shiryu Studios',
  'shiryu-admin',
  'platform_admin',
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO tenant_members (
  id, tenant_id, principal_id, role, created_at, updated_at
) VALUES (
  'member_shiryu_dashboard_admin',
  'tenant_shiryu_admin',
  'dashboard',
  'owner',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

ALTER TABLE api_keys ADD COLUMN tenant_id TEXT;
UPDATE api_keys SET tenant_id = 'tenant_shiryu_admin' WHERE tenant_id IS NULL OR trim(tenant_id) = '';
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);

ALTER TABLE provider_connections ADD COLUMN tenant_id TEXT;
UPDATE provider_connections
SET tenant_id = 'tenant_shiryu_admin'
WHERE tenant_id IS NULL OR trim(tenant_id) = '';
CREATE INDEX IF NOT EXISTS idx_pc_tenant ON provider_connections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pc_tenant_provider ON provider_connections(tenant_id, provider);

ALTER TABLE provider_nodes ADD COLUMN tenant_id TEXT;
UPDATE provider_nodes
SET tenant_id = 'tenant_shiryu_admin'
WHERE tenant_id IS NULL OR trim(tenant_id) = '';
CREATE INDEX IF NOT EXISTS idx_pn_tenant ON provider_nodes(tenant_id);

ALTER TABLE combos ADD COLUMN tenant_id TEXT;
UPDATE combos
SET tenant_id = 'tenant_shiryu_admin'
WHERE tenant_id IS NULL OR trim(tenant_id) = '';
CREATE INDEX IF NOT EXISTS idx_combos_tenant ON combos(tenant_id);

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tenant_mcp_servers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('sse', 'streamable_http', 'stdio')),
  endpoint TEXT,
  command TEXT,
  args_json TEXT,
  headers_json TEXT,
  environment_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_mcp_servers_tenant ON tenant_mcp_servers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_mcp_servers_active ON tenant_mcp_servers(tenant_id, is_active);
