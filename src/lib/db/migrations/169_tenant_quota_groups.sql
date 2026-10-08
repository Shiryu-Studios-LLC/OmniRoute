-- Quota group names and lifecycle are tenant-owned. The stable demo group is
-- retained for every tenant as a public default selector; all existing groups
-- are assigned to the Shiryu platform tenant.
ALTER TABLE quota_groups
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';

CREATE INDEX IF NOT EXISTS idx_quota_groups_tenant_created
  ON quota_groups(tenant_id, created_at);
