-- Extend the maintenance ledger CHECK constraint without modifying the already
-- deployed 0021 migration. Preserve existing run history while rebuilding the
-- table with the additional scheduled task key.
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
      'expired-gateway-image-jobs'
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
