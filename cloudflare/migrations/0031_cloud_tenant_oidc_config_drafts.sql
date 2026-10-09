-- Customer-authored OIDC setup drafts. These values are intentionally separate
-- from active login configuration and are never used for outbound OIDC requests.
CREATE TABLE IF NOT EXISTS cloud_tenant_oidc_config_drafts (
  tenant_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 500),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 200),
  client_secret_encrypted TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '["openid","profile","email"]',
  created_by_membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES cloud_customer_memberships(tenant_id, id) ON DELETE CASCADE
);
