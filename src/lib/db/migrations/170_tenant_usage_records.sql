-- Scope request and token usage history to the tenant that generated it.
-- Existing single-tenant history remains owned by the platform tenant.

ALTER TABLE call_logs ADD COLUMN tenant_id TEXT;
UPDATE call_logs
SET tenant_id = 'tenant_shiryu_admin'
WHERE tenant_id IS NULL OR trim(tenant_id) = '';
CREATE INDEX IF NOT EXISTS idx_call_logs_tenant_timestamp ON call_logs(tenant_id, timestamp);

ALTER TABLE usage_history ADD COLUMN tenant_id TEXT;
UPDATE usage_history
SET tenant_id = 'tenant_shiryu_admin'
WHERE tenant_id IS NULL OR trim(tenant_id) = '';
CREATE INDEX IF NOT EXISTS idx_usage_history_tenant_timestamp ON usage_history(tenant_id, timestamp);
