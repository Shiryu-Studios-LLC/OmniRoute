import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { updateCloudCustomerBusinessProfile } from "../../src/cloud/customerBusinessProfile";
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

async function migratedDb() {
  const db = new TestD1();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0005_cloud_customer_identity.sql",
    "0008_cloud_tenant_settings.sql",
    "0023_cloud_tenant_business_profiles.sql",
    "0024_cloud_tenant_business_profile_configuration.sql",
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

test("business profile reports a failed D1 update batch as unavailable, not forbidden", async () => {
  const db = await migratedDb();
  try {
    const owner = await provisionCloudCustomer(db, {
      id: "profile-d1-failure",
      name: "Profile D1 Failure",
      slug: "profile-d1-failure",
      ownerPrincipalId: "profile-d1-failure-owner",
      now: "2026-10-08T12:00:00.000Z",
    });
    const app = createCloudRuntime({ env: { DB: failingBatchDb(db) } });
    const response = await app.fetch(
      new Request("https://omniroute.test/__cloud/v1/customer/business-profile", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${owner.ownerApiKey.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Updated Profile",
          description: "",
          hours: "",
          services: [],
          assistant: { name: "Desk", tone: "friendly", handoff: "Call us." },
        }),
      })
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Customer business profile could not be updated",
    });
    const row = await db
      .prepare("SELECT name FROM cloud_tenant_business_profiles WHERE tenant_id = ?")
      .bind("profile-d1-failure")
      .first<{ name: string }>();
    assert.equal(row?.name, "Profile D1 Failure");
  } finally {
    db.db.close();
  }
});

test("business profile does not report success when D1 ignores its audit insert", async () => {
  const db = await migratedDb();
  try {
    const owner = await provisionCloudCustomer(db, {
      id: "profile-audit-ignored",
      name: "Profile Audit Ignored",
      slug: "profile-audit-ignored",
      ownerPrincipalId: "profile-audit-ignored-owner",
      now: "2026-10-08T12:00:00.000Z",
    });
    await db.exec(`CREATE TRIGGER ignore_profile_audit
      BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action = 'customer.business_profile.update'
      BEGIN SELECT RAISE(IGNORE); END;`);
    const app = createCloudRuntime({
      env: { DB: db },
      now: () => new Date("2026-10-08T12:01:00.000Z"),
    });
    const response = await app.fetch(
      new Request("https://omniroute.test/__cloud/v1/customer/business-profile", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${owner.ownerApiKey.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Updated Profile",
          description: "",
          hours: "",
          services: [],
          assistant: { name: "Desk", tone: "friendly", handoff: "Call us." },
        }),
      })
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Customer business profile could not be updated",
    });
    const storedProfile = await db
      .prepare("SELECT name FROM cloud_tenant_business_profiles WHERE tenant_id = ?")
      .bind("profile-audit-ignored")
      .first<{ name: string }>();
    assert.equal(storedProfile?.name, "Profile Audit Ignored");
    assert.equal(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM cloud_compliance_audit WHERE tenant_id = ? AND action = ?"
          )
          .bind("profile-audit-ignored", "customer.business_profile.update")
          .first<{ count: number }>()
      )?.count,
      0
    );
  } finally {
    db.db.close();
  }
});

test("business profile rolls back audit when D1 ignores its update", async () => {
  const db = await migratedDb();
  try {
    const owner = await provisionCloudCustomer(db, {
      id: "profile-update-ignored",
      name: "Profile Update Ignored",
      slug: "profile-update-ignored",
      ownerPrincipalId: "profile-update-ignored-owner",
      now: "2026-10-08T12:00:00.000Z",
    });
    await db.exec(`CREATE TRIGGER ignore_profile_update
      BEFORE UPDATE ON cloud_tenant_business_profiles
      WHEN OLD.tenant_id = 'profile-update-ignored'
      BEGIN SELECT RAISE(IGNORE); END;`);
    const app = createCloudRuntime({
      env: { DB: db },
      now: () => new Date("2026-10-08T12:01:00.000Z"),
    });
    const response = await app.fetch(
      new Request("https://omniroute.test/__cloud/v1/customer/business-profile", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${owner.ownerApiKey.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Must Not Apply",
          description: "",
          hours: "",
          services: [],
          assistant: { name: "Desk", tone: "friendly", handoff: "Call us." },
        }),
      })
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Customer business profile could not be updated",
    });
    const storedProfile = await db
      .prepare("SELECT name FROM cloud_tenant_business_profiles WHERE tenant_id = ?")
      .bind("profile-update-ignored")
      .first<{ name: string }>();
    assert.equal(storedProfile?.name, "Profile Update Ignored");
    assert.equal(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM cloud_compliance_audit WHERE tenant_id = ? AND action = ?"
          )
          .bind("profile-update-ignored", "customer.business_profile.update")
          .first<{ count: number }>()
      )?.count,
      0
    );
  } finally {
    db.db.close();
  }
});

test("a pre-existing matching audit ID cannot authorize an ignored profile audit insert", async () => {
  const db = await migratedDb();
  try {
    const owner = await provisionCloudCustomer(db, {
      id: "profile-audit-collision",
      name: "Profile Audit Collision",
      slug: "profile-audit-collision",
      ownerPrincipalId: "profile-audit-collision-owner",
      now: "2026-10-08T12:00:00.000Z",
    });
    const auditId = "pre-existing-profile-audit";
    await db
      .prepare(
        `INSERT INTO cloud_compliance_audit (id, tenant_id, timestamp, action)
         VALUES (?, ?, ?, ?)`
      )
      .bind(
        auditId,
        owner.tenant.id,
        "2026-10-08T12:00:30.000Z",
        "customer.business_profile.update"
      )
      .run();
    await db.exec(`CREATE TRIGGER ignore_profile_audit_collision
      BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action = 'customer.business_profile.update'
      BEGIN SELECT RAISE(IGNORE); END;`);

    await assert.rejects(
      updateCloudCustomerBusinessProfile(db, {
        tenantId: owner.tenant.id,
        membershipId: owner.ownerMembership.id,
        authorization: { type: "api_key", apiKeyId: owner.ownerApiKey.id },
        profile: {
          name: "Must Not Apply",
          description: "",
          hours: "",
          services: [],
          assistant: { name: "Desk", tone: "friendly", handoff: "Call us." },
        },
        updatedAt: "2026-10-08T12:01:00.000Z",
        audit: {
          id: auditId,
          tenantId: owner.tenant.id,
          timestamp: "2026-10-08T12:01:00.000Z",
          action: "customer.business_profile.update",
          status: "success",
        },
      }),
      /UNIQUE constraint failed: cloud_tenant_business_profiles\.tenant_id/
    );

    const profile = await db
      .prepare("SELECT name FROM cloud_tenant_business_profiles WHERE tenant_id = ?")
      .bind(owner.tenant.id)
      .first<{ name: string }>();
    assert.equal(profile?.name, "Profile Audit Collision");
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
