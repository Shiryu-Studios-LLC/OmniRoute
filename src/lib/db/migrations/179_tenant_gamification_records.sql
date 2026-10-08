-- Gamification records keyed by API keys are tenant-owned. Built-in badge
-- definitions and community-server federation configuration remain instance-wide.
ALTER TABLE leaderboard ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';
ALTER TABLE user_levels ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';
ALTER TABLE user_badges ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';
ALTER TABLE xp_audit_log ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';
ALTER TABLE token_ledger ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';
ALTER TABLE invite_tokens ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';
ALTER TABLE invite_tokens ADD COLUMN used_by_tenant_id TEXT;

UPDATE leaderboard
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM api_keys WHERE api_keys.id = leaderboard.api_key_id),
  'tenant_shiryu_admin'
);
UPDATE user_levels
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM api_keys WHERE api_keys.id = user_levels.api_key_id),
  'tenant_shiryu_admin'
);
UPDATE user_badges
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM api_keys WHERE api_keys.id = user_badges.api_key_id),
  'tenant_shiryu_admin'
);
UPDATE xp_audit_log
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM api_keys WHERE api_keys.id = xp_audit_log.api_key_id),
  'tenant_shiryu_admin'
);
UPDATE token_ledger
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM api_keys WHERE api_keys.id = token_ledger.from_api_key_id),
  (SELECT tenant_id FROM api_keys WHERE api_keys.id = token_ledger.to_api_key_id),
  'tenant_shiryu_admin'
);
UPDATE invite_tokens
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM api_keys WHERE api_keys.id = invite_tokens.created_by),
  'tenant_shiryu_admin'
);
UPDATE invite_tokens
SET used_by_tenant_id = (
  SELECT tenant_id FROM api_keys WHERE api_keys.id = invite_tokens.used_by
)
WHERE used_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leaderboard_tenant_scope_score
  ON leaderboard(tenant_id, scope, score DESC, api_key_id);
CREATE INDEX IF NOT EXISTS idx_user_levels_tenant ON user_levels(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_tenant ON user_badges(tenant_id, api_key_id);
CREATE INDEX IF NOT EXISTS idx_xp_audit_tenant_key_created
  ON xp_audit_log(tenant_id, api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_token_ledger_tenant_created
  ON token_ledger(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_tenant_owner
  ON invite_tokens(tenant_id, created_by, created_at);
