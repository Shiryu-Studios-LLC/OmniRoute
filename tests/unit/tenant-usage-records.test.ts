import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tenant-usage-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const usage = await import("../../src/lib/usage/usageHistory.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");

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

test("usage history rows and duplicate detection are tenant scoped", async () => {
  const entry = {
    provider: "openai",
    model: "same-model",
    timestamp: new Date().toISOString(),
    tokens: { input: 11, output: 7 },
    success: true,
  };

  await asTenant("tenant_a", () => usage.saveRequestUsage({ ...entry, latencyMs: 10 }));
  await asTenant("tenant_b", () => usage.saveRequestUsage({ ...entry, latencyMs: 100 }));

  const rows = core
    .getDbInstance()
    .prepare("SELECT tenant_id FROM usage_history WHERE timestamp = ? ORDER BY tenant_id")
    .all(entry.timestamp) as Array<{ tenant_id: string }>;
  assert.deepEqual(
    rows.map((row) => row.tenant_id),
    ["tenant_a", "tenant_b"]
  );
  assert.equal((await asTenant("tenant_a", () => usage.getUsageHistory())).length, 1);
  assert.equal((await asTenant("tenant_b", () => usage.getUsageHistory())).length, 1);
  assert.equal(
    (await asTenant("tenant_a", () => usage.getModelLatencyStats()))["openai/same-model"]
      .avgLatencyMs,
    10
  );
  assert.equal(
    (await asTenant("tenant_b", () => usage.getModelLatencyStats()))["openai/same-model"]
      .avgLatencyMs,
    100
  );
});

test("call-log list, detail and export only return the current tenant's rows", async () => {
  const db = core.getDbInstance();
  const insert = db.prepare(
    "INSERT INTO call_logs (id, tenant_id, timestamp, path, status, model) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insert.run(
    "call-a",
    "tenant_a",
    new Date().toISOString(),
    "/v1/chat/completions",
    200,
    "a-model"
  );
  insert.run(
    "call-b",
    "tenant_b",
    new Date(Date.now() + 1).toISOString(),
    "/v1/chat/completions",
    200,
    "b-model"
  );

  const listA = await asTenant("tenant_a", () => callLogs.getCallLogs());
  assert.deepEqual(
    listA.map((row) => row.id),
    ["call-a"]
  );
  assert.equal(await asTenant("tenant_a", () => callLogs.getCallLogById("call-b")), null);
  assert.deepEqual(
    (
      await asTenant("tenant_b", () => callLogs.exportCallLogsSince("2000-01-01T00:00:00.000Z"))
    ).map((row) => (row as { id: string }).id),
    ["call-b"]
  );
});
