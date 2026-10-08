-- Keep the reservation ledger bounded without changing current-month accounting
-- or deleting active requests. Usage history remains the long-term record.
CREATE INDEX IF NOT EXISTS idx_cloud_inference_reservations_retention
  ON cloud_inference_reservations(month_utc, created_at, status, tenant_id, reservation_id);
