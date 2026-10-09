-- Encrypted Front Desk runtime credentials and tenant-specific connection settings.
-- A config exists only for a platform-verified customer hostname.
CREATE TABLE IF NOT EXISTS cloud_frontdesk_configs (
  hostname TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  customer_api_key_encrypted TEXT NOT NULL,
  dashboard_token_encrypted TEXT NOT NULL,
  gateway_base_url TEXT NOT NULL,
  device_id TEXT NOT NULL,
  ollama_model TEXT NOT NULL,
  image_generation_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (hostname) REFERENCES cloud_verified_customer_hosts(hostname) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_frontdesk_configs_tenant_hostname
  ON cloud_frontdesk_configs(tenant_id, hostname);
