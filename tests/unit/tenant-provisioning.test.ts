import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-tenant-provisioning-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "tenant-provisioning-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const tenants = await import("../../src/lib/db/tenants.ts");
const compliance = await import("../../src/lib/compliance/index.ts");
const { provisionCustomerTenant } =
  await import("../../src/lib/tenantProvisioning/provisionCustomerTenant.ts");

test.beforeEach(() => {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("provisioning creates a customer, verified owner, tenant key, and secret-free audit event", async () => {
  const result = await provisionCustomerTenant({
    name: "Acme Research",
    slug: "acme-research",
    owner: { principalId: "oidc:acme-owner", identityVerified: true },
    provisionedBy: "platform-admin",
  });

  assert.equal(result.tenant.kind, "customer");
  assert.equal(result.tenant.slug, "acme-research");
  assert.deepEqual(result.owner, {
    principalId: "oidc:acme-owner",
    apiKeyPrincipalId: result.apiKey.id,
    role: "owner",
  });
  assert.ok(result.apiKey.key.startsWith("sk-"));

  assert.equal(tenants.getTenantMemberRole(result.tenant.id, "oidc:acme-owner"), null);
  assert.equal(tenants.getTenantMemberRole(result.tenant.id, result.apiKey.id), "owner");
  const db = core.getDbInstance();
  const storedKey = db
    .prepare("SELECT tenant_id, key FROM api_keys WHERE id = ?")
    .get(result.apiKey.id) as { tenant_id: string; key: string } | undefined;
  assert.equal(storedKey?.tenant_id, result.tenant.id);
  assert.equal(storedKey?.key, result.apiKey.key);

  const [event] = compliance.getAuditLog({ action: "tenant.provision", target: result.tenant.id });
  assert.equal(event?.actor, "platform-admin");
  assert.equal(event?.status, "success");
  assert.ok(!JSON.stringify(event?.details).includes(result.apiKey.key));
  assert.ok(!JSON.stringify(event?.metadata).includes(result.apiKey.key));
});

test("provisioning rejects invalid slugs, unverified owners, and duplicate slugs", async () => {
  const base = {
    name: "Acme",
    slug: "acme",
    owner: { principalId: "oidc:owner", identityVerified: true as const },
    provisionedBy: "platform-admin",
  };

  await assert.rejects(
    provisionCustomerTenant({ ...base, slug: "../admin" }),
    /lowercase tenant slug/
  );
  await assert.rejects(
    provisionCustomerTenant({
      ...base,
      owner: { principalId: "oidc:owner", identityVerified: false as true },
    }),
    /identity must be verified/
  );

  await provisionCustomerTenant(base);
  await assert.rejects(provisionCustomerTenant(base), /already in use/);
});

test("failed key creation rolls back the unpublished tenant and owner membership", async () => {
  const previousSecret = process.env.API_KEY_SECRET;
  delete process.env.API_KEY_SECRET;
  try {
    await assert.rejects(
      provisionCustomerTenant({
        name: "Rollback Tenant",
        slug: "rollback-tenant",
        owner: { principalId: "oidc:rollback-owner", identityVerified: true },
        provisionedBy: "platform-admin",
      }),
      /API_KEY_SECRET is required/
    );
  } finally {
    if (previousSecret === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = previousSecret;
  }

  assert.equal(tenants.getTenantBySlug("rollback-tenant"), null);
  const db = core.getDbInstance();
  const memberCount = db
    .prepare("SELECT COUNT(*) AS count FROM tenant_members WHERE principal_id = ?")
    .get("oidc:rollback-owner") as { count: number };
  assert.equal(memberCount.count, 0);
});
