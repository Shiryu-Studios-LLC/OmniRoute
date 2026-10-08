-- Keep detailed request payloads inside the tenant that generated them.
-- Existing rows belong to the original platform/admin tenant.
ALTER TABLE request_detail_logs
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';

CREATE INDEX IF NOT EXISTS idx_rdl_tenant_timestamp
  ON request_detail_logs(tenant_id, timestamp DESC);

-- Replace the old global ring buffer with one 500-row buffer per tenant.
DROP TRIGGER IF EXISTS trg_rdl_ring_buffer;

CREATE TRIGGER trg_rdl_ring_buffer
AFTER INSERT ON request_detail_logs
BEGIN
  DELETE FROM request_detail_logs
  WHERE tenant_id = NEW.tenant_id
    AND id IN (
      SELECT id
      FROM request_detail_logs
      WHERE tenant_id = NEW.tenant_id
      ORDER BY timestamp DESC, id DESC
      LIMIT -1 OFFSET 500
    );
END;
