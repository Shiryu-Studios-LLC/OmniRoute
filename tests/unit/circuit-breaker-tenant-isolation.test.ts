import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-breaker-tenants-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const breakers = await import("../../src/shared/utils/circuitBreaker.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  breakers.resetAllCircuitBreakers();
});

test.after(() => {
  breakers.resetAllCircuitBreakers();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("breaker state and reset are isolated by tenant", async () => {
  const breakerA = asTenant("tenant_a", () =>
    breakers.getCircuitBreaker("shared-provider", {
      failureThreshold: 1,
      degradationThreshold: 1,
    })
  );
  await assert.rejects(breakerA.execute(async () => Promise.reject(new Error("upstream failed"))));
  assert.equal(
    asTenant("tenant_a", () => breakerA.getStatus().state),
    breakers.STATE.OPEN
  );

  const breakerB = asTenant("tenant_b", () => breakers.getCircuitBreaker("shared-provider"));
  assert.notEqual(breakerA, breakerB);
  assert.equal(
    asTenant("tenant_b", () => breakerB.getStatus().state),
    breakers.STATE.CLOSED
  );
  assert.deepEqual(
    asTenant("tenant_b", () => breakers.getAllCircuitBreakerStatuses()).map(
      (status) => status.name
    ),
    ["shared-provider"]
  );

  asTenant("tenant_a", () => breakers.resetAllCircuitBreakers());
  assert.equal(
    asTenant("tenant_b", () => breakerB.getStatus().state),
    breakers.STATE.CLOSED
  );
  assert.equal(asTenant("tenant_a", () => breakers.getAllCircuitBreakerStatuses()).length, 0);
});
