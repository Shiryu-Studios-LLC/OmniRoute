-- Keep stale-bucket cleanup bounded with an index on the rate-window start.
CREATE INDEX IF NOT EXISTS idx_cloud_rate_limits_window_end
  ON cloud_rate_limits(window_started_at_ms + window_ms, tenant_id, bucket_hash);
