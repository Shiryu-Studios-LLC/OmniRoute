-- Tenant-owned OIDC registration and exact issuer+subject links to existing
-- customer memberships. This stores metadata only; the Worker does not use it
-- for login, issuer discovery, token verification, or session issuance.
CREATE TABLE IF NOT EXISTS cloud_tenant_oidc_configs (
  tenant_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 500),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 200),
  client_secret_encrypted TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '["openid","profile","email"]',
  is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_tenant_oidc_identities (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 500),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, issuer, subject),
  UNIQUE (tenant_id, membership_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES cloud_customer_memberships(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_tenant_oidc_identity_membership
  ON cloud_tenant_oidc_identities(tenant_id, membership_id);
