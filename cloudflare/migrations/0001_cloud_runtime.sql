-- Minimal D1 schema for the isolated cloud tenant/provider CRUD runtime.
-- This is intentionally separate from the local SQLite migration chain.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'customer'
    CHECK (kind IN ('platform_admin', 'customer')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_type TEXT,
  name TEXT,
  email TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  token_expires_at TEXT,
  scope TEXT,
  project_id TEXT,
  test_status TEXT,
  error_code TEXT,
  last_error TEXT,
  last_error_at TEXT,
  api_key TEXT,
  id_token TEXT,
  provider_specific_data TEXT,
  expires_in INTEGER,
  display_name TEXT,
  global_priority INTEGER,
  default_model TEXT,
  token_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_pc_tenant_provider
  ON provider_connections(tenant_id, provider, priority, updated_at);

CREATE TABLE IF NOT EXISTS provider_nodes (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT,
  api_type TEXT,
  base_url TEXT,
  chat_path TEXT,
  models_path TEXT,
  icon_url TEXT,
  custom_headers_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_pn_tenant_name
  ON provider_nodes(tenant_id, name);
