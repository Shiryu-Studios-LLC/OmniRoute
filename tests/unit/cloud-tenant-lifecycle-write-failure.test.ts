import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { handleCloudApiRequest } from "../../src/cloud/httpApi";

class SqliteStatement<T = unknown> implements CloudDbStatement<T> {
  private values: unknown[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): CloudDbStatement<T> {
    this.values = values;
    return this;
  }

  async first<U = T>(): Promise<U | null> {
    return (
      (this.db
        .prepare(this.sql)
        .get(...(this.values as (null | number | bigint | string | Uint8Array)[])) as
        U | undefined) ?? null
    );
  }

  async all<U = T>(): Promise<{ results: U[]; success: boolean; meta?: Record<string, unknown> }> {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...(this.values as (null | number | bigint | string | Uint8Array)[])) as U[],
      success: true,
    };
  }

  async run(): Promise<{ success: boolean; meta?: Record<string, unknown> }> {
    const result = this.db
      .prepare(this.sql)
      .run(...(this.values as (null | number | bigint | string | Uint8Array)[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 implements CloudDb {
  constructor(readonly db = new DatabaseSync(":memory:")) {}

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new SqliteStatement<T>(this.db, sql);
  }

  async batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    const results: unknown[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<unknown> {
    return this.db.exec(sql);
  }
}

function createDatabase(): SqliteD1 {
  const d1 = new SqliteD1();
  d1.db.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      kind TEXT NOT NULL, is_active INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE cloud_rate_limits (
      tenant_id TEXT NOT NULL, bucket_hash TEXT NOT NULL,
      window_started_at_ms INTEGER NOT NULL, window_ms INTEGER NOT NULL,
      limit_count INTEGER NOT NULL, request_count INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, bucket_hash)
    );
    CREATE TABLE cloud_compliance_audit (
      id TEXT NOT NULL, tenant_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      action TEXT NOT NULL, actor TEXT, target TEXT, details_json TEXT,
      ip_address TEXT, resource_type TEXT, status TEXT, request_id TEXT, metadata_json TEXT,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE cloud_gateway_devices (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL
    );
  `);
  const now = "2026-10-09T12:00:00.000Z";
  d1.db
    .prepare(
      `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    )
    .run("tenant_shiryu_admin", "Platform", "platform", "platform_admin", now, now);
  d1.db
    .prepare(
      `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    )
    .run("tenant-customer", "Customer", "customer", "customer", now, now);
  d1.db.exec(`
    CREATE TRIGGER ignore_customer_suspend
    BEFORE UPDATE OF is_active ON tenants
    WHEN OLD.id = 'tenant-customer' AND NEW.is_active = 0
    BEGIN SELECT RAISE(IGNORE); END;
  `);
  return d1;
}

test("lifecycle returns failure and omits success audit when tenant status does not persist", async () => {
  const d1 = createDatabase();
  try {
    const response = await handleCloudApiRequest(
      new Request("https://cloud.example.test/__cloud/v1/tenants/tenant-customer/status", {
        method: "POST",
        headers: {
          Authorization: "Bearer lifecycle-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "suspended" }),
      }),
      {
        db: d1,
        adminToken: "platform-secret",
        lifecycleAdminToken: "lifecycle-secret",
        now: () => new Date("2026-10-09T12:00:01.000Z"),
      }
    );

    assert.equal(response.status, 503);
    assert.equal(
      (
        d1.db.prepare("SELECT is_active FROM tenants WHERE id = 'tenant-customer'").get() as {
          is_active: number;
        }
      ).is_active,
      1
    );
    const audit = d1.db
      .prepare(
        `SELECT status FROM cloud_compliance_audit
          WHERE action = 'tenant.lifecycle.status' ORDER BY rowid`
      )
      .all() as Array<{ status: string }>;
    assert.deepEqual(
      audit.map((entry) => entry.status),
      ["attempted"]
    );
  } finally {
    d1.db.close();
  }
});
