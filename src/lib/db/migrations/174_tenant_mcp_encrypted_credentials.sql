-- Keep per-server remote MCP credentials separate from public connection
-- metadata. Application writes require STORAGE_ENCRYPTION_KEY and store only
-- AES-256-GCM ciphertext in this column.
ALTER TABLE tenant_mcp_servers ADD COLUMN credential_encrypted TEXT;
