-- Replace the global idempotency cap's full-table COUNT with a transactionally
-- maintained counter. Backfill makes this safe if migration 0011 already has
-- rows when this migration is applied.
CREATE TABLE IF NOT EXISTS cloud_inference_idempotency_capacity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  row_count INTEGER NOT NULL CHECK (row_count >= 0)
);

INSERT OR IGNORE INTO cloud_inference_idempotency_capacity (singleton_id, row_count)
SELECT 1, COUNT(*) FROM cloud_inference_idempotency;

DROP TRIGGER IF EXISTS trg_cloud_inference_idempotency_global_cap;
CREATE TRIGGER trg_cloud_inference_idempotency_global_cap
BEFORE INSERT ON cloud_inference_idempotency
WHEN (SELECT row_count FROM cloud_inference_idempotency_capacity WHERE singleton_id = 1) >= 250000
 AND NOT EXISTS (
   SELECT 1 FROM cloud_inference_idempotency
    WHERE tenant_id = NEW.tenant_id AND principal_id = NEW.principal_id
      AND api_key_id = NEW.api_key_id AND idempotency_key_hash = NEW.idempotency_key_hash
 )
BEGIN
  SELECT RAISE(ABORT, 'cloud inference idempotency capacity reached');
END;

CREATE TRIGGER IF NOT EXISTS trg_cloud_inference_idempotency_count_insert
AFTER INSERT ON cloud_inference_idempotency
BEGIN
  UPDATE cloud_inference_idempotency_capacity
     SET row_count = row_count + 1
   WHERE singleton_id = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_cloud_inference_idempotency_count_delete
AFTER DELETE ON cloud_inference_idempotency
BEGIN
  UPDATE cloud_inference_idempotency_capacity
     SET row_count = row_count - 1
   WHERE singleton_id = 1;
END;
