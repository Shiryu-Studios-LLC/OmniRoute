CREATE TABLE IF NOT EXISTS cloud_maintenance_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL CHECK (
    task_key IN (
      'expired-rate-limits',
      'expired-gateway-pairings',
      'stale-inference-reservations',
      'settled-inference-reservations',
      'expired-inference-responses',
      'expired-oidc-artifacts'
    )
  ),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER NOT NULL CHECK (finished_at_ms >= started_at_ms),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_maintenance_runs_finished
  ON cloud_maintenance_runs(finished_at_ms, id);
