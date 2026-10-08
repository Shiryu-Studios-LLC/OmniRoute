import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-quota-caps-tenant-db-"));

const caps = await import("../../src/lib/db/quotaModelCaps.ts");
const { getDbInstance } = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

test("model caps inherit tenant ownership from their quota pool", () => {
  const db = getDbInstance();
  db.prepare(
    "INSERT INTO quota_pools (id, connection_id, name, tenant_id) VALUES (?, ?, ?, ?)"
  ).run("pool-a", "conn-a", "Pool A", "tenant-caps-a");
  db.prepare(
    "INSERT INTO quota_pools (id, connection_id, name, tenant_id) VALUES (?, ?, ?, ?)"
  ).run("pool-b", "conn-b", "Pool B", "tenant-caps-b");
  const cap = {
    poolId: "pool-a",
    apiKeyId: "key-a",
    model: "model-a",
    capValue: 20,
    capUnit: "requests" as const,
  };
  asTenant("tenant-caps-a", () => caps.setModelCap(cap));

  assert.deepEqual(
    asTenant("tenant-caps-b", () => caps.listModelCaps("pool-a", "key-a")),
    []
  );
  assert.equal(
    asTenant("tenant-caps-b", () => caps.getModelCap("pool-a", "key-a", "model-a")),
    null
  );
  asTenant("tenant-caps-b", () => caps.deleteModelCap("pool-a", "key-a", "model-a"));
  assert.equal(
    asTenant("tenant-caps-a", () => caps.getModelCap("pool-a", "key-a", "model-a"))?.capValue,
    20
  );
  assert.throws(
    () => asTenant("tenant-caps-b", () => caps.setModelCap(cap)),
    /does not belong to the active tenant/
  );
});
