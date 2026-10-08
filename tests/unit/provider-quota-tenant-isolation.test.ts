import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-provider-quota-tenant-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const providers = await import("../../src/lib/db/providers.ts");
const quotaState = await import("../../src/lib/quota/providerQuotaState.ts");
const analytics = await import("../../src/lib/quota/quotaAnalytics.ts");
const resetTimers = await import("../../src/lib/quota/quotaResetTimers.ts");
const { createPool } = await import("../../src/lib/db/quotaPools.ts");
const { incrementBucket } = await import("../../src/lib/db/quotaConsumption.ts");
const { GET: getPoolUsageLog } = await import("../../src/app/api/quota/pools/[id]/log/route.ts");

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

test("provider quota reads, analytics, reset, and clear stay within the active tenant", async () => {
  const connectionA = await asTenant("tenant_quota_a", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Quota A",
      apiKey: "tenant-quota-a-secret",
    })
  );
  const connectionB = await asTenant("tenant_quota_b", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Quota B",
      apiKey: "tenant-quota-b-secret",
    })
  );

  asTenant("tenant_quota_a", () =>
    quotaState.recordProviderQuotaUsage(connectionA.id, "gpt-4.1", 11, { tokenLimit: 100 })
  );
  asTenant("tenant_quota_b", () =>
    quotaState.recordProviderQuotaUsage(connectionB.id, "gpt-4.1", 22, { tokenLimit: 200 })
  );

  const now = Date.now();
  const db = core.getDbInstance();
  const seedExpired = (tenantId: string, connectionId: string) =>
    db
      .prepare(
        `INSERT INTO provider_quota_state
       (tenant_id, connection_id, model, tokens_used, token_limit, window_start, window_reset, updated_at)
       VALUES (?, ?, 'expired-model', 5, 10, ?, ?, ?)`
      )
      .run(tenantId, connectionId, now - 10_000, now - 1_000, new Date().toISOString());
  seedExpired("tenant_quota_a", connectionA.id);
  seedExpired("tenant_quota_b", connectionB.id);

  assert.equal(
    asTenant("tenant_quota_a", () => quotaState.getProviderQuota(connectionB.id, "gpt-4.1")),
    null
  );
  assert.equal(
    asTenant("tenant_quota_a", () => quotaState.getProviderQuota(connectionA.id, "gpt-4.1"))
      ?.tokensUsed,
    11
  );
  assert.deepEqual(
    asTenant("tenant_quota_a", () =>
      analytics.getQuotaAnalyticsSummary().connections.map((row) => row.connectionId)
    ),
    [connectionA.id, connectionA.id]
  );
  assert.deepEqual(
    asTenant("tenant_quota_b", () =>
      resetTimers.getActiveQuotaResetItems().map((row) => row.connectionId)
    ),
    [connectionB.id, connectionB.id]
  );

  asTenant("tenant_quota_a", () => {
    quotaState.clearProviderQuota(connectionB.id);
    quotaState.recordProviderQuotaUsage(connectionB.id, "injected-model", 99, { tokenLimit: 100 });
  });
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM provider_quota_state WHERE tenant_id = ? AND connection_id = ?"
      )
      .get("tenant_quota_b", connectionB.id)?.count,
    2
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM provider_quota_state WHERE tenant_id = ? AND connection_id = ?"
      )
      .get("tenant_quota_a", connectionB.id)?.count,
    0
  );

  assert.equal(
    asTenant("tenant_quota_a", () => resetTimers.resetExpiredQuotaWindows()),
    1
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM provider_quota_state WHERE tenant_id = ? AND model = 'expired-model'"
      )
      .get("tenant_quota_a")?.count,
    0
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM provider_quota_state WHERE tenant_id = ? AND model = 'expired-model'"
      )
      .get("tenant_quota_b")?.count,
    1
  );
});

test("provider quota migration backfills connection owners and keeps orphaned rows on platform tenant", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE provider_connections (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
      INSERT INTO provider_connections VALUES ('conn-a', 'tenant_a');
      INSERT INTO provider_connections VALUES ('conn-b', 'tenant_b');
      CREATE TABLE provider_quota_state (
        connection_id TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        token_limit INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL,
        window_reset INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (connection_id, model)
      );
      INSERT INTO provider_quota_state (connection_id, model, window_start, window_reset)
      VALUES ('conn-a', 'gpt-4.1', 1, 2), ('conn-b', 'gpt-4.1', 1, 2), ('orphan', 'gpt-4.1', 1, 2);
    `);

    const migration = fs.readFileSync(
      path.resolve("src/lib/db/migrations/182_tenant_provider_quota_state.sql"),
      "utf8"
    );
    db.exec(migration);

    assert.deepEqual(
      db
        .prepare("SELECT connection_id, tenant_id FROM provider_quota_state ORDER BY connection_id")
        .all(),
      [
        { connection_id: "conn-a", tenant_id: "tenant_a" },
        { connection_id: "conn-b", tenant_id: "tenant_b" },
        { connection_id: "orphan", tenant_id: "tenant_shiryu_admin" },
      ]
    );
  } finally {
    db.close();
  }
});

test("quota-pool log returns own events and hides a foreign pool ID", async () => {
  const connectionA = await asTenant("tenant_pool_log_a", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Pool log A",
      apiKey: "tenant-pool-log-a-secret",
    })
  );
  const poolA = asTenant("tenant_pool_log_a", () =>
    createPool({ connectionId: connectionA.id, name: "Pool log A" })
  );
  const bucket = Math.floor(Date.now() / 60_000);
  const recordedAt = Date.now();
  incrementBucket("tenant-a-key-id", `${poolA.id}:tokens:minute`, bucket, 37, recordedAt);

  const request = new Request(`http://localhost/api/quota/pools/${poolA.id}/log`);
  const params = { params: Promise.resolve({ id: poolA.id }) };
  const ownResponse = await asTenant("tenant_pool_log_a", () => getPoolUsageLog(request, params));
  assert.equal(ownResponse.status, 200);
  assert.deepEqual(await ownResponse.json(), {
    events: [
      {
        apiKeyId: "tenant-a-key-id",
        dimensionKey: `${poolA.id}:tokens:minute`,
        unit: "tokens",
        window: "minute",
        bucketIndex: bucket,
        consumed: 37,
        updatedAt: recordedAt,
      },
    ],
  });

  const foreignResponse = await asTenant("tenant_pool_log_b", () =>
    getPoolUsageLog(request, params)
  );
  assert.equal(foreignResponse.status, 404);
  assert.equal(
    ((await foreignResponse.json()) as { error: { message: string } }).error.message,
    "Pool not found"
  );
});
