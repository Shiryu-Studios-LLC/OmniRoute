import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-groups-tenant-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const groups = await import("../../src/lib/db/quotaGroups.ts");

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

test("quota groups are tenant-scoped while the shared demo group stays available", () => {
  const groupA = asTenant("tenant_a", () => groups.createGroup("Shared visible name"));
  const groupB = asTenant("tenant_b", () => groups.createGroup("Shared visible name"));

  assert.notEqual(groupA.id, groupB.id);
  assert.deepEqual(
    asTenant("tenant_a", () => groups.listGroups()).map((group) => group.id),
    ["group-demo", groupA.id]
  );
  assert.deepEqual(
    asTenant("tenant_b", () => groups.listGroups()).map((group) => group.id),
    ["group-demo", groupB.id]
  );
  assert.equal(
    asTenant("tenant_b", () => groups.getGroup(groupA.id)),
    null
  );
  assert.equal(
    asTenant("tenant_b", () => groups.getGroupName(groupA.id)),
    null
  );
  assert.equal(
    asTenant("tenant_b", () => groups.renameGroup(groupA.id, "stolen")),
    false
  );
  assert.equal(
    asTenant("tenant_b", () => groups.deleteGroup(groupA.id)),
    false
  );
  assert.equal(
    asTenant("tenant_a", () => groups.getGroup(groupA.id)?.name),
    "Shared visible name"
  );
});
