import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-key-expiry-audit-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-key-expiry-audit-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const tenants = await import("../../src/lib/db/tenants.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");

async function resetStorage() {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  core.getDbInstance();
}

test.beforeEach(resetStorage);
test.after(() => {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("natural API-key expiry is audited once across concurrent validations", async () => {
  const tenant = tenants.createCustomerTenant("Expiry Audit Tenant", "expiry-audit-tenant");
  const key = await runWithTenantContext(
    { tenantId: tenant.id, principalId: "expiry-audit-owner", role: "owner" },
    () => apiKeys.createApiKey("Naturally expired key", "expiry-audit-test")
  );
  const expiresAt = new Date(Date.now() - 60_000).toISOString();
  assert.equal(
    await runWithTenantContext(
      { tenantId: tenant.id, principalId: "expiry-audit-owner", role: "owner" },
      () => apiKeys.setApiKeyExpiry(key.id, expiresAt)
    ),
    true
  );

  const validations = await Promise.all(
    Array.from({ length: 12 }, () => apiKeys.validateApiKey(key.key))
  );
  assert.deepEqual(validations, Array(12).fill(false));

  const db = core.getDbInstance();
  const auditRows = db
    .prepare("SELECT tenant_id, action, details FROM audit_log WHERE target = ? ORDER BY id")
    .all(key.id) as Array<{ tenant_id: string; action: string; details: string | null }>;
  assert.equal(auditRows.filter((row) => row.action === "apiKey.expired").length, 1);
  assert.equal(auditRows.filter((row) => row.action === "apiKey.expiry.update").length, 1);
  const naturalExpiry = auditRows.find((row) => row.action === "apiKey.expired");
  assert.equal(naturalExpiry?.tenant_id, tenant.id);
  assert.deepEqual(JSON.parse(naturalExpiry?.details ?? "null"), {
    tenantId: tenant.id,
    expiresAt,
  });
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM api_key_expiry_audit_markers WHERE api_key_id = ?")
      .get(key.id)?.count,
    1
  );
});

test("a positive local validation cache does not outlive the API key expiration", async () => {
  const key = await apiKeys.createApiKey("Cached expiry key", "expiry-cache-test");
  const expiresAt = new Date(Date.now() + 100).toISOString();
  assert.equal(await apiKeys.setApiKeyExpiry(key.id, expiresAt), true);
  assert.equal(await apiKeys.validateApiKey(key.key), true);

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(await apiKeys.validateApiKey(key.key), false);
  const db = core.getDbInstance();
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'apiKey.expired' AND target = ?"
      )
      .get(key.id)?.count,
    1
  );
});

test("failed audit persistence rolls back the marker so a later validation can retry", async () => {
  const key = await apiKeys.createApiKey("Retry expired key", "expiry-audit-retry");
  const expiresAt = new Date(Date.now() - 60_000).toISOString();
  await apiKeys.setApiKeyExpiry(key.id, expiresAt);
  const db = core.getDbInstance();
  db.exec(`CREATE TRIGGER reject_natural_expiry_audit BEFORE INSERT ON audit_log
    WHEN NEW.action = 'apiKey.expired' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);

  assert.equal(await apiKeys.validateApiKey(key.key), false);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM api_key_expiry_audit_markers WHERE api_key_id = ?")
      .get(key.id)?.count,
    0
  );

  db.exec("DROP TRIGGER reject_natural_expiry_audit");
  assert.equal(await apiKeys.validateApiKey(key.key), false);
  const rows = db.prepare("SELECT action FROM audit_log WHERE target = ?").all(key.id) as Array<{
    action: string;
  }>;
  assert.equal(rows.filter((row) => row.action === "apiKey.expired").length, 1);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM api_key_expiry_audit_markers WHERE api_key_id = ?")
      .get(key.id)?.count,
    1
  );
});
