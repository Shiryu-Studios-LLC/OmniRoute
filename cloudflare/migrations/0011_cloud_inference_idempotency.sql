-- Inference idempotency keeps a compact tombstone for every accepted key.
-- Response bodies are cleared after their replay window, but the tombstone is
-- retained so an uncertain upstream operation cannot be dispatched twice during the configured retention window.
CREATE TABLE IF NOT EXISTS cloud_inference_idempotency (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  request_id TEXT NOT NULL UNIQUE,
  claim_token TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'completed', 'outcome_unavailable')),
  claimed_at_ms INTEGER NOT NULL,
  claim_expires_at_ms INTEGER,
  response_expires_at_ms INTEGER NOT NULL,
  response_status INTEGER,
  response_body TEXT CHECK (response_body IS NULL OR length(response_body) <= 131072),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, api_key_id, idempotency_key_hash),
  CHECK (
    (state = 'claimed' AND claim_token IS NOT NULL AND claim_expires_at_ms IS NOT NULL
      AND response_status IS NULL AND response_body IS NULL)
    OR (state = 'completed' AND claim_token IS NULL AND claim_expires_at_ms IS NULL
      AND response_status BETWEEN 200 AND 599 AND response_body IS NOT NULL)
    OR (state = 'outcome_unavailable' AND claim_token IS NULL AND claim_expires_at_ms IS NULL
      AND response_status IS NULL AND response_body IS NULL)
  ),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_cloud_inference_idempotency_response_expiry
  ON cloud_inference_idempotency(response_expires_at_ms, tenant_id, principal_id, api_key_id, idempotency_key_hash);

CREATE TRIGGER IF NOT EXISTS trg_cloud_inference_idempotency_tenant_cap
BEFORE INSERT ON cloud_inference_idempotency
WHEN (SELECT COUNT(*) FROM cloud_inference_idempotency WHERE tenant_id = NEW.tenant_id) >= 10000
 AND NOT EXISTS (
   SELECT 1 FROM cloud_inference_idempotency
    WHERE tenant_id = NEW.tenant_id AND principal_id = NEW.principal_id
      AND api_key_id = NEW.api_key_id AND idempotency_key_hash = NEW.idempotency_key_hash
 )
BEGIN
  SELECT RAISE(ABORT, 'cloud inference idempotency tenant capacity reached');
END;

CREATE TRIGGER IF NOT EXISTS trg_cloud_inference_idempotency_global_cap
BEFORE INSERT ON cloud_inference_idempotency
WHEN (SELECT COUNT(*) FROM cloud_inference_idempotency) >= 250000
 AND NOT EXISTS (
   SELECT 1 FROM cloud_inference_idempotency
    WHERE tenant_id = NEW.tenant_id AND principal_id = NEW.principal_id
      AND api_key_id = NEW.api_key_id AND idempotency_key_hash = NEW.idempotency_key_hash
 )
BEGIN
  SELECT RAISE(ABORT, 'cloud inference idempotency capacity reached');
END;
