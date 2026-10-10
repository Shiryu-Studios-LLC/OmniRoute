import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import {
  createCloudCustomerMembership,
  issueCloudCustomerApiKey,
} from "../../src/cloud/customerIdentity";
import { provisionCloudCustomer } from "../../src/cloud/provisioning";
import { createCloudRuntime } from "../../src/cloud/runtime";
import { handleCloudCustomerSettingsRequest } from "../../src/cloud/tenantSettingsHttpApi";
import { getCloudTenantSettings, updateCloudTenantSettings } from "../../src/cloud/tenantSettings";

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

function failingBatchDb(db: CloudDb): CloudDb {
  return {
    prepare: (sql) => db.prepare(sql),
    batch: async () => [
      { success: false, meta: { changes: 0 } },
      { success: false, meta: { changes: 0 } },
    ],
    exec: (sql) => db.exec(sql),
  };
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

test("customer settings are tenant-derived, role-gated, and audited atomically", async () => {
  const db = await migratedDb();
  try {
    const ownerA = await provisionCloudCustomer(db, {
      id: "settings-a",
      name: "Settings A",
      slug: "settings-a",
      ownerPrincipalId: "settings-owner-a",
      now: "2026-10-08T12:00:00.000Z",
    });
    const ownerB = await provisionCloudCustomer(db, {
      id: "settings-b",
      name: "Settings B",
      slug: "settings-b",
      ownerPrincipalId: "settings-owner-b",
      now: "2026-10-08T12:00:00.000Z",
    });
    const member = await createCloudCustomerMembership(db, {
      tenantId: "settings-a",
      principalId: "settings-member-a",
      role: "member",
      now: "2026-10-08T12:00:00.000Z",
    });
    const memberKey = await issueCloudCustomerApiKey(db, {
      tenantId: "settings-a",
      membershipId: member.id,
      now: "2026-10-08T12:00:00.000Z",
    });
    const app = createCloudRuntime({
      env: { DB: db },
      now: () => new Date("2026-10-08T12:01:00.000Z"),
    });
    const get = async (token: string) =>
      app.fetch(
        new Request("https://omniroute.test/__cloud/v1/customer/settings", {
          headers: { Authorization: `Bearer ${token}` },
        })
      );
    const update = async (token: string, body: unknown) =>
      app.fetch(
        new Request("https://omniroute.test/__cloud/v1/customer/settings", {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        })
      );

    assert.equal(
      (await app.fetch(new Request("https://omniroute.test/__cloud/v1/customer/settings"))).status,
      401,
      "the public settings route must still require a customer bearer API key"
    );
    assert.equal((await get(ownerA.ownerApiKey.token)).status, 200);
    assert.equal(
      (await update(memberKey.token, { localAiEnabled: true, mcpEnabled: false })).status,
      403
    );
    const updateResponse = await update(ownerA.ownerApiKey.token, {
      localAiEnabled: true,
      mcpEnabled: true,
    });
    assert.equal(updateResponse.status, 200);
    assert.deepEqual(await updateResponse.json(), {
      tenantId: "settings-a",
      localAiEnabled: true,
      mcpEnabled: true,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:01:00.000Z",
    });
    assert.equal((await get(ownerB.ownerApiKey.token)).status, 200);
    assert.deepEqual(await (await get(ownerB.ownerApiKey.token)).json(), {
      tenantId: "settings-b",
      localAiEnabled: false,
      mcpEnabled: false,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
    assert.equal(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM cloud_compliance_audit WHERE tenant_id = ? AND action = ?"
          )
          .bind("settings-a", "customer.settings.update")
          .first<{ count: number }>()
      )?.count,
      1
    );

    await db.exec(`CREATE TRIGGER reject_customer_settings_audit
      BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action = 'customer.settings.update'
      BEGIN SELECT RAISE(ABORT, 'settings audit unavailable'); END;`);
    const rejectedUpdate = await update(ownerA.ownerApiKey.token, {
      localAiEnabled: false,
      mcpEnabled: false,
    });
    assert.equal(rejectedUpdate.status, 503);
    assert.equal(
      (
        (await get(ownerA.ownerApiKey.token).then((response) => response.json())) as {
          localAiEnabled: boolean;
          mcpEnabled: boolean;
        }
      ).localAiEnabled,
      true
    );
  } finally {
    db.db.close();
  }
});

test("customer settings reports a failed D1 update batch as unavailable, not forbidden", async () => {
  const db = await migratedDb();
  try {
    const owner = await provisionCloudCustomer(db, {
      id: "settings-d1-failure",
      name: "Settings D1 Failure",
      slug: "settings-d1-failure",
      ownerPrincipalId: "settings-d1-failure-owner",
      now: "2026-10-08T12:00:00.000Z",
    });
    const response = await handleCloudCustomerSettingsRequest(
      new Request("https://omniroute.test/__cloud/v1/customer/settings", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${owner.ownerApiKey.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ localAiEnabled: false, mcpEnabled: true }),
      }),
      {
        db: failingBatchDb(db),
        now: () => new Date("2026-10-08T12:01:00.000Z"),
      }
    );

    assert.equal(response?.status, 503);
    assert.deepEqual(await response?.json(), { error: "Customer settings could not be updated" });
    assert.deepEqual(await getCloudTenantSettings(db, "settings-d1-failure"), {
      tenantId: "settings-d1-failure",
      localAiEnabled: false,
      mcpEnabled: false,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
  } finally {
    db.db.close();
  }
});

test("customer settings does not report success when D1 ignores its audit insert", async () => {
  const db = await migratedDb();
  try {
    const owner = await provisionCloudCustomer(db, {
      id: "settings-audit-ignored",
      name: "Settings Audit Ignored",
      slug: "settings-audit-ignored",
      ownerPrincipalId: "settings-audit-ignored-owner",
      now: "2026-10-08T12:00:00.000Z",
    });
    await db.exec(`CREATE TRIGGER ignore_settings_audit
      BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action = 'customer.settings.update'
      BEGIN SELECT RAISE(IGNORE); END;`);
    const response = await handleCloudCustomerSettingsRequest(
      new Request("https://omniroute.test/__cloud/v1/customer/settings", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${owner.ownerApiKey.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ localAiEnabled: false, mcpEnabled: true }),
      }),
      {
        db,
        now: () => new Date("2026-10-08T12:01:00.000Z"),
      }
    );

    assert.equal(response?.status, 503);
    assert.deepEqual(await response?.json(), { error: "Customer settings could not be updated" });
    assert.deepEqual(await getCloudTenantSettings(db, "settings-audit-ignored"), {
      tenantId: "settings-audit-ignored",
      localAiEnabled: false,
      mcpEnabled: false,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
    assert.equal(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM cloud_compliance_audit WHERE tenant_id = ? AND action = ?"
          )
          .bind("settings-audit-ignored", "customer.settings.update")
          .first<{ count: number }>()
      )?.count,
      0
    );
  } finally {
    db.db.close();
  }
});

test("customer settings rolls back audit when D1 ignores its update", async () => {
  const db = await migratedDb();
  try {
    const owner = await provisionCloudCustomer(db, {
      id: "settings-update-ignored",
      name: "Settings Update Ignored",
      slug: "settings-update-ignored",
      ownerPrincipalId: "settings-update-ignored-owner",
      now: "2026-10-08T12:00:00.000Z",
    });
    await db.exec(`CREATE TRIGGER ignore_settings_update
      BEFORE UPDATE ON cloud_tenant_settings
      WHEN OLD.tenant_id = 'settings-update-ignored'
      BEGIN SELECT RAISE(IGNORE); END;`);
    const response = await handleCloudCustomerSettingsRequest(
      new Request("https://omniroute.test/__cloud/v1/customer/settings", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${owner.ownerApiKey.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ localAiEnabled: true, mcpEnabled: true }),
      }),
      { db, now: () => new Date("2026-10-08T12:01:00.000Z") }
    );

    assert.equal(response?.status, 503);
    assert.deepEqual(await response?.json(), { error: "Customer settings could not be updated" });
    assert.deepEqual(await getCloudTenantSettings(db, "settings-update-ignored"), {
      tenantId: "settings-update-ignored",
      localAiEnabled: false,
      mcpEnabled: false,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
    assert.equal(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM cloud_compliance_audit WHERE tenant_id = ? AND action = ?"
          )
          .bind("settings-update-ignored", "customer.settings.update")
          .first<{ count: number }>()
      )?.count,
      0
    );
  } finally {
    db.db.close();
  }
});

test("a pre-existing matching audit ID cannot authorize an ignored settings audit insert", async () => {
  const db = await migratedDb();
  try {
    const owner = await provisionCloudCustomer(db, {
      id: "settings-audit-collision",
      name: "Settings Audit Collision",
      slug: "settings-audit-collision",
      ownerPrincipalId: "settings-audit-collision-owner",
      now: "2026-10-08T12:00:00.000Z",
    });
    const auditId = "pre-existing-settings-audit";
    await db
      .prepare(
        `INSERT INTO cloud_compliance_audit (id, tenant_id, timestamp, action)
         VALUES (?, ?, ?, ?)`
      )
      .bind(auditId, owner.tenant.id, "2026-10-08T12:00:30.000Z", "customer.settings.update")
      .run();
    await db.exec(`CREATE TRIGGER ignore_settings_audit_collision
      BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action = 'customer.settings.update'
      BEGIN SELECT RAISE(IGNORE); END;`);

    await assert.rejects(
      updateCloudTenantSettings(db, {
        tenantId: owner.tenant.id,
        membershipId: owner.ownerMembership.id,
        authorization: { type: "api_key", apiKeyId: owner.ownerApiKey.id },
        localAiEnabled: true,
        mcpEnabled: true,
        updatedAt: "2026-10-08T12:01:00.000Z",
        audit: {
          id: auditId,
          tenantId: owner.tenant.id,
          timestamp: "2026-10-08T12:01:00.000Z",
          action: "customer.settings.update",
          status: "success",
        },
      }),
      /UNIQUE constraint failed: cloud_tenant_settings\.tenant_id/
    );

    assert.deepEqual(await getCloudTenantSettings(db, owner.tenant.id), {
      tenantId: owner.tenant.id,
      localAiEnabled: false,
      mcpEnabled: false,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
    const preservedAudit = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM cloud_compliance_audit WHERE tenant_id = ? AND id = ?"
      )
      .bind(owner.tenant.id, auditId)
      .first<{ count: number }>();
    assert.equal(preservedAudit?.count, 1);
  } finally {
    db.db.close();
  }
});

test("customer settings applies pre-auth IP limits and bounded streaming body reads", async () => {
  const db = await migratedDb();
  try {
    const owner = await provisionCloudCustomer(db, {
      id: "settings-bounds",
      name: "Settings Bounds",
      slug: "settings-bounds",
      ownerPrincipalId: "settings-bounds-owner",
      now: "2026-10-08T12:00:00.000Z",
    });
    const now = () => new Date("2026-10-08T12:01:00.000Z");
    const request = (token: string) => {
      const result = new Request("https://omniroute.test/__cloud/v1/customer/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      Object.defineProperty(result, "cf", { value: {} });
      result.headers.set("cf-connecting-ip", "203.0.113.17");
      return result;
    };
    const authOptions = {
      db,
      now,
      failedKeyRateLimit: { limit: 1, windowMs: 60_000 },
    };
    assert.equal(
      (await handleCloudCustomerSettingsRequest(request("orc_live_invalid"), authOptions))?.status,
      401
    );
    assert.equal(
      (await handleCloudCustomerSettingsRequest(request("orc_live_invalid"), authOptions))?.status,
      429
    );

    let cancelled = false;
    const oversized = new Request("https://omniroute.test/__cloud/v1/customer/settings", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${owner.ownerApiKey.token}`,
        "Content-Type": "application/json",
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16 * 1024 + 1).fill(32));
        },
        cancel() {
          cancelled = true;
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const oversizedResponse = await handleCloudCustomerSettingsRequest(oversized, { db, now });
    assert.equal(oversizedResponse?.status, 413);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelled, true);

    let slowCancelled = false;
    const slow = new Request("https://omniroute.test/__cloud/v1/customer/settings", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${owner.ownerApiKey.token}`,
        "Content-Type": "application/json",
      },
      body: new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          slowCancelled = true;
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const slowResponse = await handleCloudCustomerSettingsRequest(slow, {
      db,
      now,
      bodyReadTimeoutMs: 5,
    });
    assert.equal(slowResponse?.status, 408);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(slowCancelled, true);
  } finally {
    db.db.close();
  }
});
