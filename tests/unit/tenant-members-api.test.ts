import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tenant-members-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "tenant-members-api-test-secret-1234567890";
process.env.INITIAL_PASSWORD = "tenant-members-auth-required";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const compliance = await import("../../src/lib/compliance/index.ts");
const tenants = await import("../../src/lib/db/tenants.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const collection = await import("../../src/app/api/tenant-members/route.ts");
const item = await import("../../src/app/api/tenant-members/[principalId]/route.ts");

async function resetStorage() {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'customer', 1, ?, ?)`
  );
  insert.run("tenant-members-a", "Tenant A", "tenant-members-a", now, now);
  insert.run("tenant-members-b", "Tenant B", "tenant-members-b", now, now);
}

async function createManagementKey(tenantId: string, name: string) {
  return runWithTenantContext({ tenantId, role: "owner" }, () =>
    apiKeys.createApiKey(name, `machine-${name}`, ["manage"])
  );
}

function asRequest(pathname: string, method: string, key: string, body?: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function addRole(tenantId: string, key: string, role: string) {
  const metadata = await apiKeys.getApiKeyMetadata(key);
  assert.ok(metadata);
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tenant_members (id, tenant_id, principal_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`test-${metadata.id}`, tenantId, metadata.id, role, now, now);
  return metadata.id;
}

test.beforeEach(resetStorage);
test.after(() => {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("tenant members API scopes principals to the authenticated tenant and enforces read/manage roles", async () => {
  const ownerA = await createManagementKey("tenant-members-a", "owner-a");
  const ownerB = await createManagementKey("tenant-members-b", "owner-b");
  const memberA = await createManagementKey("tenant-members-a", "member-a");
  const memberB = await createManagementKey("tenant-members-b", "member-b");
  const ownerAId = await addRole("tenant-members-a", ownerA.key, "owner");
  await addRole("tenant-members-b", ownerB.key, "owner");
  const memberAId = (await apiKeys.getApiKeyMetadata(memberA.key))!.id;
  const memberBId = (await apiKeys.getApiKeyMetadata(memberB.key))!.id;

  const listed = await collection.GET(asRequest("/api/tenant-members", "GET", ownerA.key));
  assert.equal(listed.status, 200, await listed.clone().text());
  assert.deepEqual(
    ((await listed.json()) as { members: Array<{ principalId: string }> }).members.map(
      (entry) => entry.principalId
    ),
    [ownerAId]
  );

  const crossTenantAdd = await collection.POST(
    asRequest("/api/tenant-members", "POST", ownerA.key, {
      principalId: memberBId,
      role: "member",
    })
  );
  assert.equal(crossTenantAdd.status, 404);
  assert.equal(tenants.getTenantMemberRole("tenant-members-b", memberBId), null);

  const added = await collection.POST(
    asRequest("/api/tenant-members", "POST", ownerA.key, {
      principalId: memberAId,
      role: "member",
    })
  );
  assert.equal(added.status, 201, await added.clone().text());
  assert.equal(tenants.getTenantMemberRole("tenant-members-a", memberAId), "member");

  const memberRead = await collection.GET(asRequest("/api/tenant-members", "GET", memberA.key));
  assert.equal(memberRead.status, 200);
  const memberManage = await item.PATCH(
    asRequest(`/api/tenant-members/${memberAId}`, "PATCH", memberA.key, { role: "admin" }),
    { params: Promise.resolve({ principalId: memberAId }) }
  );
  assert.equal(memberManage.status, 403);

  const crossTenantUpdate = await item.PATCH(
    asRequest(`/api/tenant-members/${memberAId}`, "PATCH", ownerB.key, { role: "admin" }),
    { params: Promise.resolve({ principalId: memberAId }) }
  );
  assert.equal(crossTenantUpdate.status, 404);
  assert.equal(tenants.getTenantMemberRole("tenant-members-a", memberAId), "member");

  const roleChanged = await item.PATCH(
    asRequest(`/api/tenant-members/${memberAId}`, "PATCH", ownerA.key, { role: "maintenance" }),
    { params: Promise.resolve({ principalId: memberAId }) }
  );
  assert.equal(roleChanged.status, 200);

  const removed = await item.DELETE(
    asRequest(`/api/tenant-members/${memberAId}`, "DELETE", ownerA.key),
    { params: Promise.resolve({ principalId: memberAId }) }
  );
  assert.equal(removed.status, 200);
  assert.equal(tenants.getTenantMemberRole("tenant-members-a", memberAId), null);

  const auditEvents = runWithTenantContext(
    { tenantId: "tenant-members-a", principalId: ownerAId, role: "owner" },
    () =>
      compliance
        .getAuditLog({ limit: 50 })
        .filter((event) => String(event.action).startsWith("tenantMembership."))
  );
  assert.deepEqual(
    auditEvents.map((event) => event.action).sort(),
    ["tenantMembership.create", "tenantMembership.remove", "tenantMembership.role.update"].sort()
  );
  const roleByAction: Record<string, string> = {
    "tenantMembership.create": "member",
    "tenantMembership.role.update": "maintenance",
    "tenantMembership.remove": "maintenance",
  };
  for (const event of auditEvents) {
    const metadata = event.metadata as Record<string, unknown>;
    assert.equal(event.actor, ownerAId);
    assert.equal(event.target, memberAId);
    assert.equal(event.resourceType, "tenant_member");
    assert.equal(event.status, "success");
    assert.equal(metadata.tenantId, "tenant-members-a");
    assert.equal(metadata.principalId, ownerAId);
    assert.equal(metadata.tenantRole, "owner");
    assert.deepEqual(event.details, {
      principalId: memberAId,
      role: roleByAction[String(event.action)],
    });
  }
  assert.doesNotMatch(JSON.stringify(auditEvents), new RegExp(ownerA.key));
});

test("tenant members API prevents deleting or demoting the last owner and allows maintenance reads only", async () => {
  const owner = await createManagementKey("tenant-members-a", "owner");
  const maintenance = await createManagementKey("tenant-members-a", "maintenance");
  const ownerId = await addRole("tenant-members-a", owner.key, "owner");
  const maintenanceId = await addRole("tenant-members-a", maintenance.key, "maintenance");

  const demoteLastOwner = await item.PATCH(
    asRequest(`/api/tenant-members/${ownerId}`, "PATCH", owner.key, { role: "member" }),
    { params: Promise.resolve({ principalId: ownerId }) }
  );
  assert.equal(demoteLastOwner.status, 409, await demoteLastOwner.clone().text());
  assert.equal(tenants.getTenantMemberRole("tenant-members-a", ownerId), "owner");

  const removeLastOwner = await item.DELETE(
    asRequest(`/api/tenant-members/${ownerId}`, "DELETE", owner.key),
    { params: Promise.resolve({ principalId: ownerId }) }
  );
  assert.equal(removeLastOwner.status, 409);

  const maintenanceList = await collection.GET(
    asRequest("/api/tenant-members", "GET", maintenance.key)
  );
  assert.equal(maintenanceList.status, 200);
  const maintenanceMutation = await item.DELETE(
    asRequest(`/api/tenant-members/${maintenanceId}`, "DELETE", maintenance.key),
    { params: Promise.resolve({ principalId: maintenanceId }) }
  );
  assert.equal(maintenanceMutation.status, 403);
});
