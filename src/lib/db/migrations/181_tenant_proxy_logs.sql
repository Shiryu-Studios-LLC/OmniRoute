-- Proxy request logs include customer connection identifiers, account names,
-- target URLs, and inbound/egress IPs, so retain them with their owner.
ALTER TABLE proxy_logs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';

UPDATE proxy_logs
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM provider_connections WHERE provider_connections.id = proxy_logs.connection_id),
  (SELECT tenant_id FROM combos WHERE combos.id = proxy_logs.combo_id),
  'tenant_shiryu_admin'
);

CREATE INDEX IF NOT EXISTS idx_pl_tenant_timestamp ON proxy_logs(tenant_id, timestamp DESC);
