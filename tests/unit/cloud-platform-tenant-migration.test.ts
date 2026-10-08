import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync(
  join(process.cwd(), "cloudflare/migrations/0003_cloud_platform_tenant.sql"),
  "utf8"
);

function createTenantDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('platform_admin', 'customer')),
      is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

test("cloud migration idempotently seeds the stable platform tenant", () => {
  const db = createTenantDb();
  try {
    db.exec(migration);
    db.exec(migration);
    const row = db
      .prepare("SELECT id, kind, is_active FROM tenants WHERE id = ?")
      .get("tenant_shiryu_admin") as { id: string; kind: string; is_active: number } | undefined;
    assert.deepEqual(row && { ...row }, {
      id: "tenant_shiryu_admin",
      kind: "platform_admin",
      is_active: 1,
    });
  } finally {
    db.close();
  }
});

test("cloud platform seed never overwrites an existing tenant row", () => {
  const db = createTenantDb();
  try {
    db.prepare(
      "INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "tenant_shiryu_admin",
      "Existing operator data",
      "existing-operator",
      "customer",
      0,
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z"
    );
    db.exec(migration);
    const row = db
      .prepare("SELECT name, slug, kind, is_active FROM tenants WHERE id = ?")
      .get("tenant_shiryu_admin") as
      { name: string; slug: string; kind: string; is_active: number } | undefined;
    assert.deepEqual(row && { ...row }, {
      name: "Existing operator data",
      slug: "existing-operator",
      kind: "customer",
      is_active: 0,
    });
  } finally {
    db.close();
  }
});
