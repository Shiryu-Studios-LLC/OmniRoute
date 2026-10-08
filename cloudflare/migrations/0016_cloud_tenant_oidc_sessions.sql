-- Short-lived OIDC authorization transactions and revocable customer portal
-- sessions. Session tokens and state values are stored only as SHA-256 hashes;
-- PKCE verifiers are encrypted with the tenant-bound credential envelope.
CREATE TABLE IF NOT EXISTS cloud_tenant_oidc_login_states (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash) = 64),
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  jwks_uri TEXT NOT NULL,
  signing_algorithms_json TEXT NOT NULL,
  nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64),
  code_verifier_encrypted TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_tenant_oidc_login_state_expiry
  ON cloud_tenant_oidc_login_states(expires_at_ms, consumed_at_ms);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_tenant_oidc_identity_tenant_id
  ON cloud_tenant_oidc_identities(tenant_id, id);

CREATE TABLE IF NOT EXISTS cloud_tenant_oidc_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES cloud_customer_memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES cloud_tenant_oidc_identities(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_tenant_oidc_session_expiry
  ON cloud_tenant_oidc_sessions(expires_at_ms, revoked_at_ms);
CREATE INDEX IF NOT EXISTS idx_cloud_tenant_oidc_session_membership
  ON cloud_tenant_oidc_sessions(tenant_id, membership_id, expires_at_ms);
