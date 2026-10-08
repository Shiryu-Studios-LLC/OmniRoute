-- Tenant-global Idempotency-Key claims and bounded completed response replay.
CREATE TABLE IF NOT EXISTS cloud_gateway_idempotency (
  key_hash TEXT PRIMARY KEY CHECK (length(key_hash) = 64),
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  fingerprint_hash TEXT NOT NULL CHECK (length(fingerprint_hash) = 64),
  request_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  rate_limit_checked INTEGER NOT NULL DEFAULT 0 CHECK (rate_limit_checked IN (0, 1)),
  attempt_audited INTEGER NOT NULL DEFAULT 0 CHECK (attempt_audited IN (0, 1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claim_token TEXT,
  lease_expires_at TEXT,
  response_status INTEGER,
  response_json TEXT CHECK (response_json IS NULL OR length(response_json) <= 131072),
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'pending' AND response_status IS NULL AND response_json IS NULL)
    OR (
      state = 'completed'
      AND response_status IS NOT NULL
      AND response_status BETWEEN 200 AND 599
      AND response_json IS NOT NULL
    )
  ),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_gateway_idempotency_expiry
  ON cloud_gateway_idempotency(expires_at);

CREATE INDEX IF NOT EXISTS idx_cloud_gateway_idempotency_tenant_expiry
  ON cloud_gateway_idempotency(tenant_id, expires_at);

-- Hard caps keep stale rows or large tenants from growing this table without bound.
CREATE TRIGGER IF NOT EXISTS trg_cloud_gateway_idempotency_tenant_cap
BEFORE INSERT ON cloud_gateway_idempotency
WHEN (SELECT COUNT(*) FROM cloud_gateway_idempotency WHERE tenant_id = NEW.tenant_id) >= 128
BEGIN
  SELECT RAISE(ABORT, 'gateway idempotency tenant capacity reached');
END;

CREATE TRIGGER IF NOT EXISTS trg_cloud_gateway_idempotency_global_cap
BEFORE INSERT ON cloud_gateway_idempotency
WHEN (SELECT COUNT(*) FROM cloud_gateway_idempotency) >= 4096
BEGIN
  SELECT RAISE(ABORT, 'gateway idempotency capacity reached');
END;
