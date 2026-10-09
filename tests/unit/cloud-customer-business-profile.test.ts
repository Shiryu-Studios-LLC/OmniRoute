import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { createCloudCustomerMembership } from "../../src/cloud/customerIdentity";
import { issueCloudCustomerApiKey } from "../../src/cloud/customerIdentity";
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
    "0023_cloud_tenant_business_profiles.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  return db;
}

test("customer business profile CRUD is tenant isolated, role gated, audited, and secret free", async () => {
  const db = await migratedDb();
  try {
    const a = await provisionCloudCustomer(db, {
      id: "profile-a",
      name: "Profile A",
      slug: "profile-a",
      ownerPrincipalId: "owner-a",
      now: "2026-10-08T12:00:00.000Z",
    });
    const b = await provisionCloudCustomer(db, {
      id: "profile-b",
      name: "Profile B",
      slug: "profile-b",
      ownerPrincipalId: "owner-b",
      now: "2026-10-08T12:00:00.000Z",
    });
    const member = await createCloudCustomerMembership(db, {
      tenantId: "profile-a",
      principalId: "member-a",
      role: "member",
      now: "2026-10-08T12:00:00.000Z",
    });
    const memberKey = await issueCloudCustomerApiKey(db, {
      tenantId: "profile-a",
      membershipId: member.id,
      now: "2026-10-08T12:00:00.000Z",
    });
    const app = createCloudRuntime({
      env: { DB: db },
      now: () => new Date("2026-10-08T12:01:00.000Z"),
    });
    const call = (token: string, method = "GET", body?: unknown) =>
      app.fetch(
        new Request("https://omniroute.test/__cloud/v1/customer/business-profile", {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );
    const initialA = (await (await call(a.ownerApiKey.token)).json()) as {
      name: string;
      services: unknown[];
      assistant: unknown;
    };
    assert.equal(initialA.name, "Profile A");
    assert.deepEqual(initialA.services, []);
    assert.ok(initialA.assistant);
    const profile = {
      name: "A Detail Shop",
      description: "Auto detailing",
      hours: "Mon-Sat 8-6",
      services: [{ name: "Full Detail", price: "$229+" }],
      assistant: { name: "A Front Desk", tone: "friendly", handoff: "Offer a human callback." },
    };
    assert.equal((await call(memberKey.token, "PUT", profile)).status, 403);
    assert.equal(
      (await call(a.ownerApiKey.token, "PUT", { ...profile, apiKey: "orc_live_sensitive" })).status,
      400
    );
    const updated = await call(a.ownerApiKey.token, "PUT", profile);
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), {
      tenantId: "profile-a",
      ...profile,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:01:00.000Z",
    });
    const bProfile = (await (await call(b.ownerApiKey.token)).json()) as {
      tenantId: string;
      name: string;
    };
    assert.equal(bProfile.tenantId, "profile-b");
    assert.equal(bProfile.name, "Profile B");
    const rows = await db
      .prepare("SELECT tenant_id, name FROM cloud_tenant_business_profiles ORDER BY tenant_id")
      .all<{ tenant_id: string; name: string }>();
    assert.deepEqual(
      Array.from(rows.results, (row) => ({ tenant_id: row.tenant_id, name: row.name })),
      [
        { tenant_id: "profile-a", name: "A Detail Shop" },
        { tenant_id: "profile-b", name: "Profile B" },
      ]
    );
    const audit = await db
      .prepare(
        "SELECT action, metadata_json FROM cloud_compliance_audit WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT 1"
      )
      .bind("profile-a")
      .first<{ action: string; metadata_json: string }>();
    assert.equal(audit?.action, "customer.business_profile.update");
    assert.ok(!JSON.stringify(audit).includes("orc_live_sensitive"));
    assert.ok(!JSON.stringify(await (await call(a.ownerApiKey.token)).json()).includes("apiKey"));
  } finally {
    db.db.close();
  }
});
