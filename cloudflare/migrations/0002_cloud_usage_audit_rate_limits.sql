-- Tenant-isolated usage, compliance audit, and atomic D1 rate-limit state.

CREATE TABLE IF NOT EXISTS cloud_usage_history (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  connection_id TEXT,
  api_key_id TEXT,
  api_key_name TEXT,
  tokens_input INTEGER NOT NULL DEFAULT 0 CHECK (tokens_input >= 0),
  tokens_output INTEGER NOT NULL DEFAULT 0 CHECK (tokens_output >= 0),
  tokens_cache_read INTEGER NOT NULL DEFAULT 0 CHECK (tokens_cache_read >= 0),
  tokens_cache_creation INTEGER NOT NULL DEFAULT 0 CHECK (tokens_cache_creation >= 0),
  tokens_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (tokens_reasoning >= 0),
  service_tier TEXT NOT NULL DEFAULT 'standard',
  status TEXT,
  success INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0, 1)),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  ttft_ms INTEGER NOT NULL DEFAULT 0 CHECK (ttft_ms >= 0),
  error_code TEXT,
  combo_strategy TEXT,
  endpoint TEXT,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_usage_tenant_time
  ON cloud_usage_history(tenant_id, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_cloud_usage_tenant_provider_time
  ON cloud_usage_history(tenant_id, provider, timestamp DESC);

CREATE TABLE IF NOT EXISTS cloud_compliance_audit (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  target TEXT,
  details_json TEXT,
  ip_address TEXT,
  resource_type TEXT,
  status TEXT,
  request_id TEXT,
  metadata_json TEXT,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_audit_tenant_time
  ON cloud_compliance_audit(tenant_id, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_cloud_audit_tenant_action_time
  ON cloud_compliance_audit(tenant_id, action, timestamp DESC);

CREATE TABLE IF NOT EXISTS cloud_rate_limits (
  tenant_id TEXT NOT NULL,
  bucket_hash TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  window_ms INTEGER NOT NULL CHECK (window_ms > 0),
  limit_count INTEGER NOT NULL CHECK (limit_count > 0),
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, bucket_hash),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
