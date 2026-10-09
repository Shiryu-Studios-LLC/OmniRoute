-- Short-lived metadata for asynchronous customer-local image generation.
-- Image bytes live only in the private Worker-bound R2 bucket.
CREATE TABLE IF NOT EXISTS cloud_gateway_image_jobs (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) = 36),
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  idempotency_hash TEXT NOT NULL UNIQUE CHECK (length(idempotency_hash) = 64),
  fingerprint_hash TEXT NOT NULL CHECK (length(fingerprint_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  object_key TEXT NOT NULL UNIQUE,
  artifact_upload_token TEXT,
  artifact_content_type TEXT,
  artifact_bytes INTEGER,
  artifact_sha256 TEXT,
  prompt_id TEXT,
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('execution_failed', 'capability_unavailable', 'artifact_upload_failed', 'cancelled', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  retention_expires_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (expires_at > created_at),
  CHECK (retention_expires_at > expires_at),
  CHECK (
    (state = 'succeeded' AND artifact_content_type IS NOT NULL AND artifact_bytes IS NOT NULL AND artifact_sha256 IS NOT NULL AND prompt_id IS NOT NULL)
    OR state <> 'succeeded'
  ),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES cloud_gateway_devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_gateway_image_jobs_owner_retention
  ON cloud_gateway_image_jobs(tenant_id, principal_id, api_key_id, retention_expires_at);

CREATE INDEX IF NOT EXISTS idx_cloud_gateway_image_jobs_expiry
  ON cloud_gateway_image_jobs(state, expires_at, retention_expires_at);

CREATE INDEX IF NOT EXISTS idx_cloud_gateway_image_jobs_device
  ON cloud_gateway_image_jobs(device_id, state, created_at);

-- Bound long-running generations independently of the short HTTP invocation rate limit.
CREATE TRIGGER IF NOT EXISTS trg_cloud_gateway_image_jobs_active_tenant_cap
BEFORE INSERT ON cloud_gateway_image_jobs
WHEN NEW.state IN ('queued', 'running')
 AND NOT EXISTS (
   SELECT 1 FROM cloud_gateway_image_jobs WHERE idempotency_hash = NEW.idempotency_hash
 )
 AND (SELECT COUNT(*) FROM cloud_gateway_image_jobs
       WHERE tenant_id = NEW.tenant_id AND state IN ('queued', 'running')
         AND expires_at > NEW.created_at) >= 4
BEGIN
  SELECT RAISE(ABORT, 'gateway image job tenant capacity reached');
END;

CREATE TRIGGER IF NOT EXISTS trg_cloud_gateway_image_jobs_active_device_cap
BEFORE INSERT ON cloud_gateway_image_jobs
WHEN NEW.state IN ('queued', 'running')
 AND NOT EXISTS (
   SELECT 1 FROM cloud_gateway_image_jobs WHERE idempotency_hash = NEW.idempotency_hash
 )
 AND (SELECT COUNT(*) FROM cloud_gateway_image_jobs
       WHERE device_id = NEW.device_id AND state IN ('queued', 'running')
         AND expires_at > NEW.created_at) >= 2
BEGIN
  SELECT RAISE(ABORT, 'gateway image job device capacity reached');
END;

CREATE TRIGGER IF NOT EXISTS trg_cloud_gateway_image_jobs_tenant_retention_cap
BEFORE INSERT ON cloud_gateway_image_jobs
WHEN (SELECT COUNT(*) FROM cloud_gateway_image_jobs WHERE tenant_id = NEW.tenant_id) >= 256
 AND NOT EXISTS (
   SELECT 1 FROM cloud_gateway_image_jobs WHERE idempotency_hash = NEW.idempotency_hash
 )
BEGIN
  SELECT RAISE(ABORT, 'gateway image job tenant retention capacity reached');
END;

CREATE TRIGGER IF NOT EXISTS trg_cloud_gateway_image_jobs_global_retention_cap
BEFORE INSERT ON cloud_gateway_image_jobs
WHEN (SELECT COUNT(*) FROM cloud_gateway_image_jobs) >= 16384
 AND NOT EXISTS (
   SELECT 1 FROM cloud_gateway_image_jobs WHERE idempotency_hash = NEW.idempotency_hash
 )
BEGIN
  SELECT RAISE(ABORT, 'gateway image job global retention capacity reached');
END;
