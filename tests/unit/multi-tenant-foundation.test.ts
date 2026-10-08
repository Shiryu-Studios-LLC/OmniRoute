import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  getCurrentTenantId,
  getTenantContext,
  runWithTenantContext,
} from "../../src/lib/tenantContext";

test("tenant context isolates nested request identity", () => {
  assert.equal(getCurrentTenantId(), null);

  runWithTenantContext(
    { tenantId: "tenant_a", principalId: "key_a", role: "admin" },
    () => {
      assert.equal(getCurrentTenantId(), "tenant_a");
      assert.equal(getTenantContext()?.principalId, "key_a");

      runWithTenantContext({ tenantId: "tenant_b", principalId: "key_b" }, () => {
        assert.equal(getCurrentTenantId(), "tenant_b");
      });

      assert.equal(getCurrentTenantId(), "tenant_a");
    }
  );

  assert.equal(getCurrentTenantId(), null);
});

test("multi-tenant migration creates the Shiryu admin tenant and backfills existing resources", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT, key TEXT);
      INSERT INTO api_keys (id, name, key) VALUES ('key-1', 'existing', 'not-a-secret');

      CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT);
      INSERT INTO provider_connections (id, provider) VALUES ('conn-1', 'ollama');

      CREATE TABLE provider_nodes (id TEXT PRIMARY KEY, name TEXT);
      INSERT INTO provider_nodes (id, name) VALUES ('node-1', 'local');

      CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT);
      INSERT INTO combos (id, name) VALUES ('combo-1', 'default');
    `);

    const sql = fs.readFileSync(
      path.resolve("src/lib/db/migrations/164_multi_tenant_foundation.sql"),
      "utf8"
    );
    db.exec(sql);

    const tenant = db
      .prepare("SELECT id, name, slug, kind FROM tenants WHERE id = ?")
      .get("tenant_shiryu_admin");
    assert.deepEqual(tenant, {
      id: "tenant_shiryu_admin",
      name: "Shiryu Studios",
      slug: "shiryu-admin",
      kind: "platform_admin",
    });

    assert.deepEqual(
      db.prepare("SELECT tenant_id FROM api_keys WHERE id = 'key-1'").get(),
      { tenant_id: "tenant_shiryu_admin" }
    );
    assert.deepEqual(
      db.prepare("SELECT tenant_id FROM provider_connections WHERE id = 'conn-1'").get(),
      { tenant_id: "tenant_shiryu_admin" }
    );
    assert.deepEqual(
      db.prepare("SELECT tenant_id FROM provider_nodes WHERE id = 'node-1'").get(),
      { tenant_id: "tenant_shiryu_admin" }
    );
    assert.deepEqual(
      db.prepare("SELECT tenant_id FROM combos WHERE id = 'combo-1'").get(),
      { tenant_id: "tenant_shiryu_admin" }
    );

    assert.deepEqual(
      db
        .prepare("SELECT role FROM tenant_members WHERE tenant_id = ? AND principal_id = ?")
        .get("tenant_shiryu_admin", "dashboard"),
      { role: "owner" }
    );

    const mcpTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_mcp_servers'")
      .get();
    assert.ok(mcpTable);
  } finally {
    db.close();
  }
});
