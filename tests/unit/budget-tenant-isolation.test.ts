import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-budget-tenant-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "budget-tenant-isolation-test-secret";
process.env.INITIAL_PASSWORD = "budget-tenant-isolation-test-password";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const domainState = await import("../../src/lib/db/domainState.ts");
const usageAnalytics = await import("../../src/lib/db/usageAnalytics.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const route = await import("../../src/app/api/usage/budget/route.ts");
const bulkRoute = await import("../../src/app/api/usage/budget/bulk/route.ts");
const exportRoute = await import("../../src/app/api/settings/export-json/route.ts");

async function resetStorage() {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  const insertTenant = db.prepare(
    `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'customer', 1, ?, ?)`
  );
  insertTenant.run("budget-tenant-a", "Tenant A", "budget-tenant-a", now, now);
  insertTenant.run("budget-tenant-b", "Tenant B", "budget-tenant-b", now, now);
}

async function createManagementKey(tenantId: string, name: string) {
  return runWithTenantContext({ tenantId }, () => apiKeys.createApiKey(name, name, ["manage"]));
}

function request(url: string, method: string, key: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test.beforeEach(resetStorage);
test.after(() => {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("budget endpoints hide and reject another tenant's API key", async () => {
  const keyA = await createManagementKey("budget-tenant-a", "tenant-a-key");
  const keyB = await createManagementKey("budget-tenant-b", "tenant-b-key");
  assert.equal(keyA.tenantId, "budget-tenant-a");
  assert.equal(
    (
      await runWithTenantContext({ tenantId: "budget-tenant-a" }, () =>
        apiKeys.getApiKeyById(keyA.id)
      )
    )?.tenantId,
    "budget-tenant-a"
  );
  await runWithTenantContext({ tenantId: "budget-tenant-b" }, () =>
    domainState.saveBudget(keyB.id, { dailyLimitUsd: 987.65 })
  );
  await runWithTenantContext({ tenantId: "budget-tenant-a" }, () =>
    domainState.saveBudget(keyA.id, { dailyLimitUsd: 12.34 })
  );
  await runWithTenantContext({ tenantId: "budget-tenant-a" }, () =>
    domainState.saveCostEntry(keyA.id, 1.23)
  );
  await runWithTenantContext({ tenantId: "budget-tenant-b" }, () =>
    domainState.saveCostEntry(keyB.id, 9.87)
  );

  const ownGet = await route.GET(
    request(`/api/usage/budget?apiKeyId=${encodeURIComponent(keyA.id)}`, "GET", keyA.key)
  );
  assert.equal(ownGet.status, 200, await ownGet.clone().text());

  const foreignGet = await route.GET(
    request(`/api/usage/budget?apiKeyId=${encodeURIComponent(keyB.id)}`, "GET", keyA.key)
  );
  assert.equal(foreignGet.status, 404);
  assert.doesNotMatch(await foreignGet.text(), /987\.65|dailyTotal|monthlyTotal/);

  const foreignPost = await route.POST(
    request("/api/usage/budget", "POST", keyA.key, {
      apiKeyId: keyB.id,
      dailyLimitUsd: 1,
    })
  );
  assert.equal(foreignPost.status, 404);

  const bulk = await bulkRoute.GET(request("/api/usage/budget/bulk", "GET", keyA.key));
  assert.equal(bulk.status, 200, await bulk.clone().text());
  assert.deepEqual(
    Object.keys(((await bulk.json()) as { budgets: Record<string, unknown> }).budgets),
    [keyA.id]
  );

  const storedBudget = await runWithTenantContext({ tenantId: "budget-tenant-b" }, () =>
    domainState.loadBudget(keyB.id)
  );
  assert.equal(storedBudget?.dailyLimitUsd, 987.65);

  const customerBackup = await exportRoute.GET(
    request("/api/settings/export-json?includeHistory=true", "GET", keyA.key)
  );
  assert.equal(customerBackup.status, 403);

  assert.deepEqual(
    runWithTenantContext({ tenantId: "budget-tenant-a" }, () =>
      usageAnalytics.getAllDomainCostHistory()
    ).map((row) => row.api_key_id),
    [keyA.id]
  );
  assert.deepEqual(
    runWithTenantContext({ tenantId: "budget-tenant-a" }, () =>
      usageAnalytics.getAllDomainBudgets()
    ).map((row) => row.api_key_id),
    [keyA.id]
  );
});
