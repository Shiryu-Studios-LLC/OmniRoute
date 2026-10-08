-- Token budgets are attached to API keys and must follow the owning tenant.
ALTER TABLE api_key_token_limits ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';

UPDATE api_key_token_limits
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM api_keys WHERE api_keys.id = api_key_token_limits.api_key_id),
  'tenant_shiryu_admin'
);

CREATE INDEX IF NOT EXISTS idx_aktl_tenant_key
  ON api_key_token_limits(tenant_id, api_key_id);
