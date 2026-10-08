-- Opt-in cloud inference policy and tenant-wide monthly token reservations.
-- This migration creates storage only; it does not enable any provider route.

CREATE TABLE IF NOT EXISTS cloud_inference_entitlements (
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  max_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (max_input_tokens >= 0),
  max_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (max_output_tokens >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider, model),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_inference_monthly_budgets (
  tenant_id TEXT PRIMARY KEY,
  monthly_token_limit INTEGER NOT NULL CHECK (monthly_token_limit >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Reservation rows are also the accounting ledger. A single conditional
-- INSERT ... SELECT atomically checks current entitlement, request caps, and
-- remaining tenant-month capacity before reserving tokens. No second counter
-- can drift away from this source of truth.
CREATE TABLE IF NOT EXISTS cloud_inference_reservations (
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  month_utc TEXT NOT NULL CHECK (length(month_utc) = 7),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens_reserved INTEGER NOT NULL CHECK (output_tokens_reserved >= 0),
  tokens_reserved INTEGER NOT NULL CHECK (tokens_reserved >= 0),
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  actual_tokens INTEGER,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, reservation_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CHECK (
    (status = 'reserved' AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL AND actual_tokens IS NULL)
    OR
    (status = 'settled' AND actual_input_tokens IS NOT NULL AND actual_output_tokens IS NOT NULL AND actual_tokens IS NOT NULL)
    OR
    (status = 'released' AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL AND actual_tokens IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_cloud_inference_reservations_tenant_month_status
  ON cloud_inference_reservations(tenant_id, month_utc, status);

CREATE INDEX IF NOT EXISTS idx_cloud_inference_reservations_stale
  ON cloud_inference_reservations(status, created_at, tenant_id, reservation_id);
