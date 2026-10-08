-- Provider quota windows belong to the tenant that owns their connection.
-- Rows without a surviving connection retain the legacy platform owner.
ALTER TABLE provider_quota_state
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';

UPDATE provider_quota_state
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM provider_connections
   WHERE provider_connections.id = provider_quota_state.connection_id),
  'tenant_shiryu_admin'
);

CREATE INDEX IF NOT EXISTS idx_provider_quota_state_tenant_reset
  ON provider_quota_state(tenant_id, window_reset);
CREATE INDEX IF NOT EXISTS idx_provider_quota_state_tenant_connection
  ON provider_quota_state(tenant_id, connection_id, model);
