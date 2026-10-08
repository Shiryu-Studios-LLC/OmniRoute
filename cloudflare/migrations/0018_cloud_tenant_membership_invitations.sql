-- Short-lived, single-use invites for customer members verified by tenant OIDC.
CREATE TABLE IF NOT EXISTS cloud_tenant_membership_invitations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 500),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  issued_by_membership_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  consumed_nonce TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, issued_by_membership_id)
    REFERENCES cloud_customer_memberships(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_tenant_membership_invitation_expiry
  ON cloud_tenant_membership_invitations(expires_at_ms, consumed_at_ms);
CREATE INDEX IF NOT EXISTS idx_cloud_tenant_membership_invitation_issuer
  ON cloud_tenant_membership_invitations(tenant_id, issuer, expires_at_ms);

ALTER TABLE cloud_tenant_oidc_login_states ADD COLUMN invitation_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_cloud_tenant_oidc_login_state_invitation
  ON cloud_tenant_oidc_login_states(invitation_hash) WHERE invitation_hash IS NOT NULL;
