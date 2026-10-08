import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-tenant-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-quota-tenant-secret";

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const providers = await import("../../src/lib/db/providers.ts");
const pools = await import("../../src/lib/db/quotaPools.ts");
const groups = await import("../../src/lib/db/quotaGroups.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("quota pools and allocations are isolated by tenant", async () => {
  const connectionA = await asTenant("tenant_a", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Tenant A",
      apiKey: "tenant-a-secret",
    })
  );
  const connectionB = await asTenant("tenant_b", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Tenant B",
      apiKey: "tenant-b-secret",
    })
  );
  const groupA = asTenant("tenant_a", () => groups.createGroup("Shared group name"));
  const groupB = asTenant("tenant_b", () => groups.createGroup("Shared group name"));
  assert.notEqual(groupA.id, groupB.id);
  const poolA = asTenant("tenant_a", () =>
    pools.createPool({
      connectionId: connectionA.id,
      name: "Shared pool name",
      groupId: groupA.id,
      allocations: [{ apiKeyId: "key-a", weight: 100, policy: "hard" }],
    })
  );
  assert.throws(
    () =>
      asTenant("tenant_b", () =>
        pools.createPool({
          connectionId: connectionB.id,
          name: "cross-tenant group",
          groupId: groupA.id,
        })
      ),
    /current tenant/i
  );
  const poolB = asTenant("tenant_b", () =>
    pools.createPool({
      connectionId: connectionB.id,
      name: "Shared pool name",
      groupId: groupB.id,
      allocations: [{ apiKeyId: "key-b", weight: 100, policy: "hard" }],
    })
  );

  assert.deepEqual(
    asTenant("tenant_a", () => pools.listPools()).items.map((pool) => pool.id),
    [poolA.id]
  );
  assert.deepEqual(
    asTenant("tenant_b", () => pools.listPools()).items.map((pool) => pool.id),
    [poolB.id]
  );
  assert.equal(
    asTenant("tenant_b", () => pools.getPool(poolA.id)),
    null
  );
  assert.equal(
    asTenant("tenant_b", () => pools.updatePool(poolA.id, { name: "stolen" })),
    null
  );
  assert.equal(await asTenant("tenant_b", () => pools.deletePool(poolA.id)), false);
  assert.deepEqual(
    asTenant("tenant_b", () => pools.listAllocationsForApiKey("key-a")),
    []
  );
  assert.equal(asTenant("tenant_a", () => pools.listPools()).total, 1);
});

test("pool creation rejects a provider connection owned by another tenant", async () => {
  const connection = await asTenant("tenant_a", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Tenant A",
      apiKey: "tenant-a-secret",
    })
  );

  assert.throws(
    () =>
      asTenant("tenant_b", () =>
        pools.createPool({ connectionId: connection.id, name: "cross tenant" })
      ),
    /current tenant/i
  );
});

test("quota allocations reject API keys owned by another tenant", async () => {
  const connectionA = await asTenant("tenant_a", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Tenant A",
      apiKey: "tenant-a-secret",
    })
  );
  const connectionB = await asTenant("tenant_b", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Tenant B",
      apiKey: "tenant-b-secret",
    })
  );
  const foreignKey = await asTenant("tenant_a", () =>
    apiKeys.createApiKey("Tenant A key", "tenant-a-machine")
  );
  const localPool = asTenant("tenant_b", () =>
    pools.createPool({
      connectionId: connectionB.id,
      name: "Tenant B pool",
      allocations: [{ apiKeyId: "local-placeholder", weight: 100, policy: "hard" }],
    })
  );

  assert.throws(
    () =>
      asTenant("tenant_b", () =>
        pools.createPool({
          connectionId: connectionB.id,
          name: "Foreign allocation",
          allocations: [{ apiKeyId: foreignKey.id, weight: 100, policy: "hard" }],
        })
      ),
    /API keys owned by the current tenant/i
  );
  assert.throws(
    () =>
      asTenant("tenant_b", () =>
        pools.updatePool(localPool.id, {
          allocations: [{ apiKeyId: foreignKey.id, weight: 100, policy: "hard" }],
        })
      ),
    /API keys owned by the current tenant/i
  );
  assert.throws(
    () =>
      asTenant("tenant_b", () =>
        pools.upsertAllocations(localPool.id, [
          { apiKeyId: foreignKey.id, weight: 100, policy: "hard" },
        ])
      ),
    /API keys owned by the current tenant/i
  );
  assert.equal(
    asTenant("tenant_b", () => pools.getPool(localPool.id))?.allocations[0]?.apiKeyId,
    "local-placeholder"
  );
  assert.ok(connectionA.id);
});
