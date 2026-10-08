-- Short-lived one-time pairing grants for customer-managed Local Agents.
CREATE TABLE IF NOT EXISTS cloud_gateway_pairings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_nonce TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES cloud_customer_memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, api_key_id)
    REFERENCES cloud_customer_api_keys(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_gateway_pairings_expiry
  ON cloud_gateway_pairings(expires_at, consumed_at);
