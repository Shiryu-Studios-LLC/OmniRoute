-- Model-to-combo routing rules are tenant-owned configuration. Existing rows
-- are retained under the legacy platform tenant, and request-time lookup is
-- indexed by tenant and priority.
ALTER TABLE model_combo_mappings
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';

UPDATE model_combo_mappings
SET tenant_id = 'tenant_shiryu_admin'
WHERE tenant_id IS NULL OR trim(tenant_id) = '';

CREATE INDEX IF NOT EXISTS idx_mcm_tenant_enabled_priority
  ON model_combo_mappings(tenant_id, enabled, priority DESC, created_at ASC);
