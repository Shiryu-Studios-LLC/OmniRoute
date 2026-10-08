-- Reasoning content is tenant-owned. Existing records predate tenant-aware
-- API keys, so preserve them under the platform tenant during migration.
CREATE TABLE reasoning_cache_tenant_migration (
  tenant_id      TEXT NOT NULL DEFAULT 'tenant_shiryu_admin',
  tool_call_id   TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  reasoning      TEXT NOT NULL,
  char_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, tool_call_id)
);

INSERT INTO reasoning_cache_tenant_migration
  (tenant_id, tool_call_id, provider, model, reasoning, char_count, created_at, expires_at)
SELECT 'tenant_shiryu_admin', tool_call_id, provider, model, reasoning,
       char_count, created_at, expires_at
  FROM reasoning_cache;

DROP TABLE reasoning_cache;
ALTER TABLE reasoning_cache_tenant_migration RENAME TO reasoning_cache;

CREATE INDEX IF NOT EXISTS idx_reasoning_cache_tenant_expires
  ON reasoning_cache(tenant_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_reasoning_cache_tenant_provider
  ON reasoning_cache(tenant_id, provider);
CREATE INDEX IF NOT EXISTS idx_reasoning_cache_tenant_model
  ON reasoning_cache(tenant_id, model);
CREATE INDEX IF NOT EXISTS idx_reasoning_cache_tenant_created
  ON reasoning_cache(tenant_id, created_at);
