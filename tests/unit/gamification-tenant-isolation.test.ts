import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-gamification-tenant-db-"));

const gamification = await import("../../src/lib/db/gamification.ts");
const invites = await import("../../src/lib/gamification/invites.ts");
const { getDbInstance } = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

test("gamification rows and invite management are isolated between tenants", async () => {
  getDbInstance()
    .prepare(
      "INSERT INTO api_keys (id, name, key, tenant_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    )
    .run("foreign-key", "Foreign key", "test-secret", "tenant-gamification-a");
  asTenant("tenant-gamification-a", () => {
    gamification.updateScore("key-a", "global", 10);
    gamification.addXp("key-a", "request", 20);
    gamification.unlockBadge("key-a", "first-request");
  });
  asTenant("tenant-gamification-b", () => {
    gamification.updateScore("key-b", "global", 30);
    gamification.addXp("key-b", "request", 50);
    gamification.unlockBadge("key-b", "first-request");
  });

  assert.deepEqual(
    asTenant("tenant-gamification-a", () => gamification.getTopN("global", 10)).map(
      (r) => r.apiKeyId
    ),
    ["key-a"]
  );
  assert.deepEqual(
    asTenant("tenant-gamification-b", () => gamification.getTopN("global", 10)).map(
      (r) => r.apiKeyId
    ),
    ["key-b"]
  );
  assert.equal(
    asTenant("tenant-gamification-a", () => gamification.getXp("key-b")),
    null
  );
  assert.equal(
    asTenant("tenant-gamification-b", () => gamification.getXp("key-a")),
    null
  );
  assert.equal(
    asTenant("tenant-gamification-a", () => gamification.hasBadge("key-b", "first-request")),
    false
  );
  assert.equal(
    asTenant("tenant-gamification-b", () => gamification.getAggregateXp().totalXp),
    50
  );
  assert.throws(
    () =>
      asTenant("tenant-gamification-b", () =>
        gamification.updateScore("foreign-key", "global", 999)
      ),
    /does not belong to the active tenant/
  );

  const invite = asTenant("tenant-gamification-a", () =>
    gamification.createInviteToken("invite-a", "code-a", "hash-a", "key-a", "https://a.invalid")
  );
  assert.equal(invite, undefined);
  assert.equal(
    await asTenant("tenant-gamification-b", () => invites.revokeInvite("invite-a")),
    false
  );
  assert.deepEqual(await asTenant("tenant-gamification-b", () => invites.listInvites("key-a")), []);
  assert.equal(
    (await asTenant("tenant-gamification-a", () => invites.listInvites("key-a"))).length,
    1
  );
});
