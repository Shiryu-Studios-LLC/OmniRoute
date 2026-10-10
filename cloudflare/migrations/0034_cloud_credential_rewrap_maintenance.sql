-- Record content-free counts for credential rewrap maintenance runs.
-- Rebuild the ledger to add the task key and preserve existing run history.
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
      'expired-customer-host-challenges',
      'rewrap-cloud-credentials'
    )
  ),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER NOT NULL CHECK (finished_at_ms >= started_at_ms),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  details_json TEXT CHECK (
    details_json IS NULL OR (json_valid(details_json) AND length(details_json) <= 512)
  )
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

CREATE TABLE IF NOT EXISTS cloud_credential_rewrap_cursors (
  active_key_id TEXT NOT NULL CHECK (length(active_key_id) BETWEEN 1 AND 64),
  credential_column TEXT NOT NULL CHECK (length(credential_column) BETWEEN 1 AND 96),
  last_rowid INTEGER NOT NULL CHECK (last_rowid >= 0),
  PRIMARY KEY (active_key_id, credential_column)
);
