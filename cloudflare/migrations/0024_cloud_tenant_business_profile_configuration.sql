-- Distinguish a seeded default profile from one configured by a tenant owner/admin.
ALTER TABLE cloud_tenant_business_profiles ADD COLUMN configured_at TEXT;
