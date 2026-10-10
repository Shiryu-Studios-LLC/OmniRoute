import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { handleCloudApiRequest } from "../../src/cloud/httpApi";
import { provisionCloudCustomer } from "../../src/cloud/provisioning";
import {
  authenticateCloudCustomerApiKey,
  authenticateCloudCustomerSession,
  createCloudCustomerMembership,
  getCloudCustomerMembership,
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

async function fixture() {
  const d1 = new MockD1();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0004_cloud_gateway_devices.sql",
    "0005_cloud_customer_identity.sql",
    "0006_gateway_invocation_idempotency.sql",
    "0007_gateway_device_service_health.sql",
    "0008_cloud_tenant_settings.sql",
    "0010_cloud_inference_policy.sql",
    "0015_cloud_tenant_oidc.sql",
    "0016_cloud_tenant_oidc_sessions.sql",
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
      settings: {
        tenantId: string;
        localAiEnabled: boolean;
        mcpEnabled: boolean;
        createdAt: string;
        updatedAt: string;
      };
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
    assert.deepEqual(provisioned.settings, {
      tenantId: "tenant-new-customer",
      localAiEnabled: false,
      mcpEnabled: false,
      createdAt: now,
      updatedAt: now,
    });
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

test("production routine tenant operations bind to the customer API key tenant and role", async () => {
  const { d1, now } = await fixture();
  try {
    const owner = await createCloudCustomerMembership(d1, {
      tenantId: "tenant-customer",
      principalId: "owner-subject",
      role: "owner",
      now,
    });
    const ownerKey = await issueCloudCustomerApiKey(d1, {
      tenantId: owner.tenantId,
      membershipId: owner.id,
      now,
    });
    const viewer = await createCloudCustomerMembership(d1, {
      tenantId: "tenant-customer",
      principalId: "viewer-subject",
      role: "viewer",
      now,
    });
    const viewerKey = await issueCloudCustomerApiKey(d1, {
      tenantId: viewer.tenantId,
      membershipId: viewer.id,
      now,
    });
    const adminToken = "valid-cloud-admin-token-0123456789";
    const inferenceAdminToken = "valid-cloud-inference-admin-token-0123456789";
    const lifecycleAdminToken = "valid-cloud-lifecycle-admin-token-0123456789";
    const call = (path: string, token: string, method = "GET", body?: unknown) =>
      handleCloudApiRequest(
        new Request(`https://omniroute.test/__cloud/v1/tenants/${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        {
          db: d1,
          adminToken,
          inferenceAdminToken,
          lifecycleAdminToken,
          environment: "production",
          now: () => new Date(now),
        }
      );

    assert.equal(
      (await call("tenant-customer/provider-connections", ownerKey.token)).status,
      200,
      "a customer owner may read their own provider connections"
    );
    assert.equal(
      (await call("tenant-customer/provider-connections", adminToken)).status,
      401,
      "the global operator token cannot access routine tenant data"
    );
    assert.equal(
      (await call("tenant-other/provider-connections", ownerKey.token)).status,
      401,
      "a customer key cannot choose another tenant from the URL"
    );
    assert.equal(
      (
        await call("tenant-customer/provider-connections", viewerKey.token, "POST", {
          id: "viewer-connection",
          provider: "openai",
        })
      ).status,
      403,
      "viewer membership cannot mutate tenant provider configuration"
    );
    assert.equal(
      (await call("tenant-customer/inference-entitlements", ownerKey.token)).status,
      401,
      "customer keys cannot access platform-managed inference entitlements"
    );
    assert.equal(
      (await call("tenant-customer/inference-entitlements", adminToken)).status,
      401,
      "the global token cannot administer inference entitlements"
    );
    assert.equal(
      (await call("tenant-customer/inference-entitlements", inferenceAdminToken)).status,
      200,
      "the inference-scoped token administers inference entitlements"
    );
    assert.equal(
      (await call("tenant-customer/status", adminToken)).status,
      401,
      "the global token cannot perform lifecycle operations"
    );
    assert.equal(
      (await call("tenant-customer/status", lifecycleAdminToken)).status,
      200,
      "the lifecycle-scoped token performs platform lifecycle operations"
    );
  } finally {
    d1.db.close();
  }
});

test("platform tenant creation rejects requests without a verified owner principal", async () => {
  const { d1, now } = await fixture();
  try {
    const response = await handleCloudApiRequest(
      new Request("https://omniroute.test/__cloud/v1/tenants", {
        method: "POST",
        headers: {
          Authorization: "Bearer platform-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "tenant-without-owner",
          name: "Unowned Customer",
          slug: "unowned-customer",
        }),
      }),
      { db: d1, adminToken: "platform-secret", now: () => new Date(now) }
    );

    assert.equal(response.status, 400);
    assert.deepEqual(
      await d1.prepare("SELECT id FROM tenants WHERE id = 'tenant-without-owner'").first(),
      null
    );
    assert.equal(
      (
        await d1
          .prepare("SELECT id FROM cloud_compliance_audit WHERE action = 'customer.provision'")
          .all()
      ).results.length,
      0
    );
  } finally {
    d1.db.close();
  }
});

test("platform admin can provision an explicit OIDC-pending tenant without creating a key or owner", async () => {
  const { d1, now } = await fixture();
  try {
    const response = await handleCloudApiRequest(
      new Request("https://omniroute.test/__cloud/v1/tenants", {
        method: "POST",
        headers: {
          Authorization: "Bearer platform-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "tenant-oidc-pending",
          name: "OIDC Pending Customer",
          slug: "oidc-pending-customer",
          bootstrapMode: "oidc_pending",
        }),
      }),
      { db: d1, adminToken: "platform-secret", now: () => new Date(now) }
    );

    assert.equal(response.status, 201);
    const provisioned = (await response.json()) as {
      tenant: { id: string; kind: string };
      bootstrapMode: string;
      ownerMembership: unknown;
      ownerApiKey: unknown;
    };
    assert.equal(provisioned.tenant.id, "tenant-oidc-pending");
    assert.equal(provisioned.tenant.kind, "customer");
    assert.equal(provisioned.bootstrapMode, "oidc_pending");
    assert.equal(provisioned.ownerMembership, null);
    assert.equal(provisioned.ownerApiKey, null);
    assert.equal(
      await d1
        .prepare("SELECT id FROM cloud_customer_memberships WHERE tenant_id = ?")
        .bind("tenant-oidc-pending")
        .first(),
      null
    );
    assert.equal(
      await d1
        .prepare("SELECT id FROM cloud_customer_api_keys WHERE tenant_id = ?")
        .bind("tenant-oidc-pending")
        .first(),
      null
    );
    const audit = await d1
      .prepare<{ metadata_json: string }>(
        "SELECT metadata_json FROM cloud_compliance_audit WHERE action = 'customer.provision' AND target = ?"
      )
      .bind("tenant-oidc-pending")
      .first();
    assert.deepEqual(JSON.parse(audit?.metadata_json ?? "{}"), {
      slug: "oidc-pending-customer",
      bootstrapMode: "oidc_pending",
    });
  } finally {
    d1.db.close();
  }
});

test("provisioning rejects unknown or mixed bootstrap modes before creating a tenant", async () => {
  const { d1, now } = await fixture();
  try {
    await assert.rejects(
      provisionCloudCustomer(d1, {
        id: "tenant-invalid-bootstrap",
        name: "Invalid Bootstrap",
        slug: "invalid-bootstrap",
        bootstrapMode: "unexpected",
        now,
      } as never),
      { name: "TypeError", message: "Unsupported customer bootstrap mode" }
    );

    await assert.rejects(
      provisionCloudCustomer(d1, {
        id: "tenant-mixed-bootstrap",
        name: "Mixed Bootstrap",
        slug: "mixed-bootstrap",
        bootstrapMode: "oidc_pending",
        ownerPrincipalId: "trusted-owner",
        now,
      } as never),
      { name: "TypeError", message: "OIDC-pending provisioning cannot include an owner principal" }
    );

    const tenants = await d1
      .prepare<{ id: string }>(
        "SELECT id FROM tenants WHERE id IN ('tenant-invalid-bootstrap', 'tenant-mixed-bootstrap')"
      )
      .all();
    assert.deepEqual(tenants.results, []);
  } finally {
    d1.db.close();
  }
});

test("OIDC-pending provisioning cannot also name a trusted owner", async () => {
  const { d1, now } = await fixture();
  try {
    const response = await handleCloudApiRequest(
      new Request("https://omniroute.test/__cloud/v1/tenants", {
        method: "POST",
        headers: {
          Authorization: "Bearer platform-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "tenant-invalid-bootstrap",
          name: "Invalid Bootstrap",
          slug: "invalid-bootstrap",
          ownerPrincipalId: "trusted-owner",
          bootstrapMode: "oidc_pending",
        }),
      }),
      { db: d1, adminToken: "platform-secret", now: () => new Date(now) }
    );
    assert.equal(response.status, 400);
    assert.equal(
      await d1
        .prepare("SELECT id FROM tenants WHERE id = ?")
        .bind("tenant-invalid-bootstrap")
        .first(),
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

test("D1 browser sessions resolve only current tenant membership and role", async () => {
  const { d1, now } = await fixture();
  try {
    const membership = await createCloudCustomerMembership(d1, {
      tenantId: "tenant-customer",
      principalId: "browser-owner",
      role: "owner",
      now,
    });
    await d1
      .prepare(
        `INSERT INTO cloud_tenant_oidc_configs
           (tenant_id, issuer, client_id, client_secret_encrypted, is_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
      .bind(
        "tenant-customer",
        "https://identity.example.test",
        "client-a",
        "enc:v2:placeholder",
        now,
        now
      )
      .run();
    await d1
      .prepare(
        `INSERT INTO cloud_tenant_oidc_identities
           (id, tenant_id, issuer, subject, membership_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "identity-a",
        "tenant-customer",
        "https://identity.example.test",
        "subject-a",
        membership.id,
        now
      )
      .run();

    const token = "session_token_" + "a".repeat(40);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await d1
      .prepare(
        `INSERT INTO cloud_tenant_oidc_sessions
           (token_hash, tenant_id, membership_id, identity_id, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        tokenHash,
        "tenant-customer",
        membership.id,
        "identity-a",
        Date.parse(now),
        Date.parse(now) + 60_000
      )
      .run();

    assert.deepEqual(await authenticateCloudCustomerSession(d1, token, Date.parse(now)), {
      tenantId: "tenant-customer",
      tenantName: "Customer",
      tenantSlug: "customer",
      principalId: "browser-owner",
      role: "owner",
      membershipId: membership.id,
      identityId: "identity-a",
      issuer: "https://identity.example.test",
      expiresAtMs: Date.parse(now) + 60_000,
    });
    assert.equal(await authenticateCloudCustomerSession(d1, "x".repeat(43), Date.parse(now)), null);
    assert.equal(await authenticateCloudCustomerSession(d1, token, Date.parse(now) + 60_000), null);

    await d1
      .prepare(
        "UPDATE cloud_customer_memberships SET role = 'viewer' WHERE tenant_id = ? AND id = ?"
      )
      .bind("tenant-customer", membership.id)
      .run();
    assert.equal(
      (await authenticateCloudCustomerSession(d1, token, Date.parse(now)))?.role,
      "viewer"
    );

    await d1
      .prepare("UPDATE cloud_customer_memberships SET is_active = 0 WHERE tenant_id = ? AND id = ?")
      .bind("tenant-customer", membership.id)
      .run();
    assert.equal(await authenticateCloudCustomerSession(d1, token, Date.parse(now)), null);
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

test("lifecycle identity attributes trusted-owner provisioning audits correctly", async () => {
  const { d1, now } = await fixture();
  const adminToken = "platform-admin-secret";
  const lifecycleAdminToken = "platform-lifecycle-secret";
  try {
    const response = await handleCloudApiRequest(
      new Request("https://omniroute.test/__cloud/v1/tenants", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lifecycleAdminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "tenant-maintenance-audit",
          name: "Maintenance Audit",
          slug: "maintenance-audit",
          ownerPrincipalId: "verified-maintenance-owner",
        }),
      }),
      {
        db: d1,
        adminToken,
        lifecycleAdminToken,
        now: () => new Date(now),
      }
    );
    assert.equal(response.status, 201);
    const auditRows = await d1
      .prepare<{ action: string; actor: string; status: string }>(
        `SELECT action, actor, status FROM cloud_compliance_audit
          WHERE action IN ('cloud.api.post', 'customer.provision')
          ORDER BY rowid`
      )
      .all();
    assert.deepEqual(
      auditRows.results.map(({ action, actor, status }) => ({ action, actor, status })),
      [
        { action: "cloud.api.post", actor: "cloud-lifecycle-admin", status: "attempted" },
        { action: "customer.provision", actor: "cloud-lifecycle-admin", status: "success" },
      ]
    );
  } finally {
    d1.db.close();
  }
});

test("maintenance credentials cannot create OIDC-pending tenants", async () => {
  const { d1, now } = await fixture();
  const adminToken = "platform-admin-secret";
  const maintenanceToken = "platform-maintenance-secret";
  try {
    const response = await handleCloudApiRequest(
      new Request("https://omniroute.test/__cloud/v1/tenants", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${maintenanceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "tenant-maintenance-oidc-pending",
          name: "Maintenance OIDC Pending",
          slug: "maintenance-oidc-pending",
          bootstrapMode: "oidc_pending",
        }),
      }),
      { db: d1, adminToken, maintenanceToken, now: () => new Date(now) }
    );
    assert.equal(response.status, 401);
    assert.equal(
      await d1
        .prepare("SELECT id FROM tenants WHERE id = 'tenant-maintenance-oidc-pending'")
        .first(),
      null
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

    const secondOwnerResponse = await call(
      "/__cloud/v1/tenants/tenant-customer/memberships",
      "POST",
      { principalId: "customer-user-second-owner", role: "owner" }
    );
    assert.equal(secondOwnerResponse.status, 201);
    const secondOwner = (await secondOwnerResponse.json()) as { id: string };

    const secondOwnerKeyResponse = await call(
      `/__cloud/v1/tenants/tenant-customer/memberships/${secondOwner.id}/api-keys`,
      "POST",
      {}
    );
    assert.equal(secondOwnerKeyResponse.status, 201);
    const secondOwnerKey = (await secondOwnerKeyResponse.json()) as { token: string };

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

    const deactivateResponse = await call(
      `/__cloud/v1/tenants/tenant-customer/memberships/${membership.id}`,
      "PATCH",
      { isActive: false }
    );
    assert.equal(deactivateResponse.status, 200);
    assert.equal(await authenticateCloudCustomerApiKey(d1, issued.token, now), null);
    const secondOwnerDemotion = await call(
      `/__cloud/v1/tenants/tenant-customer/memberships/${secondOwner.id}`,
      "PATCH",
      { role: "member" }
    );
    assert.equal(secondOwnerDemotion.status, 409);
    assert.equal(
      (await authenticateCloudCustomerApiKey(d1, secondOwnerKey.token, now))?.role,
      "owner",
      "a rejected last-owner change must not revoke the active owner's API key"
    );

    const reactivateResponse = await call(
      `/__cloud/v1/tenants/tenant-customer/memberships/${membership.id}`,
      "PATCH",
      { isActive: true }
    );
    assert.equal(reactivateResponse.status, 200);
    assert.equal(await authenticateCloudCustomerApiKey(d1, issued.token, now), null);
    const demoteResponse = await call(
      `/__cloud/v1/tenants/tenant-customer/memberships/${secondOwner.id}`,
      "PATCH",
      { role: "member" }
    );
    assert.equal(demoteResponse.status, 200);

    const overrideAttempt = await call("/__cloud/v1/tenants/tenant-customer/memberships", "POST", {
      principalId: "attacker",
      role: "owner",
      tenantId: "tenant_shiryu_admin",
    });
    assert.equal(overrideAttempt.status, 400);

    const secondIssueResponse = await call(
      `/__cloud/v1/tenants/tenant-customer/memberships/${membership.id}/api-keys`,
      "POST",
      {}
    );
    assert.equal(secondIssueResponse.status, 201);
    const secondIssued = (await secondIssueResponse.json()) as { id: string; token: string };
    const revokeResponse = await call(
      `/__cloud/v1/tenants/tenant-customer/api-keys/${secondIssued.id}`,
      "DELETE"
    );
    assert.equal(revokeResponse.status, 200);
    assert.equal(await authenticateCloudCustomerApiKey(d1, secondIssued.token, now), null);
  } finally {
    d1.db.close();
  }
});

test("membership deactivation and key revocation roll back together on D1 failure", async () => {
  const { d1, now } = await fixture();
  try {
    const membership = await createCloudCustomerMembership(d1, {
      tenantId: "tenant-customer",
      principalId: "customer-user-atomic",
      role: "owner",
      now,
    });
    await createCloudCustomerMembership(d1, {
      tenantId: "tenant-customer",
      principalId: "customer-user-atomic-backup-owner",
      role: "owner",
      now,
    });
    const issued = await issueCloudCustomerApiKey(d1, {
      tenantId: "tenant-customer",
      membershipId: membership.id,
      now,
    });
    await d1.exec(`
      CREATE TRIGGER fail_key_revocation BEFORE UPDATE OF revoked_at ON cloud_customer_api_keys
      BEGIN SELECT RAISE(ABORT, 'injected key revocation failure'); END;
    `);
    const response = await handleCloudApiRequest(
      new Request(
        `https://cloud.example.test/__cloud/v1/tenants/tenant-customer/memberships/${membership.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: "Bearer platform-secret",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive: false }),
        }
      ),
      { db: d1, adminToken: "platform-secret", now: () => new Date(now) }
    );
    assert.equal(response.status, 500);
    assert.equal(
      (await getCloudCustomerMembership(d1, "tenant-customer", membership.id))?.isActive,
      true
    );
    assert.equal(
      (await authenticateCloudCustomerApiKey(d1, issued.token, now))?.principalId,
      "customer-user-atomic"
    );
  } finally {
    d1.db.close();
  }
});
