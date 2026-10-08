-- Scope recorded quota reset windows to the provider connection's tenant.
ALTER TABLE provider_quota_reset_events
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';

UPDATE provider_quota_reset_events
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM provider_connections
   WHERE provider_connections.id = provider_quota_reset_events.connection_id),
  'tenant_shiryu_admin'
)
WHERE tenant_id IS NULL OR trim(tenant_id) = '' OR tenant_id = 'tenant_shiryu_admin';

CREATE INDEX IF NOT EXISTS idx_provider_quota_reset_events_tenant_connection_window
  ON provider_quota_reset_events(tenant_id, connection_id, window_key, window_resets_at);
