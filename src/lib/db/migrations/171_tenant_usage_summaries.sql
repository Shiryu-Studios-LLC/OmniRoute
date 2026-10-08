-- Keep retention aggregates separate for each tenant. Existing summary rows
-- came from the single-tenant runtime and therefore belong to the platform tenant.
ALTER TABLE daily_usage_summary ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';
ALTER TABLE hourly_usage_summary ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';

DROP INDEX IF EXISTS idx_daily_usage_unique;
DROP INDEX IF EXISTS idx_hourly_usage_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_usage_tenant_unique
  ON daily_usage_summary(tenant_id, provider, model, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hourly_usage_tenant_unique
  ON hourly_usage_summary(tenant_id, provider, model, date_hour);

CREATE INDEX IF NOT EXISTS idx_daily_usage_tenant_date
  ON daily_usage_summary(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_hourly_usage_tenant_date
  ON hourly_usage_summary(tenant_id, date_hour);

-- Quota snapshot rollups need a durable tenant owner even if their connection
-- is later removed. Legacy rows inherit their existing connection owner.
ALTER TABLE quota_snapshots ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';
UPDATE quota_snapshots
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM provider_connections WHERE provider_connections.id = quota_snapshots.connection_id),
  'tenant_shiryu_admin'
);
CREATE INDEX IF NOT EXISTS idx_quota_snapshots_tenant_created_at
  ON quota_snapshots(tenant_id, created_at);
