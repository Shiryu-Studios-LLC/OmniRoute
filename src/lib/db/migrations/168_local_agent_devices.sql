CREATE TABLE IF NOT EXISTS local_agent_devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline'
    CHECK (status IN ('online', 'busy', 'offline')),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_local_agent_devices_tenant_created
  ON local_agent_devices(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS local_agent_heartbeat_nonces (
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, device_id, nonce),
  FOREIGN KEY (device_id) REFERENCES local_agent_devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_local_agent_nonces_expiry
  ON local_agent_heartbeat_nonces(expires_at);
