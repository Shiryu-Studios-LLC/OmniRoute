import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lease-test-isolation-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK = "true";

let externalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  externalCalls += 1;
  throw new Error("unexpected external provider/model call");
};

const core = await import("../../src/lib/db/core.ts");
const leases = await import("../../src/lib/db/exclusiveConnectionLeases.ts");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/route.ts");
const providerModels = await import("../../src/app/api/providers/[id]/models/route.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");
const codexResetCredits = await import("../../src/lib/usage/codexResetCredits.ts");

const OWNER = "vlo_TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT";

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("connection verification skips an ACTIVE exclusive lease before any probe or mutation", async () => {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO provider_connections
     (id, provider, auth_type, name, api_key, is_active, test_status, created_at, updated_at, tenant_id)
     VALUES (?, ?, 'apikey', ?, ?, 1, 'active', ?, ?, 'tenant_shiryu_admin')`
  ).run(
    "leased-test-connection",
    "openai",
    "leased test connection",
    "synthetic-key",
    new Date().toISOString(),
    new Date().toISOString()
  );
  const acquired = leases.acquireExclusiveConnectionLease({
    leaseOwnerId: OWNER,
    apiKeyId: "managed-key",
    provider: "openai",
    connectionId: "leased-test-connection",
  });
  assert.equal(acquired.kind, "ACQUIRED");

  const result = await testSingleConnection("leased-test-connection");

  assert.equal(result.valid, false);
  assert.equal(result.skipped, true);
  assert.equal(result.diagnosis?.code, "exclusive_lease_active");
  assert.equal(externalCalls, 0);
  const row = db
    .prepare("SELECT test_status, last_tested, last_error FROM provider_connections WHERE id = ?")
    .get("leased-test-connection") as {
    test_status: string;
    last_tested: string | null;
    last_error: string | null;
  };
  assert.equal(row.test_status, "active");
  assert.equal(row.last_tested, null);
  assert.equal(row.last_error, null);
});

test("model discovery, quota refresh, and reset-credit paths reject ACTIVE leased connections", async () => {
  const previousInternalToken = process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
  process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = "exclusive-lease-test-service-token";
  try {
    const response = await providerModels.GET(
      new Request("http://127.0.0.1/api/providers/leased-test-connection/models", {
        headers: {
          "x-omniroute-internal-service-token": "exclusive-lease-test-service-token",
          "x-omniroute-peer-locality": "loopback",
        },
      }),
      { params: { id: "leased-test-connection" } }
    );
    assert.equal(response.status, 409);
  } finally {
    if (previousInternalToken === undefined) delete process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
    else process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = previousInternalToken;
  }

  await assert.rejects(
    providerLimits.fetchLiveProviderLimits("leased-test-connection"),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { status?: number }).status === 409 &&
      /exclusive lease/i.test(error.message)
  );
  await assert.rejects(
    codexResetCredits.listCodexResetCredits("leased-test-connection"),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { status?: number }).status === 409 &&
      /exclusive lease/i.test(error.message)
  );
  assert.equal(externalCalls, 0);
});
