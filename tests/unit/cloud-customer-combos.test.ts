import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { provisionCloudCustomer } from "../../src/cloud/provisioning";
import { createCloudRuntime } from "../../src/cloud/runtime";

class Statement<T = unknown> implements CloudDbStatement<T> {
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
  async all<U = T>() {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...(this.values as (null | number | bigint | string | Uint8Array)[])) as U[],
      success: true,
    };
  }
  async run() {
    const result = this.db
      .prepare(this.sql)
      .run(...(this.values as (null | number | bigint | string | Uint8Array)[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class TestD1 implements CloudDb {
  readonly db = new DatabaseSync(":memory:");
  constructor() {
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new Statement<T>(this.db, sql);
  }
  async batch(statements: CloudDbStatement[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async exec(sql: string) {
    return this.db.exec(sql);
  }
}

async function migratedDb() {
  const db = new TestD1();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0005_cloud_customer_identity.sql",
    "0008_cloud_tenant_settings.sql",
    "0035_cloud_tenant_combos.sql",
  ])
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  return db;
}

test("customer combo CRUD is tenant scoped, owner/admin gated, audited atomically, and secret free", async () => {
  const db = await migratedDb();
  try {
    const a = await provisionCloudCustomer(db, {
      id: "combo-a",
      name: "Combo A",
      slug: "combo-a",
      ownerPrincipalId: "owner-a",
      now: "2026-10-08T12:00:00.000Z",
    });
    const b = await provisionCloudCustomer(db, {
      id: "combo-b",
      name: "Combo B",
      slug: "combo-b",
      ownerPrincipalId: "owner-b",
      now: "2026-10-08T12:00:00.000Z",
    });
    const app = createCloudRuntime({
      env: { DB: db },
      now: () => new Date("2026-10-08T12:01:00.000Z"),
    });
    const endpoint = "https://omniroute.test/__cloud/v1/customer/combos";
    const call = (token: string, path = "", method = "GET", body?: unknown) =>
      app.fetch(
        new Request(`${endpoint}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );
    const payload = {
      name: "default",
      description: "Fallback chain",
      models: ["openai/gpt-4o-mini", { kind: "model", provider: "openai", model: "gpt-4o-mini" }],
      strategy: "priority",
      config: { maxRetries: 2 },
    };
    const created = await call(a.ownerApiKey.token, "", "POST", payload);
    assert.equal(created.status, 201);
    const combo = (await created.json()) as { id: string; name: string; models: unknown[] };
    assert.equal(combo.name, payload.name);
    assert.equal((await call(a.ownerApiKey.token, `/${combo.id}`)).status, 200);
    assert.equal((await call(b.ownerApiKey.token, `/${combo.id}`)).status, 404);
    assert.equal(
      (
        await call(a.ownerApiKey.token, "", "POST", {
          ...payload,
          name: "bad",
          config: { apiKey: "sk-secret" },
        })
      ).status,
      400
    );
    assert.equal(
      (
        await call(a.ownerApiKey.token, "", "POST", {
          ...payload,
          models: [{ kind: "model", model: "x", metadata: { nested: { accessToken: "secret" } } }],
        })
      ).status,
      400
    );
    assert.equal((await call(a.ownerApiKey.token, "", "POST", payload)).status, 409);
    assert.equal(
      (
        await call(a.ownerApiKey.token, `/${combo.id}`, "PATCH", {
          name: "renamed",
          isActive: false,
        })
      ).status,
      200
    );
    assert.equal((await call(b.ownerApiKey.token)).status, 200);
    const bCreated = await call(b.ownerApiKey.token, "", "POST", payload);
    assert.equal(bCreated.status, 201, "other tenants may use the same combo name");
    assert.equal((await call(b.ownerApiKey.token, `/${combo.id}`, "DELETE")).status, 404);
    assert.equal((await call(a.ownerApiKey.token, `/${combo.id}`, "DELETE")).status, 200);
    const rows = await db
      .prepare<{ tenant_id: string; name: string }>(
        "SELECT tenant_id, name FROM cloud_tenant_combos ORDER BY tenant_id"
      )
      .all();
    assert.deepEqual(
      Array.from(rows.results, (row) => ({ tenant_id: row.tenant_id, name: row.name })),
      [{ tenant_id: "combo-b", name: "default" }]
    );
    const audit = await db
      .prepare<{ action: string; target: string; metadata_json: string | null }>(
        "SELECT action, target, metadata_json FROM cloud_compliance_audit WHERE tenant_id = ? ORDER BY rowid DESC LIMIT 1"
      )
      .bind("combo-a")
      .first();
    assert.equal(audit?.action, "cloud.tenant_combo.delete");
    assert.equal(audit?.target, combo.id);
    assert.ok(!JSON.stringify(audit).includes("sk-secret"));
    assert.ok(!JSON.stringify(await (await call(b.ownerApiKey.token)).json()).includes("apiKey"));
  } finally {
    db.db.close();
  }
});
