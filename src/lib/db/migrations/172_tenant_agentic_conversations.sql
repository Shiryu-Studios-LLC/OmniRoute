-- Conversation roots own their identity and transcript under exactly one
-- tenant. Existing single-tenant conversations remain in the platform tenant.
ALTER TABLE agentic_conversations
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_shiryu_admin';

CREATE INDEX IF NOT EXISTS idx_agentic_conversations_tenant_fingerprint
  ON agentic_conversations(tenant_id, fingerprint_hash, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_agentic_conversations_tenant_seen
  ON agentic_conversations(tenant_id, last_seen_at);
