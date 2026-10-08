-- Attach existing quota pools to the Shiryu platform tenant. Pool membership
-- and allocations inherit their tenant through quota_pools. Runtime queries
-- always select the pool row through this tenant_id boundary first.
ALTER TABLE quota_pools
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';

CREATE INDEX IF NOT EXISTS idx_quota_pools_tenant_group
  ON quota_pools(tenant_id, group_id, created_at);
