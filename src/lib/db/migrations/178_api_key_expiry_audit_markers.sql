-- Remember each API key expiration instant that has been observed naturally.
-- The composite key makes concurrent validators share one durable claim.
CREATE TABLE IF NOT EXISTS api_key_expiry_audit_markers (
  tenant_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, api_key_id, expires_at),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);
