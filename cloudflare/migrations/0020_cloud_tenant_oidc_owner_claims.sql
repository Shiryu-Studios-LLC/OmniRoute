-- One-use platform-admin enrollment claims for a tenant's first verified OIDC owner.
-- A tenant can have at most one pending/consumed claim row; reissue replaces it.
CREATE TABLE IF NOT EXISTS cloud_tenant_oidc_owner_claims (
  tenant_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 500),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  consumed_nonce TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

ALTER TABLE cloud_tenant_oidc_login_states ADD COLUMN owner_bootstrap_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_cloud_tenant_oidc_login_state_owner_claim
  ON cloud_tenant_oidc_login_states(owner_bootstrap_hash)
  WHERE owner_bootstrap_hash IS NOT NULL;
