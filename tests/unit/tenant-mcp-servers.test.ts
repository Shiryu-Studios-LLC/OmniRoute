import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tenant-mcp-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.STORAGE_ENCRYPTION_KEY = "tenant-mcp-unit-test-encryption-key";

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const mcpServers = await import("../../src/lib/db/tenantMcpServers.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function createTenants() {
  const now = new Date().toISOString();
  const insert = core.getDbInstance().prepare(
    `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'customer', 1, ?, ?)`
  );
  insert.run("tenant_a", "Tenant A", "tenant-a", now, now);
  insert.run("tenant_b", "Tenant B", "tenant-b", now, now);
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("MCP server CRUD and discovery are isolated by tenant", () => {
  createTenants();
  const serverA = asTenant("tenant_a", () =>
    mcpServers.createTenantMcpServer({
      name: "Support tools",
      transport: "streamable_http",
      endpoint: "https://mcp-a.example.com/mcp",
    })
  );
  const serverB = asTenant("tenant_b", () =>
    mcpServers.createTenantMcpServer({
      name: "Support tools",
      transport: "sse",
      endpoint: "https://mcp-b.example.com/events",
    })
  );

  assert.notEqual(serverA.id, serverB.id);
  assert.equal(serverA.tenantId, "tenant_a");
  assert.equal(serverB.tenantId, "tenant_b");
  assert.deepEqual(
    asTenant("tenant_a", () => mcpServers.discoverTenantMcpServers()),
    [serverA]
  );
  assert.deepEqual(
    asTenant("tenant_b", () => mcpServers.discoverTenantMcpServers()),
    [serverB]
  );
  assert.equal(
    asTenant("tenant_b", () => mcpServers.getTenantMcpServerById(serverA.id)),
    null
  );
  assert.equal(
    asTenant("tenant_b", () => mcpServers.updateTenantMcpServer(serverA.id, { name: "stolen" })),
    null
  );
  assert.equal(
    asTenant("tenant_b", () => mcpServers.deleteTenantMcpServer(serverA.id)),
    false
  );
  assert.equal(
    asTenant("tenant_a", () => mcpServers.getTenantMcpServerById(serverA.id))?.name,
    "Support tools"
  );

  const updated = asTenant("tenant_a", () =>
    mcpServers.updateTenantMcpServer(serverA.id, { name: "Updated tools", isActive: false })
  );
  assert.equal(updated?.name, "Updated tools");
  assert.equal(updated?.isActive, false);
  assert.deepEqual(
    asTenant("tenant_a", () => mcpServers.discoverTenantMcpServers()),
    []
  );
  assert.equal(
    asTenant("tenant_a", () => mcpServers.getTenantMcpServers({ includeInactive: true })).length,
    1
  );
  assert.equal(
    asTenant("tenant_a", () => mcpServers.deleteTenantMcpServer(serverA.id)),
    true
  );
  assert.equal(
    asTenant("tenant_a", () => mcpServers.getTenantMcpServerById(serverA.id)),
    null
  );
});

test("MCP tenant config accepts only cloud-safe HTTP transports and HTTPS endpoints", () => {
  createTenants();
  const add = (values: Record<string, unknown>) =>
    asTenant("tenant_a", () =>
      mcpServers.createTenantMcpServer({
        name: "Remote tools",
        transport: "streamable_http",
        endpoint: "https://mcp.example.com/mcp",
        ...values,
      } as mcpServers.CreateTenantMcpServerInput)
    );

  assert.throws(() => add({ transport: "stdio" }), /Invalid option|expected/i);
  assert.throws(() => add({ endpoint: "http://mcp.example.com/mcp" }), /HTTPS URL/i);
  assert.throws(() => add({ endpoint: "https://user:password@mcp.example.com/mcp" }), /HTTPS URL/i);
  assert.throws(() => add({ endpoint: "https://mcp.example.com/mcp?token=secret" }), /HTTPS URL/i);
  assert.throws(() => add({ headers: { Authorization: "Bearer secret" } }), /Unrecognized key/i);
  assert.throws(
    () =>
      asTenant("tenant_b", () =>
        mcpServers.createTenantMcpServer({
          tenantId: "tenant_a",
          name: "Spoofed",
          transport: "sse",
          endpoint: "https://mcp.example.com/events",
        })
      ),
    /cross-tenant database operation denied/i
  );
});

test("MCP credentials are encrypted at rest and readable only in the owning tenant context", () => {
  createTenants();
  const credential = "mcp-secret-token-for-tenant-a";
  const serverA = asTenant("tenant_a", () =>
    mcpServers.createTenantMcpServer({
      name: "Credentialed tools",
      transport: "streamable_http",
      endpoint: "https://mcp-a.example.com/mcp",
      credential,
    })
  );

  assert.equal("credential" in serverA, false);
  assert.equal("credentialEncrypted" in serverA, false);
  const stored = core
    .getDbInstance()
    .prepare("SELECT credential_encrypted FROM tenant_mcp_servers WHERE id = ?")
    .get(serverA.id) as { credential_encrypted: string };
  assert.match(stored.credential_encrypted, /^enc:v1:/);
  assert.equal(stored.credential_encrypted.includes(credential), false);
  assert.equal(
    asTenant("tenant_a", () => mcpServers.getTenantMcpServerCredential(serverA.id)),
    credential
  );
  assert.equal(
    asTenant("tenant_b", () => mcpServers.getTenantMcpServerCredential(serverA.id)),
    null
  );

  const rotated = "rotated-mcp-secret";
  const updated = asTenant("tenant_a", () =>
    mcpServers.updateTenantMcpServer(serverA.id, { credential: rotated })
  );
  assert.equal(updated && "credential" in updated, false);
  assert.equal(
    asTenant("tenant_a", () => mcpServers.getTenantMcpServerCredential(serverA.id)),
    rotated
  );
  asTenant("tenant_a", () => mcpServers.updateTenantMcpServer(serverA.id, { credential: null }));
  assert.equal(
    asTenant("tenant_a", () => mcpServers.getTenantMcpServerCredential(serverA.id)),
    null
  );
});

test("MCP credential writes fail closed when storage encryption is unavailable", () => {
  createTenants();
  const encryptionKey = process.env.STORAGE_ENCRYPTION_KEY;
  delete process.env.STORAGE_ENCRYPTION_KEY;
  try {
    assert.throws(
      () =>
        asTenant("tenant_a", () =>
          mcpServers.createTenantMcpServer({
            name: "Credentialed tools",
            transport: "streamable_http",
            endpoint: "https://mcp-a.example.com/mcp",
            credential: "must-not-be-stored-plaintext",
          })
        ),
      /STORAGE_ENCRYPTION_KEY/i
    );
  } finally {
    process.env.STORAGE_ENCRYPTION_KEY = encryptionKey;
  }
  assert.equal(asTenant("tenant_a", () => mcpServers.getTenantMcpServers()).length, 0);
});

test("legacy stdio and malformed MCP rows are omitted from tenant discovery", () => {
  createTenants();
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO tenant_mcp_servers
      (id, tenant_id, name, transport, endpoint, command, args_json, headers_json,
       environment_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, ?, ?)`
  ).run(
    "legacy-stdio",
    "tenant_a",
    "Local process",
    "stdio",
    null,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z"
  );
  db.prepare(
    `INSERT INTO tenant_mcp_servers
      (id, tenant_id, name, transport, endpoint, command, args_json, headers_json,
       environment_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, ?, ?)`
  ).run(
    "legacy-http",
    "tenant_a",
    "Insecure endpoint",
    "sse",
    "http://mcp.example.com/events",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z"
  );

  assert.deepEqual(
    asTenant("tenant_a", () => mcpServers.discoverTenantMcpServers()),
    []
  );
  assert.equal(
    asTenant("tenant_a", () => mcpServers.getTenantMcpServerById("legacy-stdio")),
    null
  );
  assert.equal(
    asTenant("tenant_a", () => mcpServers.getTenantMcpServerById("legacy-http")),
    null
  );
});
