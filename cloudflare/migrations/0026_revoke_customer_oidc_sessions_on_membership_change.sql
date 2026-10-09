-- Bind OIDC session invalidation directly to a successful customer membership
-- privilege change. A rejected/stale CAS update cannot fire this trigger.
CREATE TRIGGER IF NOT EXISTS cloud_revoke_oidc_sessions_after_membership_change
AFTER UPDATE OF role, is_active ON cloud_customer_memberships
WHEN OLD.role <> NEW.role OR OLD.is_active <> NEW.is_active
BEGIN
  UPDATE cloud_tenant_oidc_sessions
     SET revoked_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE tenant_id = NEW.tenant_id
     AND membership_id = NEW.id
     AND revoked_at_ms IS NULL;
END;
