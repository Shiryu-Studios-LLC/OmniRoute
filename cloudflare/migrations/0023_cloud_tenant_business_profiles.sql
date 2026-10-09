-- Tenant-owned, non-secret Front Desk business identity and assistant settings.
CREATE TABLE IF NOT EXISTS cloud_tenant_business_profiles (
  tenant_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  hours TEXT NOT NULL DEFAULT '' CHECK (length(hours) <= 250),
  services_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(services_json) AND length(services_json) <= 16384),
  assistant_name TEXT NOT NULL DEFAULT 'AI Front Desk' CHECK (length(assistant_name) BETWEEN 1 AND 100),
  assistant_tone TEXT NOT NULL DEFAULT 'friendly, concise, helpful' CHECK (length(assistant_tone) BETWEEN 1 AND 250),
  assistant_handoff TEXT NOT NULL DEFAULT 'Offer a human follow-up when needed.' CHECK (length(assistant_handoff) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS cloud_customer_business_profile_after_insert
AFTER INSERT ON tenants
WHEN NEW.kind = 'customer'
BEGIN
  INSERT OR IGNORE INTO cloud_tenant_business_profiles (tenant_id, name, created_at, updated_at)
  VALUES (NEW.id, NEW.name, NEW.created_at, NEW.updated_at);
END;

INSERT OR IGNORE INTO cloud_tenant_business_profiles (tenant_id, name, created_at, updated_at)
SELECT id, name, created_at, updated_at FROM tenants WHERE kind = 'customer';
