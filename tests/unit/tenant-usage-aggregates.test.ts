import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tenant-usage-aggregates-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const { rollupDailyUsage, rollupHourlyQuota, rollupUsageHistoryBeforeDate } =
  await import("../../src/lib/usage/aggregateHistory.ts");
const { buildUnifiedSource } = await import("../../src/lib/db/usageAnalytics/sources.ts");
const { getUsageSummary } = await import("../../src/lib/db/usageAnalytics.ts");
const { getMonthlyProviderTokensForConnection } = await import("../../src/lib/usage/usageStats.ts");
const cleanup = await import("../../src/lib/db/cleanup.ts");

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

test("daily rollups and dashboard/routing usage reads stay isolated by tenant", async () => {
  const db = core.getDbInstance();
  const sampleTimestamp = new Date(Date.now() - 60_000).toISOString();
  const sampleDate = sampleTimestamp.slice(0, 10);
  const beforeDate = new Date(Date.now() + 1_000).toISOString();
  const insert = db.prepare(`
    INSERT INTO usage_history (
      tenant_id, provider, model, connection_id, tokens_input, tokens_output, success, timestamp
    ) VALUES (?, 'openai', 'shared-model', 'shared-connection', ?, 2, 1, ?)
  `);
  insert.run("tenant_a", 11, sampleTimestamp);
  insert.run("tenant_b", 97, sampleTimestamp);

  const connection = db.prepare(
    `INSERT INTO provider_connections (id, provider, tenant_id, created_at, updated_at)
     VALUES (?, 'openai', ?, ?, ?)`
  );
  connection.run("conn-a", "tenant_a", sampleTimestamp, sampleTimestamp);
  connection.run("conn-b", "tenant_b", sampleTimestamp, sampleTimestamp);
  const snapshot = db.prepare(`
    INSERT INTO quota_snapshots (tenant_id, provider, connection_id, window_key, raw_data, created_at)
    VALUES (?, 'openai', ?, 'day', ?, ?)
  `);
  snapshot.run(
    "tenant_a",
    "conn-a",
    JSON.stringify({ model: "quota-model", input_tokens: 5 }),
    sampleTimestamp
  );
  snapshot.run(
    "tenant_b",
    "conn-b",
    JSON.stringify({ model: "quota-model", input_tokens: 50 }),
    sampleTimestamp
  );

  await asTenant("tenant_a", () => rollupUsageHistoryBeforeDate(beforeDate));
  await asTenant("tenant_b", () => rollupUsageHistoryBeforeDate(beforeDate));
  await asTenant("tenant_a", () => rollupDailyUsage(sampleDate, sampleDate));
  await asTenant("tenant_b", () => rollupDailyUsage(sampleDate, sampleDate));
  await asTenant("tenant_a", () =>
    rollupHourlyQuota(sampleTimestamp.slice(0, 13) + ":00:00", beforeDate)
  );
  await asTenant("tenant_b", () =>
    rollupHourlyQuota(sampleTimestamp.slice(0, 13) + ":00:00", beforeDate)
  );

  const summaries = db
    .prepare(
      `SELECT tenant_id, total_requests, total_input_tokens
       FROM daily_usage_summary
       WHERE provider = 'openai' AND model = 'shared-model' AND date = ?
       ORDER BY tenant_id`
    )
    .all(sampleDate) as Array<{
    tenant_id: string;
    total_requests: number;
    total_input_tokens: number;
  }>;
  assert.deepEqual(summaries, [
    { tenant_id: "tenant_a", total_requests: 1, total_input_tokens: 11 },
    { tenant_id: "tenant_b", total_requests: 1, total_input_tokens: 97 },
  ]);

  const quotaDaily = db
    .prepare(
      `SELECT tenant_id, total_input_tokens FROM daily_usage_summary
       WHERE model = 'quota-model' AND date = ? ORDER BY tenant_id`
    )
    .all(sampleDate) as Array<{ tenant_id: string; total_input_tokens: number }>;
  assert.deepEqual(quotaDaily, [
    { tenant_id: "tenant_a", total_input_tokens: 5 },
    { tenant_id: "tenant_b", total_input_tokens: 50 },
  ]);
  const quotaHourly = db
    .prepare(
      `SELECT tenant_id, total_input_tokens FROM hourly_usage_summary
       WHERE model = 'quota-model' ORDER BY tenant_id`
    )
    .all() as Array<{ tenant_id: string; total_input_tokens: number }>;
  assert.deepEqual(quotaHourly, [
    { tenant_id: "tenant_a", total_input_tokens: 5 },
    { tenant_id: "tenant_b", total_input_tokens: 50 },
  ]);

  const queryTenant = (tenantId: string) => {
    const { unifiedSource, unifiedParams } = asTenant(tenantId, () =>
      buildUnifiedSource({
        sinceIso: `${sampleDate}T00:00:00.000Z`,
        untilIso: `${sampleDate}T23:59:59.999Z`,
        rawCutoffDate: "2999-01-01",
        apiKeyWhere: "",
        apiKeyParams: {},
      })
    );
    return asTenant(tenantId, () => getUsageSummary(unifiedSource, unifiedParams));
  };

  assert.equal(queryTenant("tenant_a").promptTokens, 16);
  assert.equal(queryTenant("tenant_b").promptTokens, 147);
  assert.equal(
    asTenant("tenant_a", () =>
      getMonthlyProviderTokensForConnection("openai", "shared-connection")
    ),
    13
  );
  assert.equal(
    asTenant("tenant_b", () =>
      getMonthlyProviderTokensForConnection("openai", "shared-connection")
    ),
    99
  );
});

test("tenant aggregate unique keys allow identical provider/model/date rows", () => {
  const db = core.getDbInstance();
  const insert = db.prepare(`
    INSERT INTO daily_usage_summary (tenant_id, provider, model, date, total_requests)
    VALUES (?, 'openai', 'same-model', '2025-01-01', 1)
  `);
  insert.run("tenant_a");
  insert.run("tenant_b");

  assert.equal(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM daily_usage_summary
         WHERE provider = 'openai' AND model = 'same-model' AND date = '2025-01-01'`
        )
        .get() as { count: number }
    ).count,
    2
  );
});

test("usage retention rolls up and deletes only rows owned by the current tenant", async () => {
  const db = core.getDbInstance();
  const insert = db.prepare(`
    INSERT INTO usage_history (
      tenant_id, provider, model, connection_id, tokens_input, tokens_output, success, timestamp
    ) VALUES (?, 'openai', 'retained-model', ?, 7, 3, 1, '2020-01-01T12:00:00.000Z')
  `);
  insert.run("tenant_a", "connection-a");
  insert.run("tenant_b", "connection-b");

  const result = await asTenant("tenant_a", () => cleanup.cleanupUsageHistory());
  assert.equal(result.errors, 0);
  assert.equal(result.deleted, 1);
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM usage_history WHERE tenant_id = 'tenant_a'")
        .get() as {
        count: number;
      }
    ).count,
    0
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM usage_history WHERE tenant_id = 'tenant_b'")
        .get() as {
        count: number;
      }
    ).count,
    1
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM daily_usage_summary WHERE tenant_id = 'tenant_a'")
        .get() as {
        count: number;
      }
    ).count,
    1
  );
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM daily_usage_summary WHERE tenant_id = 'tenant_b'")
        .get() as {
        count: number;
      }
    ).count,
    0
  );
});
