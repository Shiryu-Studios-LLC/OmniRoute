import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { handleCloudApiRequest } from "../../src/cloud/httpApi";
import {
  authenticateCloudCustomerApiKey,
  createCloudCustomerMembership,
  issueCloudCustomerApiKey,
  revokeCloudCustomerApiKey,
} from "../../src/cloud/customerIdentity";

class MockD1Statement<T = unknown> implements CloudDbStatement<T> {
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

class MockD1 implements CloudDb {
  readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new MockD1Statement<T>(this.db, sql);
  }

  async batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  async exec(sql: string): Promise<unknown> {
    return this.db.exec(sql);
  }
}

async function fixture() {
  const d1 = new MockD1();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0004_cloud_gateway_devices.sql",
    "0005_cloud_customer_identity.sql",
  ]) {
    await d1.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  const now = "2026-10-08T12:00:00.000Z";
  await d1
    .prepare(
      `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
       VALUES ('tenant-customer', 'Customer', 'customer', 'customer', 1, ?, ?)`
    )
    .bind(now, now)
    .run();
  return { d1, now };
}

test("D1 customer identity migration is idempotent", async () => {
  const { d1 } = await fixture();
  await d1.exec(
    readFileSync(
      join(process.cwd(), "cloudflare/migrations/0005_cloud_customer_identity.sql"),
      "utf8"
    )
  );
  const tables = await d1
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cloud_customer_%'"
    )
    .all();
  assert.deepEqual(tables.results.map((table) => table.name).sort(), [
    "cloud_customer_api_keys",
    "cloud_customer_memberships",
  ]);
  d1.db.close();
});

test("platform admin can provision a tenant, owner membership, and one-time key in one request", async () => {
  const { d1, now } = await fixture();
  try {
    const request = new Request("https://omniroute.test/__cloud/v1/tenants", {
      method: "POST",
      headers: {
        Authorization: "Bearer platform-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "tenant-new-customer",
        name: "New Customer",
        slug: "new-customer",
        ownerPrincipalId: "verified-owner-subject",
      }),
    });
    const response = await handleCloudApiRequest(request, {
      db: d1,
      adminToken: "platform-secret",
      now: () => new Date(now),
    });
    assert.equal(response.status, 201);
    const provisioned = (await response.json()) as {
      tenant: { id: string; kind: string };
      ownerMembership: { tenantId: string; principalId: string; role: string };
      ownerApiKey: { id: string; token: string };
    };
    assert.deepEqual(
      {
        tenant: provisioned.tenant,
        ownerMembership: provisioned.ownerMembership,
      },
      {
        tenant: {
          id: "tenant-new-customer",
          name: "New Customer",
          slug: "new-customer",
          kind: "customer",
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        ownerMembership: {
          id: provisioned.ownerMembership.id,
          tenantId: "tenant-new-customer",
          principalId: "verified-owner-subject",
          role: "owner",
        },
      }
    );
    assert.match(provisioned.ownerApiKey.token, /^orc_live_[A-Za-z0-9_-]{43}$/);
    assert.equal(
      (await authenticateCloudCustomerApiKey(d1, provisioned.ownerApiKey.token, now))?.tenantId,
      "tenant-new-customer"
    );
    const storedKey = await d1
      .prepare<{ key_hash: string }>("SELECT key_hash FROM cloud_customer_api_keys WHERE id = ?")
      .bind(provisioned.ownerApiKey.id)
      .first();
    assert.notEqual(storedKey?.key_hash, provisioned.ownerApiKey.token);
    const provisionAudit = await d1
      .prepare<{ metadata_json: string | null }>(
        "SELECT metadata_json FROM cloud_compliance_audit WHERE action = 'customer.provision'"
      )
      .all();
    assert.ok(provisionAudit.results.length === 1);
    assert.ok(!provisionAudit.results[0].metadata_json?.includes(provisioned.ownerApiKey.token));

    const collision = await handleCloudApiRequest(
      new Request("https://omniroute.test/__cloud/v1/tenants", {
        method: "POST",
        headers: {
          Authorization: "Bearer platform-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "tenant-uncreated",
          name: "Collision",
          slug: "new-customer",
          ownerPrincipalId: "verified-owner-subject-2",
        }),
      }),
      { db: d1, adminToken: "platform-secret", now: () => new Date(now) }
    );
    assert.equal(collision.status, 409);
    assert.equal(
      await d1.prepare("SELECT id FROM tenants WHERE id = 'tenant-uncreated'").first(),
      null
    );
  } finally {
    d1.db.close();
  }
});

test("customer provisioning compensates tenant and owner writes when key issuance fails", async () => {
  const { d1, now } = await fixture();
  try {
    await d1.exec(`
      CREATE TRIGGER fail_customer_key BEFORE INSERT ON cloud_customer_api_keys
      BEGIN SELECT RAISE(ABORT, 'injected key storage failure'); END;
    `);
    const response = await handleCloudApiRequest(
      new Request("https://omniroute.test/__cloud/v1/tenants", {
        method: "POST",
        headers: {
          Authorization: "Bearer platform-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "tenant-rollback",
          name: "Rollback Customer",
          slug: "rollback-customer",
          ownerPrincipalId: "verified-owner-rollback",
        }),
      }),
      { db: d1, adminToken: "platform-secret", now: () => new Date(now) }
    );
    assert.equal(response.status, 500);
    assert.equal(
      await d1.prepare("SELECT id FROM tenants WHERE id = 'tenant-rollback'").first(),
      null
    );
    assert.equal(
      await d1
        .prepare("SELECT id FROM cloud_customer_memberships WHERE tenant_id = 'tenant-rollback'")
        .first(),
      null
    );
    assert.equal(
      await d1
        .prepare("SELECT id FROM cloud_customer_api_keys WHERE tenant_id = 'tenant-rollback'")
        .first(),
      null
    );
  } finally {
    d1.db.close();
  }
});

test("customer provisioning removes the tenant if its success audit cannot be written", async () => {
  const { d1, now } = await fixture();
  try {
    await d1.exec(`
      CREATE TRIGGER fail_provision_audit BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action = 'customer.provision'
      BEGIN SELECT RAISE(ABORT, 'injected audit storage failure'); END;
    `);
    const response = await handleCloudApiRequest(
      new Request("https://omniroute.test/__cloud/v1/tenants", {
        method: "POST",
        headers: {
          Authorization: "Bearer platform-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "tenant-audit-rollback",
          name: "Audit Rollback Customer",
          slug: "audit-rollback-customer",
          ownerPrincipalId: "verified-owner-audit-rollback",
        }),
      }),
      { db: d1, adminToken: "platform-secret", now: () => new Date(now) }
    );
    assert.equal(response.status, 503);
    assert.equal(
      await d1.prepare("SELECT id FROM tenants WHERE id = 'tenant-audit-rollback'").first(),
      null
    );
    const attemptAudit = await d1
      .prepare(
        "SELECT COUNT(*) AS count FROM cloud_compliance_audit WHERE action = 'cloud.api.post'"
      )
      .first<{ count: number }>();
    assert.equal(attemptAudit?.count, 1);
  } finally {
    d1.db.close();
  }
});

test("customer key resolves tenant and role only through active D1 membership", async () => {
  const { d1, now } = await fixture();
  try {
    const membership = await createCloudCustomerMembership(d1, {
      tenantId: "tenant-customer",
      principalId: "customer-user-42",
      role: "admin",
      now,
    });
    const issued = await issueCloudCustomerApiKey(d1, {
      tenantId: "tenant-customer",
      membershipId: membership.id,
      now,
    });
    assert.match(issued.token, /^orc_live_[A-Za-z0-9_-]{43}$/);

    const stored = await d1
      .prepare<{ key_hash: string }>("SELECT key_hash FROM cloud_customer_api_keys WHERE id = ?")
      .bind(issued.id)
      .first();
    assert.equal(stored?.key_hash, createHash("sha256").update(issued.token).digest("hex"));
    assert.notEqual(stored?.key_hash, issued.token);

    assert.deepEqual(await authenticateCloudCustomerApiKey(d1, issued.token, now), {
      tenantId: "tenant-customer",
      principalId: "customer-user-42",
      role: "admin",
      membershipId: membership.id,
      apiKeyId: issued.id,
    });
    assert.equal(await authenticateCloudCustomerApiKey(d1, "test-admin-token", now), null);

    await d1
      .prepare("UPDATE cloud_customer_memberships SET role = 'viewer' WHERE id = ?")
      .bind(membership.id)
      .run();
    assert.equal((await authenticateCloudCustomerApiKey(d1, issued.token, now))?.role, "viewer");

    await d1
      .prepare("UPDATE cloud_customer_memberships SET is_active = 0 WHERE id = ?")
      .bind(membership.id)
      .run();
    assert.equal(await authenticateCloudCustomerApiKey(d1, issued.token, now), null);
  } finally {
    d1.db.close();
  }
});

test("suspended tenants, revoked keys, and expired keys fail closed", async () => {
  const { d1, now } = await fixture();
  try {
    const membership = await createCloudCustomerMembership(d1, {
      tenantId: "tenant-customer",
      principalId: "customer-user-7",
      role: "owner",
      now,
    });
    const expiring = await issueCloudCustomerApiKey(d1, {
      tenantId: "tenant-customer",
      membershipId: membership.id,
      expiresAt: "2026-10-08T12:01:00.000Z",
      now,
    });
    assert.equal(
      await authenticateCloudCustomerApiKey(d1, expiring.token, "2026-10-08T12:01:00.000Z"),
      null
    );

    assert.equal(
      await revokeCloudCustomerApiKey(d1, {
        tenantId: "tenant-customer",
        apiKeyId: expiring.id,
        now,
      }),
      true
    );
    assert.equal(
      await revokeCloudCustomerApiKey(d1, {
        tenantId: "tenant-customer",
        apiKeyId: expiring.id,
        now,
      }),
      false
    );
    assert.equal(await authenticateCloudCustomerApiKey(d1, expiring.token, now), null);

    const activeKey = await issueCloudCustomerApiKey(d1, {
      tenantId: "tenant-customer",
      membershipId: membership.id,
      now,
    });
    await d1.prepare("UPDATE tenants SET is_active = 0 WHERE id = ?").bind("tenant-customer").run();
    assert.equal(await authenticateCloudCustomerApiKey(d1, activeKey.token, now), null);
  } finally {
    d1.db.close();
  }
});

test("membership and key creation reject non-customer, suspended, and cross-tenant targets", async () => {
  const { d1, now } = await fixture();
  try {
    const membership = await createCloudCustomerMembership(d1, {
      tenantId: "tenant-customer",
      principalId: "customer-user-9",
      role: "member",
      now,
    });
    await assert.rejects(
      issueCloudCustomerApiKey(d1, {
        tenantId: "different-tenant",
        membershipId: membership.id,
        now,
      }),
      /membership is unavailable/
    );
    await assert.rejects(
      createCloudCustomerMembership(d1, {
        tenantId: "tenant_shiryu_admin",
        principalId: "operator",
        role: "owner",
        now,
      }),
      /tenant is unavailable/
    );
    await assert.rejects(
      createCloudCustomerMembership(d1, {
        tenantId: "tenant-customer",
        principalId: "bad-role",
        role: "platform_admin" as "owner",
        now,
      }),
      /Invalid customer role/
    );
  } finally {
    d1.db.close();
  }
});

test("platform admin API issues a one-time key and revokes it by tenant and key ID", async () => {
  const { d1, now } = await fixture();
  const adminToken = "platform-admin-secret";
  const call = (path: string, method: string, body?: unknown) =>
    handleCloudApiRequest(
      new Request(`https://cloud.example.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      {
        db: d1,
        adminToken,
        now: () => new Date(now),
        adminRateLimit: { limit: 100, windowMs: 60_000 },
      }
    );
  try {
    const membershipResponse = await call(
      "/__cloud/v1/tenants/tenant-customer/memberships",
      "POST",
      { principalId: "customer-user-api", role: "owner" }
    );
    assert.equal(membershipResponse.status, 201);
    const membership = (await membershipResponse.json()) as { id: string };

    const issueResponse = await call(
      `/__cloud/v1/tenants/tenant-customer/memberships/${membership.id}/api-keys`,
      "POST",
      {}
    );
    assert.equal(issueResponse.status, 201);
    const issued = (await issueResponse.json()) as { id: string; token: string };
    assert.match(issued.token, /^orc_live_/);
    assert.deepEqual(await authenticateCloudCustomerApiKey(d1, issued.token, now), {
      tenantId: "tenant-customer",
      principalId: "customer-user-api",
      role: "owner",
      membershipId: membership.id,
      apiKeyId: issued.id,
    });
    assert.equal(await authenticateCloudCustomerApiKey(d1, adminToken, now), null);

    const overrideAttempt = await call("/__cloud/v1/tenants/tenant-customer/memberships", "POST", {
      principalId: "attacker",
      role: "owner",
      tenantId: "tenant_shiryu_admin",
    });
    assert.equal(overrideAttempt.status, 400);

    const revokeResponse = await call(
      `/__cloud/v1/tenants/tenant-customer/api-keys/${issued.id}`,
      "DELETE"
    );
    assert.equal(revokeResponse.status, 200);
    assert.equal(await authenticateCloudCustomerApiKey(d1, issued.token, now), null);
  } finally {
    d1.db.close();
  }
});
