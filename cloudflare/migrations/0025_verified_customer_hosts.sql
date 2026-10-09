-- Verified customer hostnames used for exact Front Desk tenant resolution.
-- A row is written only through the platform-admin registration API after
-- hostname ownership has been verified out of band.
CREATE TABLE IF NOT EXISTS cloud_verified_customer_hosts (
  hostname TEXT PRIMARY KEY CHECK (length(hostname) BETWEEN 1 AND 253),
  tenant_id TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_verified_customer_hosts_tenant
  ON cloud_verified_customer_hosts(tenant_id, hostname);
