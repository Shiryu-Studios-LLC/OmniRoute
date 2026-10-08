import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tenant-oidc-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.STORAGE_ENCRYPTION_KEY = "tenant-oidc-unit-test-encryption-key";

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const oidc = await import("../../src/lib/db/tenantOidc.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function createTenants() {
  const now = new Date().toISOString();
  const insert = core.getDbInstance().prepare(
    `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'customer', 1, ?, ?)`
  );
  insert.run("tenant_oidc_a", "Tenant OIDC A", "tenant-oidc-a", now, now);
  insert.run("tenant_oidc_b", "Tenant OIDC B", "tenant-oidc-b", now, now);
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("tenant OIDC config is scoped and client secrets are encrypted at rest", () => {
  createTenants();
  const secret = "tenant-a-oidc-secret";
  const config = asTenant("tenant_oidc_a", () =>
    oidc.setTenantOidcConfig({
      issuer: "https://idp.example.com/realms/acme",
      clientId: "acme-client",
      clientSecret: secret,
      scopes: ["openid", "email"],
      isEnabled: true,
    })
  );

  assert.equal(config.tenantId, "tenant_oidc_a");
  assert.equal(config.hasClientSecret, true);
  assert.equal("clientSecret" in config, false);
  const stored = core
    .getDbInstance()
    .prepare("SELECT client_secret_encrypted FROM tenant_oidc_configs WHERE tenant_id = ?")
    .get("tenant_oidc_a") as { client_secret_encrypted: string };
  assert.match(stored.client_secret_encrypted, /^enc:v1:/);
  assert.equal(stored.client_secret_encrypted.includes(secret), false);
  assert.deepEqual(
    asTenant("tenant_oidc_a", () => oidc.getTenantOidcConfig()),
    config
  );
  assert.equal(
    asTenant("tenant_oidc_b", () => oidc.getTenantOidcConfig()),
    null
  );
  assert.equal(
    asTenant("tenant_oidc_a", () => oidc.getTenantOidcCredentials())?.clientSecret,
    secret
  );
  assert.equal(
    asTenant("tenant_oidc_b", () => oidc.getTenantOidcCredentials()),
    null
  );
  asTenant("tenant_oidc_a", () =>
    oidc.setTenantOidcConfig({
      issuer: "https://idp.example.com/realms/acme",
      clientId: "acme-client",
      clientSecret: secret,
      scopes: ["openid", "email"],
      isEnabled: false,
    })
  );
  assert.equal(
    asTenant("tenant_oidc_a", () => oidc.getTenantOidcCredentials()),
    null
  );
});

test("tenant OIDC config rejects unsafe issuers, plaintext bypasses, and cross-tenant access", () => {
  createTenants();
  const setConfig = (input: Record<string, unknown>) =>
    asTenant("tenant_oidc_a", () =>
      oidc.setTenantOidcConfig({
        issuer: "https://idp.example.com",
        clientId: "client",
        clientSecret: "secret",
        ...input,
      } as oidc.setTenantOidcConfig extends (input: infer T) => unknown ? T : never)
    );
  assert.throws(() => setConfig({ issuer: "http://idp.example.com" }), /HTTPS URL/i);
  assert.throws(() => setConfig({ issuer: "https://user:pass@idp.example.com" }), /HTTPS URL/i);
  assert.throws(() => setConfig({ issuer: "https://idp.example.com?tenant=one" }), /HTTPS URL/i);
  assert.throws(() => setConfig({ clientSecret: "enc:v1:already-encrypted" }), /plaintext input/i);
  assert.throws(
    () =>
      asTenant("tenant_oidc_b", () =>
        oidc.setTenantOidcConfig({
          tenantId: "tenant_oidc_a",
          issuer: "https://idp.example.com",
          clientId: "client",
          clientSecret: "secret",
        })
      ),
    /cross-tenant database operation denied/i
  );
});

test("tenant identity mappings use exact issuer/subject and remain isolated", () => {
  createTenants();
  asTenant("tenant_oidc_a", () =>
    oidc.setTenantOidcConfig({
      issuer: "https://idp.example.com/realms/acme",
      clientId: "acme-client",
      clientSecret: "tenant-a-oidc-secret",
      isEnabled: true,
    })
  );
  const identity = asTenant("tenant_oidc_a", () =>
    oidc.addTenantOidcIdentity({
      issuer: "https://idp.example.com/realms/acme",
      subject: "user-123",
      principalId: "principal-acme-123",
    })
  );
  assert.equal(identity.tenantId, "tenant_oidc_a");
  assert.equal(identity.principalId, "principal-acme-123");
  assert.equal(
    asTenant("tenant_oidc_a", () =>
      oidc.getTenantOidcIdentityByIssuerSubject("https://idp.example.com/realms/acme", "user-123")
    )?.id,
    identity.id
  );
  assert.equal(
    asTenant("tenant_oidc_a", () =>
      oidc.getTenantOidcIdentityByIssuerSubject("https://idp.example.com/realms/acme/", "user-123")
    ),
    null,
    "issuer comparison must remain exact"
  );
  assert.equal(
    asTenant("tenant_oidc_b", () =>
      oidc.getTenantOidcIdentityByIssuerSubject("https://idp.example.com/realms/acme", "user-123")
    ),
    null,
    "lookup must be limited to the active tenant"
  );
  asTenant("tenant_oidc_b", () =>
    oidc.setTenantOidcConfig({
      issuer: "https://idp.example.com/realms/acme",
      clientId: "acme-client-b",
      clientSecret: "tenant-b-oidc-secret",
      isEnabled: true,
    })
  );
  const identityB = asTenant("tenant_oidc_b", () =>
    oidc.addTenantOidcIdentity({
      issuer: "https://idp.example.com/realms/acme",
      subject: "user-123",
      principalId: "principal-acme-b-123",
    })
  );
  assert.equal(identityB.tenantId, "tenant_oidc_b");
  assert.equal(identityB.principalId, "principal-acme-b-123");
  assert.equal(asTenant("tenant_oidc_b", () => oidc.listTenantOidcIdentities()).length, 1);
  assert.throws(
    () =>
      asTenant("tenant_oidc_a", () =>
        oidc.addTenantOidcIdentity({
          issuer: "https://idp.example.com/realms/acme",
          subject: "user-123",
          email: "user@example.com",
        } as Parameters<typeof oidc.addTenantOidcIdentity>[0])
      ),
    /Unrecognized key/i,
    "email is not a linking key or supported auto-join attribute"
  );
  assert.throws(
    () =>
      asTenant("tenant_oidc_a", () =>
        oidc.addTenantOidcIdentity({
          issuer: "https://idp.example.com/realms/acme",
          subject: "user-123",
        })
      ),
    /UNIQUE constraint failed/i
  );
  assert.equal(
    asTenant("tenant_oidc_a", () => oidc.removeTenantOidcIdentity(identity.id)),
    true
  );
  assert.equal(asTenant("tenant_oidc_a", () => oidc.listTenantOidcIdentities()).length, 0);
});

test("tenant OIDC identity links reject unconfigured, disabled, and mismatched issuers", () => {
  createTenants();
  const add = (issuer: string) =>
    asTenant("tenant_oidc_a", () => oidc.addTenantOidcIdentity({ issuer, subject: "user-123" }));
  assert.throws(() => add("https://idp.example.com"), /enabled OIDC configuration/i);

  asTenant("tenant_oidc_a", () =>
    oidc.setTenantOidcConfig({
      issuer: "https://idp.example.com/realms/acme",
      clientId: "acme-client",
      clientSecret: "tenant-a-oidc-secret",
      isEnabled: false,
    })
  );
  assert.throws(() => add("https://idp.example.com/realms/acme"), /enabled OIDC configuration/i);

  asTenant("tenant_oidc_a", () =>
    oidc.setTenantOidcConfig({
      issuer: "https://idp.example.com/realms/acme",
      clientId: "acme-client",
      clientSecret: "tenant-a-oidc-secret",
      isEnabled: true,
    })
  );
  assert.throws(() => add("https://idp.example.com/realms/other"), /enabled OIDC configuration/i);
  assert.equal(asTenant("tenant_oidc_a", () => oidc.listTenantOidcIdentities()).length, 0);
});

test("changing or disabling an issuer cannot leave stale identity links usable", () => {
  createTenants();
  asTenant("tenant_oidc_a", () =>
    oidc.setTenantOidcConfig({
      issuer: "https://idp.example.com/realms/acme",
      clientId: "acme-client",
      clientSecret: "tenant-a-oidc-secret",
      isEnabled: true,
    })
  );
  asTenant("tenant_oidc_a", () =>
    oidc.addTenantOidcIdentity({
      issuer: "https://idp.example.com/realms/acme",
      subject: "user-123",
    })
  );

  asTenant("tenant_oidc_a", () => oidc.disableTenantOidcConfig());
  assert.equal(
    asTenant("tenant_oidc_a", () =>
      oidc.getTenantOidcIdentityByIssuerSubject("https://idp.example.com/realms/acme", "user-123")
    ),
    null
  );

  asTenant("tenant_oidc_a", () =>
    oidc.setTenantOidcConfig({
      issuer: "https://idp.example.com/realms/other",
      clientId: "other-client",
      isEnabled: true,
    })
  );
  assert.equal(asTenant("tenant_oidc_a", () => oidc.listTenantOidcIdentities()).length, 0);
  asTenant("tenant_oidc_a", () =>
    oidc.setTenantOidcConfig({
      issuer: "https://idp.example.com/realms/acme",
      clientId: "acme-client",
      isEnabled: true,
    })
  );
  assert.equal(
    asTenant("tenant_oidc_a", () =>
      oidc.getTenantOidcIdentityByIssuerSubject("https://idp.example.com/realms/acme", "user-123")
    ),
    null,
    "changing issuers must remove the previous issuer's identity links"
  );
});

test("tenant OIDC config refuses storage without configured encryption", () => {
  createTenants();
  const encryptionKey = process.env.STORAGE_ENCRYPTION_KEY;
  delete process.env.STORAGE_ENCRYPTION_KEY;
  try {
    assert.throws(
      () =>
        asTenant("tenant_oidc_a", () =>
          oidc.setTenantOidcConfig({
            issuer: "https://idp.example.com",
            clientId: "client",
            clientSecret: "secret",
          })
        ),
      /STORAGE_ENCRYPTION_KEY is required/i
    );
    assert.equal(
      asTenant("tenant_oidc_a", () => oidc.getTenantOidcConfig()),
      null
    );
  } finally {
    if (encryptionKey !== undefined) process.env.STORAGE_ENCRYPTION_KEY = encryptionKey;
  }
});
