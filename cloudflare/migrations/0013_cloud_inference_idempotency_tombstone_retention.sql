-- Keep compact idempotency tombstones for 30 days after first claim. Response
-- payloads have a separate 24-hour replay window. Keys may be reused after the
-- tombstone retention period, so duplicate-dispatch protection is bounded to
-- that documented period.
ALTER TABLE cloud_inference_idempotency
  ADD COLUMN tombstone_expires_at_ms INTEGER NOT NULL DEFAULT 0;

UPDATE cloud_inference_idempotency
   SET tombstone_expires_at_ms = created_at_ms + 2592000000
 WHERE tombstone_expires_at_ms = 0;

CREATE INDEX IF NOT EXISTS idx_cloud_inference_idempotency_tombstone_expiry
  ON cloud_inference_idempotency(
    tombstone_expires_at_ms, tenant_id, principal_id, api_key_id, idempotency_key_hash
  );
