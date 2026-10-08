import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-tenant-audit-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-tenant-audit-key-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const compliance = await import("../../src/lib/compliance/index.ts");
const tenants = await import("../../src/lib/db/tenants.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("API-key regeneration audit records include the current tenant principal", async () => {
  const tenant = tenants.createCustomerTenant("Audit Tenant", "audit-tenant");
  const created = await runWithTenantContext(
    { tenantId: tenant.id, principalId: "provisioner" },
    () => apiKeys.createApiKey("Audit key", "machine-audit")
  );

  const rotated = await runWithTenantContext(
    { tenantId: tenant.id, principalId: "owner-audit", role: "owner" },
    () => apiKeys.regenerateApiKey(created.id)
  );

  const [event] = runWithTenantContext({ tenantId: tenant.id }, () =>
    compliance.getAuditLog({
      action: "apiKey.regenerate",
      target: created.id,
      limit: 1,
    })
  );
  assert.equal(event.actor, "owner-audit");
  assert.deepEqual(event.metadata, {
    name: "Audit key",
    tenantId: tenant.id,
    principalId: "owner-audit",
    tenantRole: "owner",
  });
  assert.equal(event.resourceType, "api_key");
  assert.equal(event.status, "success");
  assert.ok(rotated);
  assert.doesNotMatch(JSON.stringify(event), new RegExp(rotated.key));
});

test("audit events inherit tenant and principal context without including secrets", () => {
  compliance.initAuditLog();
  runWithTenantContext({ tenantId: "tenant-audit-a", principalId: "key-a", role: "owner" }, () =>
    compliance.logAuditEvent({
      action: "apiKey.regenerate",
      target: "key-a",
      details: { name: "Automation key" },
    })
  );

  const [event] = runWithTenantContext({ tenantId: "tenant-audit-a" }, () =>
    compliance.getAuditLog({ action: "apiKey.regenerate", limit: 1 })
  );
  assert.equal(event.actor, "key-a");
  assert.deepEqual(event.metadata, {
    name: "Automation key",
    tenantId: "tenant-audit-a",
    principalId: "key-a",
    tenantRole: "owner",
  });
  assert.doesNotMatch(JSON.stringify(event.metadata), /raw-secret|apiKey/i);
});

test("API-key lifecycle audit records are tenant/principal scoped and omit plaintext keys", async () => {
  const tenant = tenants.createCustomerTenant("Lifecycle Tenant", "lifecycle-tenant");
  const principal = { tenantId: tenant.id, principalId: "owner-lifecycle", role: "owner" as const };

  const created = await runWithTenantContext(principal, () =>
    apiKeys.createApiKey("Lifecycle key", "machine-lifecycle")
  );
  await runWithTenantContext(principal, () =>
    apiKeys.setApiKeyExpiry(created.id, "2030-01-01T00:00:00.000Z")
  );
  await runWithTenantContext(principal, () =>
    apiKeys.updateApiKeyPermissions(created.id, { expiresAt: "2031-01-01T00:00:00.000Z" })
  );
  await runWithTenantContext(principal, () => apiKeys.revokeApiKey(created.id));

  const deleted = await runWithTenantContext(principal, () =>
    apiKeys.createApiKey("Deleted lifecycle key", "machine-lifecycle")
  );
  await runWithTenantContext(principal, () => apiKeys.deleteApiKey(deleted.id));

  const events = runWithTenantContext({ tenantId: tenant.id }, () =>
    compliance.getAuditLog({ limit: 20 })
  ).filter((entry) => [created.id, deleted.id].includes(String(entry.target)));
  const actionsByTarget = new Map<string, string[]>();
  for (const event of events) {
    const target = String(event.target);
    actionsByTarget.set(target, [...(actionsByTarget.get(target) ?? []), String(event.action)]);
    assert.equal(event.actor, principal.principalId);
    assert.equal(event.resourceType, "api_key");
    assert.equal(event.status, "success");
    assert.equal((event.metadata as Record<string, unknown>).tenantId, tenant.id);
    assert.equal((event.metadata as Record<string, unknown>).principalId, principal.principalId);
    assert.equal((event.metadata as Record<string, unknown>).tenantRole, "owner");
  }

  assert.deepEqual(actionsByTarget.get(created.id), [
    "apiKey.revoke",
    "apiKey.expiry.update",
    "apiKey.expiry.update",
    "apiKey.create",
  ]);
  assert.deepEqual(actionsByTarget.get(deleted.id), ["apiKey.delete", "apiKey.create"]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(created.key));
  assert.doesNotMatch(JSON.stringify(events), new RegExp(deleted.key));
});
