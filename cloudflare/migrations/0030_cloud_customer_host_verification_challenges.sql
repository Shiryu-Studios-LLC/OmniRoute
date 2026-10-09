-- Short-lived DNS ownership challenges for customer hostnames.
CREATE TABLE IF NOT EXISTS cloud_customer_host_verification_challenges (
  hostname TEXT PRIMARY KEY CHECK (length(hostname) BETWEEN 1 AND 253),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  challenge_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  CHECK (expires_at_ms > created_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_cloud_customer_host_challenges_expiry
  ON cloud_customer_host_verification_challenges(expires_at_ms, hostname);

-- Extend the maintenance ledger task constraint without changing deployed migrations.
CREATE TABLE cloud_maintenance_runs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL CHECK (
    task_key IN (
      'expired-rate-limits',
      'expired-gateway-pairings',
      'stale-inference-reservations',
      'settled-inference-reservations',
      'expired-inference-responses',
      'expired-oidc-artifacts',
      'expired-gateway-image-jobs',
      'expired-customer-host-challenges'
    )
  ),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER NOT NULL CHECK (finished_at_ms >= started_at_ms),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed'))
);

INSERT INTO cloud_maintenance_runs_new (
  id, task_key, started_at_ms, finished_at_ms, duration_ms, outcome
)
SELECT id, task_key, started_at_ms, finished_at_ms, duration_ms, outcome
FROM cloud_maintenance_runs;

DROP TABLE cloud_maintenance_runs;
ALTER TABLE cloud_maintenance_runs_new RENAME TO cloud_maintenance_runs;

CREATE INDEX idx_cloud_maintenance_runs_finished
  ON cloud_maintenance_runs(finished_at_ms, id);
