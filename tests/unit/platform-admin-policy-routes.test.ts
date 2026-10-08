import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-platform-policy-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "platform-policy-test-secret-1234567890";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const tenants = await import("../../src/lib/db/tenants.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const cacheRoute = await import("../../src/app/api/cache/entries/route.ts");
const globalCacheRoute = await import("../../src/app/api/cache/route.ts");
const cacheStatsRoute = await import("../../src/app/api/cache/stats/route.ts");
const cacheConfigRoute = await import("../../src/app/api/settings/cache-config/route.ts");
const exportRoute = await import("../../src/app/api/settings/export-json/route.ts");
const fallbackRoute = await import("../../src/app/api/fallback/chains/route.ts");
const rateLimitsRoute = await import("../../src/app/api/rate-limits/route.ts");
const rateLimitAliasRoute = await import("../../src/app/api/rate-limit/route.ts");
const searchStatsRoute = await import("../../src/app/api/search/stats/route.ts");

async function reset() {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'customer', 1, ?, ?)`
    )
    .run("policy-customer-a", "Policy Customer A", "policy-customer-a", now, now);
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'customer', 1, ?, ?)`
    )
    .run("policy-customer-b", "Policy Customer B", "policy-customer-b", now, now);
}

async function createManageKey(tenantId: string, name: string) {
  return runWithTenantContext({ tenantId, role: "owner" }, () =>
    apiKeys.createApiKey(name, `principal-${tenantId}`, ["manage"])
  );
}

function request(url: string, method: string, token?: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test.beforeEach(reset);
test.after(() => {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("shared semantic-cache administration rejects customer management keys", async () => {
  const customer = await createManageKey("policy-customer-a", "Customer manage key");
  const platform = await createManageKey(tenants.SHIRYU_ADMIN_TENANT_ID, "Platform manage key");
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO semantic_cache
       (id, signature, model, prompt_hash, response, tokens_saved, hit_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "semantic-platform-delete",
      "platform-delete-signature",
      "platform-delete-model",
      "prompt-hash",
      "{}",
      0,
      0,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString()
    );

  const customerRead = await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
    cacheRoute.GET(request("/api/cache/entries", "GET", customer.key) as never)
  );
  assert.equal(customerRead.status, 403);
  const customerDelete = await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
    cacheRoute.DELETE(
      request("/api/cache/entries?model=test-model", "DELETE", customer.key) as never
    )
  );
  assert.equal(customerDelete.status, 403);

  const platformRead = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () => cacheRoute.GET(request("/api/cache/entries", "GET", platform.key) as never)
  );
  assert.equal(platformRead.status, 200);

  const platformDelete = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () =>
      cacheRoute.DELETE(
        request("/api/cache/entries?model=platform-delete-model", "DELETE", platform.key) as never
      )
  );
  assert.equal(platformDelete.status, 200);
  assert.equal(
    core
      .getDbInstance()
      .prepare("SELECT COUNT(*) AS count FROM semantic_cache WHERE model = ?")
      .get("platform-delete-model")?.count,
    0
  );
});

test("shared cache controls and memory-cache clearing require platform administration", async () => {
  const customer = await createManageKey("policy-customer-a", "Customer cache key");
  const platform = await createManageKey(tenants.SHIRYU_ADMIN_TENANT_ID, "Platform cache key");

  for (const response of [
    await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
      globalCacheRoute.GET(request("/api/cache", "GET", customer.key) as never)
    ),
    await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
      globalCacheRoute.DELETE(request("/api/cache", "DELETE", customer.key) as never)
    ),
    await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
      cacheStatsRoute.GET(request("/api/cache/stats", "GET", customer.key) as never)
    ),
    await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
      cacheStatsRoute.DELETE(request("/api/cache/stats", "DELETE", customer.key) as never)
    ),
  ]) {
    assert.equal(response.status, 403);
  }

  const platformRead = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () => globalCacheRoute.GET(request("/api/cache", "GET", platform.key) as never)
  );
  assert.equal(platformRead.status, 200);

  const platformClear = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () => cacheStatsRoute.DELETE(request("/api/cache/stats", "DELETE", platform.key) as never)
  );
  assert.equal(platformClear.status, 200);
});

test("JSON settings export is restricted to the platform admin tenant", async () => {
  const customer = await createManageKey("policy-customer-b", "Customer backup key");
  const platform = await createManageKey(tenants.SHIRYU_ADMIN_TENANT_ID, "Platform backup key");

  const customerExport = await runWithTenantContext({ tenantId: "policy-customer-b" }, () =>
    exportRoute.GET(request("/api/settings/export-json", "GET", customer.key))
  );
  assert.equal(customerExport.status, 403);

  const platformExport = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () => exportRoute.GET(request("/api/settings/export-json", "GET", platform.key))
  );
  assert.equal(platformExport.status, 200);
});

test("global cache configuration requires platform administration", async () => {
  const customer = await createManageKey("policy-customer-a", "Customer cache config key");
  const platform = await createManageKey(
    tenants.SHIRYU_ADMIN_TENANT_ID,
    "Platform cache config key"
  );

  const customerRead = await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
    cacheConfigRoute.GET(request("/api/settings/cache-config", "GET", customer.key) as never)
  );
  assert.equal(customerRead.status, 403);
  const customerWrite = await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
    cacheConfigRoute.PUT(
      request("/api/settings/cache-config", "PUT", customer.key, {
        semanticCacheEnabled: false,
      }) as never
    )
  );
  assert.equal(customerWrite.status, 403);

  const platformWrite = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () =>
      cacheConfigRoute.PUT(
        request("/api/settings/cache-config", "PUT", platform.key, {
          semanticCacheEnabled: false,
          modelCatalogCacheTtlMs: 4242,
          idempotencyWindowMs: 9000,
        }) as never
      )
  );
  assert.equal(platformWrite.status, 200);

  const platformRead = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () => cacheConfigRoute.GET(request("/api/settings/cache-config", "GET", platform.key) as never)
  );
  assert.equal(platformRead.status, 200);
  const cacheConfig = await platformRead.json();
  assert.equal(cacheConfig.semanticCacheEnabled, false);
  assert.equal(cacheConfig.modelCatalogCacheTtlMs, 4242);
  assert.equal(cacheConfig.idempotencyWindowMs, 9000);
});

test("global fallback policy requires the platform admin tenant", async () => {
  const customer = await createManageKey("policy-customer-b", "Customer manage key");
  const platform = await createManageKey(tenants.SHIRYU_ADMIN_TENANT_ID, "Platform manage key");
  const chain = [{ provider: "provider-test", priority: 1, enabled: true }];

  const customerRead = await runWithTenantContext({ tenantId: "policy-customer-b" }, () =>
    fallbackRoute.GET(request("/api/fallback/chains", "GET", customer.key))
  );
  assert.equal(customerRead.status, 403);
  const customerWrite = await runWithTenantContext({ tenantId: "policy-customer-b" }, () =>
    fallbackRoute.POST(
      request("/api/fallback/chains", "POST", customer.key, {
        model: "platform-model",
        chain,
      })
    )
  );
  assert.equal(customerWrite.status, 403);

  const platformWrite = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () =>
      fallbackRoute.POST(
        request("/api/fallback/chains", "POST", platform.key, { model: "platform-model", chain })
      )
  );
  assert.equal(platformWrite.status, 200);

  const platformDelete = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () =>
      fallbackRoute.DELETE(
        request("/api/fallback/chains", "DELETE", platform.key, { model: "platform-model" })
      )
  );
  assert.equal(platformDelete.status, 200);
  assert.equal((await platformDelete.json()).removed, true);

  const platformReadAfterDelete = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () => fallbackRoute.GET(request("/api/fallback/chains", "GET", platform.key))
  );
  assert.equal(platformReadAfterDelete.status, 200);
  assert.deepEqual(await platformReadAfterDelete.json(), {});
});

test("shared rate-limit controls and search stats require platform administration", async () => {
  const customer = await createManageKey("policy-customer-a", "Customer shared-state key");
  const platform = await createManageKey(
    tenants.SHIRYU_ADMIN_TENANT_ID,
    "Platform shared-state key"
  );

  const customerResponses = [
    await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
      rateLimitsRoute.GET(request("/api/rate-limits", "GET", customer.key))
    ),
    await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
      rateLimitsRoute.POST(
        request("/api/rate-limits", "POST", customer.key, {
          connectionId: "policy-connection",
          enabled: true,
        })
      )
    ),
    await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
      rateLimitAliasRoute.GET(request("/api/rate-limit", "GET", customer.key))
    ),
    await runWithTenantContext({ tenantId: "policy-customer-a" }, () =>
      searchStatsRoute.GET(request("/api/search/stats", "GET", customer.key))
    ),
  ];
  assert.deepEqual(
    customerResponses.map((response) => response.status),
    [403, 403, 403, 403]
  );

  const platformRead = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () => rateLimitsRoute.GET(request("/api/rate-limits", "GET", platform.key))
  );
  assert.equal(platformRead.status, 200);

  const platformSearchStats = await runWithTenantContext(
    { tenantId: tenants.SHIRYU_ADMIN_TENANT_ID, role: "owner" },
    () => searchStatsRoute.GET(request("/api/search/stats", "GET", platform.key))
  );
  assert.equal(platformSearchStats.status, 200);
});
