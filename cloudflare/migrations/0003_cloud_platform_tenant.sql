-- Stable owner scope for privileged cloud control-plane request accounting.
-- INSERT OR IGNORE preserves any pre-existing row and never changes tenant data.
INSERT OR IGNORE INTO tenants (
  id,
  name,
  slug,
  kind,
  is_active,
  created_at,
  updated_at
) VALUES (
  'tenant_shiryu_admin',
  'Shiryu Studios Platform',
  'shiryu-platform-admin',
  'platform_admin',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
