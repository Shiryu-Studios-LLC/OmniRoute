import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-failure-dedupe-tenants-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");
const breakers = await import("../../src/shared/utils/circuitBreaker.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  asTenant("tenant_a", () => breakers.resetAllCircuitBreakers());
  asTenant("tenant_b", () => breakers.resetAllCircuitBreakers());
});

test.after(() => {
  asTenant("tenant_a", () => breakers.resetAllCircuitBreakers());
  asTenant("tenant_b", () => breakers.resetAllCircuitBreakers());
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("network failure dedupe does not suppress another tenant's failure", () => {
  const provider = "shared-test-provider";
  asTenant("tenant_a", () =>
    accountFallback.recordProviderFailure(provider, undefined, undefined, null, {
      isNetworkError: true,
    })
  );
  asTenant("tenant_b", () =>
    accountFallback.recordProviderFailure(provider, undefined, undefined, null, {
      isNetworkError: true,
    })
  );

  assert.equal(
    asTenant("tenant_a", () => accountFallback.getProviderBreakerState(provider)?.failureCount),
    1
  );
  assert.equal(
    asTenant("tenant_b", () => accountFallback.getProviderBreakerState(provider)?.failureCount),
    1
  );
});

test("connection failure dedupe is tenant-scoped", () => {
  const provider = "shared-test-connection-provider";
  asTenant("tenant_a", () =>
    accountFallback.recordProviderFailure(provider, undefined, "same-connection-id")
  );
  asTenant("tenant_b", () =>
    accountFallback.recordProviderFailure(provider, undefined, "same-connection-id")
  );

  assert.equal(
    asTenant("tenant_a", () => accountFallback.getProviderBreakerState(provider)?.failureCount),
    1
  );
  assert.equal(
    asTenant("tenant_b", () => accountFallback.getProviderBreakerState(provider)?.failureCount),
    1
  );
});
