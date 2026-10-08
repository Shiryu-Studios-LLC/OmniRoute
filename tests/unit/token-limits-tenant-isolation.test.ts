import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-token-limits-tenant-db-"));

const tokenLimits = await import("../../src/lib/db/tokenLimits.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

test("token limits, counters, and reset logs are isolated between tenants", () => {
  const a = asTenant("tenant-token-limits-a", () =>
    tokenLimits.upsertTokenLimit({ apiKeyId: "key-a", scopeType: "global", tokenLimit: 100 })
  );
  const b = asTenant("tenant-token-limits-b", () =>
    tokenLimits.upsertTokenLimit({ apiKeyId: "key-b", scopeType: "global", tokenLimit: 300 })
  );

  const windowStart = tokenLimits.resetWindowIfElapsed(a).windowStart;
  assert.equal(
    asTenant("tenant-token-limits-a", () =>
      tokenLimits.incrementWindowTokens(a.id, windowStart, 9)
    ),
    9
  );
  assert.equal(
    asTenant("tenant-token-limits-b", () => tokenLimits.getWindowUsage(a)),
    0
  );
  assert.equal(
    asTenant("tenant-token-limits-b", () =>
      tokenLimits.incrementWindowTokens(a.id, windowStart, 20)
    ),
    0
  );
  asTenant("tenant-token-limits-b", () => tokenLimits.logTokenLimitReset(a.id, 9, windowStart));

  assert.equal(
    asTenant("tenant-token-limits-a", () => tokenLimits.getWindowUsage(a)),
    9
  );
  assert.deepEqual(
    asTenant("tenant-token-limits-a", () => tokenLimits.listTokenLimits("key-b")),
    []
  );
  assert.deepEqual(
    asTenant("tenant-token-limits-b", () => tokenLimits.listTokenLimits("key-a")),
    []
  );
  assert.equal(
    asTenant("tenant-token-limits-b", () => tokenLimits.deleteTokenLimit(a.id)),
    false
  );
  assert.equal(
    asTenant("tenant-token-limits-a", () => tokenLimits.deleteTokenLimit(a.id)),
    true
  );
  assert.equal(
    asTenant("tenant-token-limits-b", () =>
      tokenLimits.getTokenLimitsForRequest("key-b", "p", "m")
    )[0]?.id,
    b.id
  );
});
