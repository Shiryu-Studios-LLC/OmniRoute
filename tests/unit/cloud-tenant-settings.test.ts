import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { provisionCloudCustomer } from "../../src/cloud/provisioning";
import { getCloudTenantSettings } from "../../src/cloud/tenantSettings";

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

  async all<U = T>(): Promise<{ results: U[]; success: boolean }> {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...(this.values as (null | number | bigint | string | Uint8Array)[])) as U[],
      success: true,
    };
  }

  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    const result = this.db
      .prepare(this.sql)
      .run(...(this.values as (null | number | bigint | string | Uint8Array)[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteCloudDb implements CloudDb {
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new SqliteStatement<T>(this.db, sql);
  }

  async batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results: unknown[] = [];
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

async function migratedDb(): Promise<SqliteCloudDb> {
  const db = new SqliteCloudDb();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0004_cloud_gateway_devices.sql",
    "0005_cloud_customer_identity.sql",
    "0006_gateway_invocation_idempotency.sql",
    "0007_gateway_device_service_health.sql",
    "0008_cloud_tenant_settings.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  return db;
}

test("cloud tenant settings migration is idempotent and backfills customer tenants", async () => {
  const db = await migratedDb();
  try {
    await db.exec(
      readFileSync(
        join(process.cwd(), "cloudflare/migrations/0008_cloud_tenant_settings.sql"),
        "utf8"
      )
    );
    const settings = await getCloudTenantSettings(db, "tenant_shiryu_admin");
    assert.equal(settings, null, "platform tenant must not receive customer settings");

    await db
      .prepare(
        `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
         VALUES ('tenant-existing', 'Existing', 'existing', 'customer', 1, '2026-10-08', '2026-10-08')`
      )
      .run();
    assert.deepEqual(await getCloudTenantSettings(db, "tenant-existing"), {
      tenantId: "tenant-existing",
      localAiEnabled: false,
      mcpEnabled: false,
      createdAt: "2026-10-08",
      updatedAt: "2026-10-08",
    });

    await assert.rejects(
      db
        .prepare(
          `UPDATE cloud_tenant_settings SET local_ai_enabled = 2 WHERE tenant_id = 'tenant-existing'`
        )
        .run(),
      /CHECK constraint failed/
    );
  } finally {
    db.db.close();
  }
});

test("customer provisioning returns tenant-bound opt-in settings initialized by the tenant insert", async () => {
  const db = await migratedDb();
  try {
    const result = await provisionCloudCustomer(db, {
      id: "tenant-new",
      name: "New Tenant",
      slug: "new-tenant",
      ownerPrincipalId: "owner-principal",
      now: "2026-10-08T12:00:00.000Z",
    });
    assert.deepEqual(result.settings, {
      tenantId: "tenant-new",
      localAiEnabled: false,
      mcpEnabled: false,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
    assert.equal(
      (await db
        .prepare("SELECT tenant_id FROM cloud_tenant_settings WHERE tenant_id = ?")
        .bind("tenant-new")
        .first()) !== null,
      true
    );
  } finally {
    db.db.close();
  }
});
