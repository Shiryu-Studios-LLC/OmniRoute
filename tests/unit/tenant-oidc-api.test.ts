import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tenant-oidc-api-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "tenant-oidc-api-test-secret-1234567890";
process.env.STORAGE_ENCRYPTION_KEY = "tenant-oidc-api-encryption-key";
process.env.INITIAL_PASSWORD = "tenant-oidc-api-auth-required";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const oidc = await import("../../src/lib/db/tenantOidc.ts");
const route = await import("../../src/app/api/tenant-oidc/route.ts");

async function resetStorage() {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const now = new Date().toISOString();
  const insert = core.getDbInstance().prepare(
    `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'customer', 1, ?, ?)`
  );
  insert.run("tenant_oidc_api_a", "OIDC API A", "oidc-api-a", now, now);
  insert.run("tenant_oidc_api_b", "OIDC API B", "oidc-api-b", now, now);
}

async function createKey(tenantId: string, name: string, role: string) {
  const key = await runWithTenantContext({ tenantId, role: "owner" }, () =>
    apiKeys.createApiKey(name, `machine-${name}`, ["manage"])
  );
  const metadata = await apiKeys.getApiKeyMetadata(key.key);
  assert.ok(metadata);
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO tenant_members (id, tenant_id, principal_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(`test-${metadata.id}`, tenantId, metadata.id, role, now, now);
  return key;
}

function request(method: string, key?: string, body?: unknown) {
  return new Request("http://localhost/api/tenant-oidc", {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test.beforeEach(resetStorage);
test.after(() => {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("tenant OIDC API enforces owner/admin auth, scopes data, and never returns client secrets", async () => {
  const ownerA = await createKey("tenant_oidc_api_a", "owner-a", "owner");
  const ownerB = await createKey("tenant_oidc_api_b", "owner-b", "owner");
  const memberA = await createKey("tenant_oidc_api_a", "member-a", "member");

  assert.equal((await route.GET(request("GET"))).status, 401);
  assert.equal((await route.GET(request("GET", memberA.key))).status, 403);

  const created = await route.PUT(
    request("PUT", ownerA.key, {
      issuer: "https://idp.example.com/realms/customer-a",
      clientId: "customer-a-client",
      clientSecret: "api-secret-never-return-this",
    })
  );
  assert.equal(created.status, 201, await created.clone().text());
  const createdText = await created.text();
  assert.doesNotMatch(createdText, /api-secret-never-return-this/);
  const createdBody = JSON.parse(createdText) as {
    config: { tenantId: string; isEnabled: boolean; hasClientSecret: boolean };
  };
  assert.equal(createdBody.config.tenantId, "tenant_oidc_api_a");
  assert.equal(createdBody.config.isEnabled, false);
  assert.equal(createdBody.config.hasClientSecret, true);

  const listedA = await route.GET(request("GET", ownerA.key));
  const listedAText = await listedA.text();
  assert.equal(listedA.status, 200);
  assert.doesNotMatch(listedAText, /api-secret-never-return-this/);
  assert.doesNotMatch(listedAText, /clientSecret/);

  const listedB = await route.GET(request("GET", ownerB.key));
  assert.equal(listedB.status, 200);
  assert.equal((JSON.parse(await listedB.text()) as { config: unknown }).config, null);

  const storedSecretBeforeUpdate = core
    .getDbInstance()
    .prepare("SELECT client_secret_encrypted FROM tenant_oidc_configs WHERE tenant_id = ?")
    .get("tenant_oidc_api_a") as { client_secret_encrypted: string };
  const updated = await route.PUT(
    request("PUT", ownerA.key, {
      issuer: "https://idp.example.com/realms/customer-a",
      clientId: "customer-a-client-updated",
    })
  );
  assert.equal(updated.status, 200, await updated.clone().text());
  const storedSecretAfterUpdate = core
    .getDbInstance()
    .prepare("SELECT client_secret_encrypted FROM tenant_oidc_configs WHERE tenant_id = ?")
    .get("tenant_oidc_api_a") as { client_secret_encrypted: string };
  assert.equal(
    storedSecretAfterUpdate.client_secret_encrypted,
    storedSecretBeforeUpdate.client_secret_encrypted
  );
  assert.equal(
    runWithTenantContext({ tenantId: "tenant_oidc_api_a" }, () => oidc.getTenantOidcConfig())
      ?.isEnabled,
    false
  );

  const disabled = await route.PATCH(request("PATCH", ownerA.key, { isEnabled: false }));
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.equal(
    runWithTenantContext({ tenantId: "tenant_oidc_api_a" }, () => oidc.getTenantOidcCredentials()),
    null
  );
  assert.equal(
    (await route.PATCH(request("PATCH", ownerA.key, { isEnabled: true }))).status,
    400,
    "this foundation endpoint must not enable an unwired customer login flow"
  );

  const deleted = await route.DELETE(request("DELETE", ownerA.key));
  assert.equal(deleted.status, 200);
  assert.equal(
    runWithTenantContext({ tenantId: "tenant_oidc_api_a" }, () => oidc.getTenantOidcConfig()),
    null
  );
  assert.equal((await route.DELETE(request("DELETE", ownerA.key))).status, 404);
});

test("tenant OIDC API rejects secretless creation and malformed or cross-tenant input", async () => {
  const owner = await createKey("tenant_oidc_api_a", "owner", "owner");
  const noSecret = await route.PUT(
    request("PUT", owner.key, {
      issuer: "https://idp.example.com/realms/customer-a",
      clientId: "customer-a-client",
    })
  );
  assert.equal(noSecret.status, 400);

  const insecureIssuer = await route.PUT(
    request("PUT", owner.key, {
      issuer: "http://idp.example.com",
      clientId: "customer-a-client",
      clientSecret: "secret",
    })
  );
  assert.equal(insecureIssuer.status, 400);

  const tenantSpoof = await route.PUT(
    request("PUT", owner.key, {
      tenantId: "tenant_oidc_api_b",
      issuer: "https://idp.example.com/realms/customer-a",
      clientId: "customer-a-client",
      clientSecret: "secret",
    })
  );
  assert.equal(tenantSpoof.status, 400);
  assert.equal(
    runWithTenantContext({ tenantId: "tenant_oidc_api_b" }, () => oidc.getTenantOidcConfig()),
    null
  );
});
