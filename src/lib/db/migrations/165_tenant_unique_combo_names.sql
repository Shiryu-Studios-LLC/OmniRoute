-- Preserve every existing combo while allowing separate tenants to use the
-- same display name. SQLite cannot DROP a table-level UNIQUE constraint; the
-- table must be rebuilt. The migration runner applies this SQL transactionally.
-- OmniRoute's SQLite runtime does not enable foreign_keys (see migration 126).
CREATE TABLE combos_tenant_rebuild (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  system_message TEXT DEFAULT NULL,
  tool_filter_regex TEXT DEFAULT NULL,
  context_cache_protection INTEGER DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin',
  UNIQUE (tenant_id, name)
);

INSERT INTO combos_tenant_rebuild (
  id, name, data, created_at, updated_at,
  system_message, tool_filter_regex, context_cache_protection, sort_order, tenant_id
)
SELECT
  id, name, data, created_at, updated_at,
  system_message, tool_filter_regex, context_cache_protection, sort_order,
  COALESCE(NULLIF(TRIM(tenant_id), ''), 'tenant_shiryu_admin')
FROM combos;

DROP TABLE combos;
ALTER TABLE combos_tenant_rebuild RENAME TO combos;

CREATE INDEX IF NOT EXISTS idx_combos_cache_protection ON combos(context_cache_protection);
CREATE INDEX IF NOT EXISTS idx_combos_tenant ON combos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_combos_tenant_sort ON combos(tenant_id, sort_order);

-- DROP TABLE removes the old AFTER DELETE trigger. Recreate it explicitly.
CREATE TRIGGER IF NOT EXISTS trg_reasoning_rules_combo_delete
AFTER DELETE ON combos BEGIN
  DELETE FROM reasoning_routing_rules WHERE combo_id = OLD.id OR target_combo_id = OLD.id;
END;
