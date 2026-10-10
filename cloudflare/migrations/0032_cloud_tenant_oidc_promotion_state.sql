-- Bind verified issuer-promotion callbacks to the active portal session and exact config revisions.
ALTER TABLE cloud_tenant_oidc_login_states
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'
  CHECK (purpose IN ('login', 'draft_promotion'));
ALTER TABLE cloud_tenant_oidc_login_states
  ADD COLUMN promotion_session_hash TEXT;
ALTER TABLE cloud_tenant_oidc_login_states
  ADD COLUMN promotion_membership_id TEXT;
ALTER TABLE cloud_tenant_oidc_login_states
  ADD COLUMN promotion_draft_updated_at TEXT;
ALTER TABLE cloud_tenant_oidc_login_states
  ADD COLUMN promotion_config_updated_at TEXT;
ALTER TABLE cloud_tenant_oidc_login_states
  ADD COLUMN promotion_other_identity_count INTEGER;
ALTER TABLE cloud_tenant_oidc_login_states
  ADD COLUMN promotion_applied_at_ms INTEGER;
