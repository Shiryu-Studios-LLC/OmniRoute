import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tenant-isolation-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const providers = await import("../../src/lib/db/providers.ts");
const nodes = await import("../../src/lib/db/providers/nodes.ts");
const combos = await import("../../src/lib/db/combos.ts");
const rateLimit = await import("../../src/lib/db/providers/rateLimit.ts");
const runtimeState = await import("../../src/lib/db/connectionRuntimeState.ts");
const modelCatalog = await import("../../src/lib/db/models.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const lkgp = await import("../../src/lib/db/settings/lkgp.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("provider connections, nodes, combos, and cooldown state stay tenant-scoped", async () => {
  const connectionA = await asTenant("tenant_a", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Shared name",
      apiKey: "tenant-a-secret",
    })
  );
  const connectionB = await asTenant("tenant_b", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Shared name",
      apiKey: "tenant-b-secret",
    })
  );
  assert.notEqual(connectionA.id, connectionB.id);

  assert.deepEqual(
    (
      await asTenant("tenant_a", () => providers.getProviderConnections({ provider: "openai" }))
    ).map((row) => row.id),
    [connectionA.id]
  );
  assert.deepEqual(
    (
      await asTenant("tenant_b", () => providers.getProviderConnections({ provider: "openai" }))
    ).map((row) => row.id),
    [connectionB.id]
  );
  assert.equal(
    await asTenant("tenant_b", () => providers.getProviderConnectionById(connectionA.id)),
    null
  );
  assert.equal(
    (await asTenant("tenant_a", () => readCache.getCachedProviderConnectionById(connectionA.id)))
      ?.id,
    connectionA.id
  );
  assert.equal(
    await asTenant("tenant_b", () => readCache.getCachedProviderConnectionById(connectionA.id)),
    null
  );
  assert.equal(
    await asTenant("tenant_b", () => providers.deleteProviderConnection(connectionA.id)),
    false
  );
  await assert.rejects(
    asTenant("tenant_b", () => providers.getRawProviderConnections({ tenantId: "tenant_a" })),
    /cross-tenant database operation denied/i
  );

  asTenant("tenant_a", () =>
    rateLimit.setConnectionRateLimitUntil(connectionA.id, Date.now() + 60_000)
  );
  assert.equal(
    asTenant("tenant_a", () => rateLimit.isConnectionRateLimited(connectionA.id)),
    true
  );
  assert.equal(
    asTenant("tenant_b", () => rateLimit.isConnectionRateLimited(connectionA.id)),
    false
  );
  await asTenant("tenant_a", () =>
    runtimeState.upsertWarmupState(connectionA.id, {
      lastWarmupAt: new Date().toISOString(),
      lastResult: "ok",
      tokensUsed: 12,
    })
  );
  assert.ok(asTenant("tenant_a", () => runtimeState.getConnectionRuntimeState(connectionA.id)));
  assert.equal(
    asTenant("tenant_b", () => runtimeState.getConnectionRuntimeState(connectionA.id)),
    null
  );

  await asTenant("tenant_a", () =>
    modelCatalog.replaceSyncedAvailableModelsForConnection("openai", connectionA.id, [
      { id: "tenant-a-model", name: "Tenant A model" },
    ])
  );
  await asTenant("tenant_b", () =>
    modelCatalog.replaceSyncedAvailableModelsForConnection("openai", connectionB.id, [
      { id: "tenant-b-model", name: "Tenant B model" },
    ])
  );
  assert.deepEqual(
    (await asTenant("tenant_a", () => modelCatalog.getSyncedAvailableModels("openai"))).map(
      (model) => model.id
    ),
    ["tenant-a-model"]
  );
  assert.deepEqual(
    (await asTenant("tenant_b", () => modelCatalog.getSyncedAvailableModels("openai"))).map(
      (model) => model.id
    ),
    ["tenant-b-model"]
  );

  const nodeA = await asTenant("tenant_a", () =>
    nodes.createProviderNode({ type: "custom", name: "Tenant node" })
  );
  const nodeB = await asTenant("tenant_b", () =>
    nodes.createProviderNode({ type: "custom", name: "Tenant node" })
  );
  assert.notEqual(nodeA.id, nodeB.id);
  assert.equal(await asTenant("tenant_b", () => nodes.getProviderNodeById(nodeA.id)), null);
  assert.equal(await asTenant("tenant_b", () => nodes.deleteProviderNode(nodeA.id)), null);
  assert.deepEqual(
    (await asTenant("tenant_a", () => nodes.getProviderNodes())).map((row) => row.id),
    [nodeA.id]
  );

  const comboA = await asTenant("tenant_a", () =>
    combos.createCombo({ name: "Shared combo", models: [{ provider: "openai", model: "gpt-4.1" }] })
  );
  const comboB = await asTenant("tenant_b", () =>
    combos.createCombo({ name: "Shared combo", models: [{ provider: "openai", model: "gpt-4.1" }] })
  );
  assert.notEqual(comboA.id, comboB.id);
  assert.equal((await asTenant("tenant_a", () => combos.getCombos())).length, 1);
  assert.equal((await asTenant("tenant_b", () => combos.getCombos())).length, 1);
  assert.equal(await asTenant("tenant_b", () => combos.getComboById(comboA.id)), null);
  assert.equal(await asTenant("tenant_b", () => combos.deleteCombo(comboA.id)), false);
  assert.equal(
    await asTenant("tenant_b", () =>
      combos.updateCombo(comboA.id, { name: "Attempted cross-tenant update" })
    ),
    null
  );

  await asTenant("tenant_a", () =>
    lkgp.setLKGP("Shared combo", "openai/gpt-4.1", "provider-a", connectionA.id)
  );
  assert.equal(
    (await asTenant("tenant_a", () => lkgp.getLKGP("Shared combo", "openai/gpt-4.1")))?.provider,
    "provider-a"
  );
  assert.equal(
    await asTenant("tenant_b", () => lkgp.getLKGP("Shared combo", "openai/gpt-4.1")),
    null
  );
  await asTenant("tenant_b", () =>
    lkgp.setLKGP("Shared combo", "openai/gpt-4.1", "provider-b", connectionB.id)
  );
  assert.equal(
    (await asTenant("tenant_a", () => lkgp.getLKGP("Shared combo", "openai/gpt-4.1")))?.provider,
    "provider-a"
  );
});
