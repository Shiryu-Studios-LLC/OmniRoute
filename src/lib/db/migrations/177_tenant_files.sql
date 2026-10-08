-- Give uploaded file records an explicit tenant boundary. Legacy files belong to
-- the tenant that owns their API key; unkeyed legacy files remain platform data.
ALTER TABLE files ADD COLUMN tenant_id TEXT;

UPDATE files
SET tenant_id = COALESCE(
  (SELECT api_keys.tenant_id FROM api_keys WHERE api_keys.id = files.api_key_id),
  'tenant_shiryu_admin'
)
WHERE tenant_id IS NULL OR trim(tenant_id) = '';

CREATE INDEX IF NOT EXISTS idx_files_tenant_created
  ON files(tenant_id, created_at DESC, id DESC);

-- Batch state and its checkpoints inherit the tenant boundary of the key that
-- submitted the batch, falling back to the input file for legacy unkeyed rows.
ALTER TABLE batches ADD COLUMN tenant_id TEXT;

UPDATE batches
SET tenant_id = COALESCE(
  (SELECT api_keys.tenant_id FROM api_keys WHERE api_keys.id = batches.api_key_id),
  (SELECT files.tenant_id FROM files WHERE files.id = batches.input_file_id),
  'tenant_shiryu_admin'
)
WHERE tenant_id IS NULL OR trim(tenant_id) = '';

CREATE INDEX IF NOT EXISTS idx_batches_tenant_status_created
  ON batches(tenant_id, status, created_at);
