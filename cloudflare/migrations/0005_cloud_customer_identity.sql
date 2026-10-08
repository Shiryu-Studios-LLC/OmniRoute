-- D1-backed customer membership and tenant-scoped API key identity.
-- Secrets are never stored here; cloud_customer_api_keys contains SHA-256 hashes only.
CREATE TABLE IF NOT EXISTS cloud_customer_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, principal_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_customer_memberships_tenant_active
  ON cloud_customer_memberships(tenant_id, is_active, role);

CREATE TABLE IF NOT EXISTS cloud_customer_api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES cloud_customer_memberships(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_customer_api_keys_membership_active
  ON cloud_customer_api_keys(tenant_id, membership_id, revoked_at, expires_at);
