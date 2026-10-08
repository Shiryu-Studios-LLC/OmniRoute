-- Tenant onboarding preferences. Feature access remains opt-in until an
-- administrator explicitly enables it; this table stores no credentials.
CREATE TABLE IF NOT EXISTS cloud_tenant_settings (
  tenant_id TEXT PRIMARY KEY,
  local_ai_enabled INTEGER NOT NULL DEFAULT 0 CHECK (local_ai_enabled IN (0, 1)),
  mcp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mcp_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- A trigger keeps settings initialization in the same SQLite/D1 transaction as
-- tenant creation, including all existing tenant creation paths.
CREATE TRIGGER IF NOT EXISTS cloud_customer_tenant_settings_after_insert
AFTER INSERT ON tenants
WHEN NEW.kind = 'customer'
BEGIN
  INSERT OR IGNORE INTO cloud_tenant_settings (tenant_id, created_at, updated_at)
  VALUES (NEW.id, NEW.created_at, NEW.updated_at);
END;

-- Backfill customer tenants that predate this migration.
INSERT OR IGNORE INTO cloud_tenant_settings (tenant_id, created_at, updated_at)
SELECT id, created_at, updated_at FROM tenants WHERE kind = 'customer';
