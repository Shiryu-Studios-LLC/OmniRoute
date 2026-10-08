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

  runWithTenantContext({ tenantId: "tenant_a", principalId: "key_a", role: "admin" }, () => {
    assert.equal(getCurrentTenantId(), "tenant_a");
    assert.equal(getTenantContext()?.principalId, "key_a");

    runWithTenantContext({ tenantId: "tenant_b", principalId: "key_b" }, () => {
      assert.equal(getCurrentTenantId(), "tenant_b");
    });

    assert.equal(getCurrentTenantId(), "tenant_a");
  });

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

    assert.deepEqual(db.prepare("SELECT tenant_id FROM api_keys WHERE id = 'key-1'").get(), {
      tenant_id: "tenant_shiryu_admin",
    });
    assert.deepEqual(
      db.prepare("SELECT tenant_id FROM provider_connections WHERE id = 'conn-1'").get(),
      { tenant_id: "tenant_shiryu_admin" }
    );
    assert.deepEqual(db.prepare("SELECT tenant_id FROM provider_nodes WHERE id = 'node-1'").get(), {
      tenant_id: "tenant_shiryu_admin",
    });
    assert.deepEqual(db.prepare("SELECT tenant_id FROM combos WHERE id = 'combo-1'").get(), {
      tenant_id: "tenant_shiryu_admin",
    });

    assert.deepEqual(
      db
        .prepare("SELECT role FROM tenant_members WHERE tenant_id = ? AND principal_id = ?")
        .get("tenant_shiryu_admin", "dashboard"),
      { role: "owner" }
    );

    const mcpTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_mcp_servers'"
      )
      .get();
    assert.ok(mcpTable);
  } finally {
    db.close();
  }
});

test("combo tenant migration preserves combo data, indexes, foreign keys, and delete cleanup", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        system_message TEXT DEFAULT NULL,
        tool_filter_regex TEXT DEFAULT NULL,
        context_cache_protection INTEGER DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        tenant_id TEXT
      );
      CREATE INDEX idx_combos_cache_protection ON combos(context_cache_protection);
      CREATE TABLE combo_children (
        id TEXT PRIMARY KEY,
        combo_id TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE
      );
      CREATE TABLE reasoning_routing_rules (
        id TEXT PRIMARY KEY,
        combo_id TEXT,
        target_combo_id TEXT
      );
      CREATE TRIGGER trg_reasoning_rules_combo_delete
      AFTER DELETE ON combos BEGIN
        DELETE FROM reasoning_routing_rules WHERE combo_id = OLD.id OR target_combo_id = OLD.id;
      END;
      INSERT INTO combos VALUES (
        'combo-admin', 'Default', '{"name":"Default"}', 'created', 'updated',
        'system prompt', '^tool_', 1, 7, 'tenant_shiryu_admin'
      );
      INSERT INTO combo_children VALUES ('child-1', 'combo-admin');
      INSERT INTO reasoning_routing_rules VALUES ('rule-1', 'combo-admin', NULL);
    `);

    const sql = fs.readFileSync(
      path.resolve("src/lib/db/migrations/165_tenant_unique_combo_names.sql"),
      "utf8"
    );
    db.exec(sql);

    const persisted = db.prepare("SELECT * FROM combos WHERE id = 'combo-admin'").get();
    assert.deepEqual(persisted, {
      id: "combo-admin",
      name: "Default",
      data: '{"name":"Default"}',
      created_at: "created",
      updated_at: "updated",
      system_message: "system prompt",
      tool_filter_regex: "^tool_",
      context_cache_protection: 1,
      sort_order: 7,
      tenant_id: "tenant_shiryu_admin",
    });

    db.prepare(
      "INSERT INTO combos (id, tenant_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("combo-customer", "tenant_customer", "Default", "{}", "created", "updated");
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO combos (id, tenant_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run("combo-duplicate", "tenant_customer", "Default", "{}", "created", "updated"),
      /UNIQUE constraint failed/
    );

    const childForeignKey = db.pragma("foreign_key_list(combo_children)") as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    assert.deepEqual(childForeignKey, [
      {
        id: 0,
        seq: 0,
        table: "combos",
        from: "combo_id",
        to: "id",
        on_update: "NO ACTION",
        on_delete: "CASCADE",
        match: "NONE",
      },
    ]);

    db.prepare("DELETE FROM combos WHERE id = ?").run("combo-admin");
    assert.equal(db.prepare("SELECT id FROM combo_children WHERE id = 'child-1'").get(), undefined);
    assert.equal(
      db.prepare("SELECT id FROM reasoning_routing_rules WHERE id = 'rule-1'").get(),
      undefined
    );

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'combos'")
      .all() as Array<{ name: string }>;
    assert.ok(indexes.some(({ name }) => name === "idx_combos_cache_protection"));
    assert.ok(indexes.some(({ name }) => name === "idx_combos_tenant_sort"));
  } finally {
    db.close();
  }
});

test("circuit-breaker migration assigns legacy state to the platform tenant idempotently", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE domain_circuit_breakers (
        name TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'CLOSED',
        failure_count INTEGER DEFAULT 0,
        last_failure_time INTEGER,
        options TEXT
      );
      INSERT INTO domain_circuit_breakers (name, state, failure_count)
      VALUES ('openai', 'OPEN', 3);
    `);

    const sql = fs.readFileSync(
      path.resolve("src/lib/db/migrations/167_tenant_circuit_breaker_state.sql"),
      "utf8"
    );
    db.exec(sql);
    db.exec(sql);

    assert.deepEqual(
      db.prepare("SELECT name, state, failure_count FROM domain_circuit_breakers").all(),
      [{ name: "19:tenant_shiryu_admin:openai", state: "OPEN", failure_count: 3 }]
    );
  } finally {
    db.close();
  }
});
