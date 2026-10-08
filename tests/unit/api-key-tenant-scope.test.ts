import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-api-key-tenants-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-tenant-scope-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const { getTenantContext, runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const { enterApiKeyTenantContext } = await import("../../src/server/authz/tenantMembership.ts");

async function reset() {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at) VALUES (?, ?, ?, 'customer', 1, ?, ?)"
  ).run("tenant_a", "Tenant A", "tenant-a", now, now);
  db.prepare(
    "INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at) VALUES (?, ?, ?, 'customer', 1, ?, ?)"
  ).run("tenant_b", "Tenant B", "tenant-b", now, now);
}

test.beforeEach(reset);
test.after(() => {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("API key lifecycle is scoped to the authenticated tenant", async () => {
  const keyA = await runWithTenantContext({ tenantId: "tenant_a", principalId: "owner-a" }, () =>
    apiKeys.createApiKey("Tenant A key", "machine-a")
  );
  const keyB = await runWithTenantContext({ tenantId: "tenant_b", principalId: "owner-b" }, () =>
    apiKeys.createApiKey("Tenant B key", "machine-b")
  );

  assert.equal(keyA.tenantId, "tenant_a");
  assert.equal(keyB.tenantId, "tenant_b");
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO tenant_members (id, tenant_id, principal_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run("member-a", "tenant_a", keyA.id, "maintenance", now, now);
  assert.deepEqual(enterApiKeyTenantContext("tenant_a", keyA.id), {
    tenantId: "tenant_a",
    principalId: keyA.id,
    role: "maintenance",
  });
  assert.equal(getTenantContext()?.role, "maintenance");

  assert.deepEqual(
    (await runWithTenantContext({ tenantId: "tenant_a" }, () => apiKeys.getApiKeys())).map(
      (key) => key.id
    ),
    [keyA.id]
  );
  assert.equal(
    await runWithTenantContext({ tenantId: "tenant_a" }, () => apiKeys.getApiKeysCount()),
    1
  );
  assert.equal(
    await runWithTenantContext({ tenantId: "tenant_a" }, () => apiKeys.getApiKeyById(keyB.id)),
    null
  );

  assert.equal(
    await runWithTenantContext({ tenantId: "tenant_a" }, () =>
      apiKeys.updateApiKeyPermissions(keyB.id, { name: "stolen" })
    ),
    false
  );
  assert.equal(
    await runWithTenantContext({ tenantId: "tenant_a" }, () => apiKeys.regenerateApiKey(keyB.id)),
    null
  );
  assert.equal(
    await runWithTenantContext({ tenantId: "tenant_a" }, () => apiKeys.revokeApiKey(keyB.id)),
    false
  );
  assert.equal(
    await runWithTenantContext({ tenantId: "tenant_a" }, () =>
      apiKeys.setApiKeyExpiry(keyB.id, null)
    ),
    false
  );
  assert.equal(
    await runWithTenantContext({ tenantId: "tenant_a" }, () => apiKeys.deleteApiKey(keyB.id)),
    false
  );

  const stillB = await runWithTenantContext({ tenantId: "tenant_b" }, () =>
    apiKeys.getApiKeyById(keyB.id)
  );
  assert.equal(stillB?.name, "Tenant B key");
  assert.equal(await apiKeys.validateApiKey(keyB.key), true);
});

test("API keys created without tenant context stay in the Shiryu admin tenant", async () => {
  const key = await apiKeys.createApiKey("Platform key", "machine-platform");
  assert.equal(key.tenantId, "tenant_shiryu_admin");
});
