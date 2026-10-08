-- Tenant-owned customer OIDC configuration and verified external identity
-- mappings. This migration only adds persistence; the dashboard login flow
-- does not read these tables.
CREATE TABLE IF NOT EXISTS tenant_oidc_configs (
  tenant_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '["openid","profile","email"]',
  is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tenant_oidc_identities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, issuer, subject),
  UNIQUE (tenant_id, principal_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_oidc_identities_principal
  ON tenant_oidc_identities(tenant_id, principal_id);
