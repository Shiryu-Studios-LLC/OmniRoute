import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tenant-status-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const { buildOmniRouteStatus } = await import("../../src/lib/omnirouteStatus.ts");

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

test("operational provider status lists only the current tenant's connections", async () => {
  await asTenant("tenant_a", () =>
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Tenant A connection",
      apiKey: "tenant-a-secret",
    })
  );
  const connectionB = await asTenant("tenant_b", () =>
    providers.createProviderConnection({
      provider: "anthropic",
      authType: "apikey",
      name: "Tenant B connection",
      apiKey: "tenant-b-secret",
    })
  );

  const statusA = await asTenant("tenant_a", () => buildOmniRouteStatus());
  const statusB = await asTenant("tenant_b", () => buildOmniRouteStatus());
  assert.equal(statusA.providers.configured, 1);
  assert.equal(statusA.providers.connections[0].provider, "openai");
  assert.equal(statusB.providers.configured, 1);
  assert.equal(statusB.providers.connections[0].provider, "anthropic");

  const timestamp = "2026-10-08T12:00:00.000Z";
  await asTenant("tenant_a", () =>
    usageHistory.saveRequestUsage({
      provider: "anthropic",
      model: "tenant-b-model",
      connectionId: connectionB.id,
      timestamp,
      success: true,
    })
  );
  const usageRow = core
    .getDbInstance()
    .prepare("SELECT account_label FROM usage_history WHERE timestamp = ?")
    .get(timestamp) as { account_label: string };
  assert.equal(usageRow.account_label, connectionB.id);
  assert.notEqual(usageRow.account_label, "Tenant B connection");
});
