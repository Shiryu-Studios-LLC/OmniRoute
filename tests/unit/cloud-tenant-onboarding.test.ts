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
import {
  CLOUD_CUSTOMER_ONBOARDING_PATH,
  handleCloudCustomerOnboardingRequest,
} from "../../src/cloud/tenantOnboardingHttpApi";
import { createCloudRuntime } from "../../src/cloud/runtime";

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
    "0009_cloud_rate_limit_retention.sql",
    "0010_cloud_inference_policy.sql",
    "0011_cloud_inference_idempotency.sql",
    "0012_cloud_inference_idempotency_capacity.sql",
    "0013_cloud_inference_idempotency_tombstone_retention.sql",
    "0014_cloud_inference_reservation_retention.sql",
    "0015_cloud_tenant_oidc.sql",
    "0016_cloud_tenant_oidc_sessions.sql",
    "0017_cloud_gateway_pairings.sql",
    "0018_cloud_tenant_membership_invitations.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  return db;
}

const TEST_NOW = "2026-10-08T12:00:00.000Z";
const TEST_NOW_MS = new Date("2026-10-08T12:01:00.000Z").getTime();

async function addCustomer(db: SqliteCloudDb, id: string) {
  return provisionCloudCustomer(db, {
    id,
    name: id,
    slug: id,
    ownerPrincipalId: `${id}-owner`,
    now: TEST_NOW,
  });
}

function getRequest(
  token: string,
  url = `https://omniroute.test${CLOUD_CUSTOMER_ONBOARDING_PATH}`
) {
  return new Request(url, { headers: { Authorization: `Bearer ${token}` } });
}

test("customer onboarding reports tenant-scoped boolean flags without exposing configuration", async () => {
  const db = await migratedDb();
  try {
    const customerA = await addCustomer(db, "onboarding-a");
    const customerB = await addCustomer(db, "onboarding-b");
    const member = await createCloudCustomerMembership(db, {
      tenantId: customerA.tenant.id,
      principalId: "onboarding-a-member",
      role: "member",
      now: TEST_NOW,
    });
    const memberKey = await issueCloudCustomerApiKey(db, {
      tenantId: customerA.tenant.id,
      membershipId: member.id,
      now: TEST_NOW,
    });
    const admin = await createCloudCustomerMembership(db, {
      tenantId: customerA.tenant.id,
      principalId: "onboarding-a-admin",
      role: "admin",
      now: TEST_NOW,
    });
    const adminKey = await issueCloudCustomerApiKey(db, {
      tenantId: customerA.tenant.id,
      membershipId: admin.id,
      now: TEST_NOW,
    });

    await db
      .prepare("UPDATE cloud_tenant_settings SET local_ai_enabled = 1 WHERE tenant_id = ?")
      .bind(customerA.tenant.id)
      .run();
    await db
      .prepare(
        `INSERT INTO cloud_gateway_devices (
           id, tenant_id, credential_hash, capabilities_json, status, created_at, revoked_at
         ) VALUES (?, ?, ?, '[]', 'offline', ?, ?)`
      )
      .bind("onboarding-device-a-revoked", customerA.tenant.id, "a".repeat(64), TEST_NOW, TEST_NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_configs (
           tenant_id, issuer, client_id, client_secret_encrypted, is_enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .bind(
        customerA.tenant.id,
        "https://identity.customer-a.example/issuer-secret-url",
        "customer-a-client-id",
        "encrypted-customer-a-client-secret",
        TEST_NOW,
        TEST_NOW
      )
      .run();
    await db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_configs (
           tenant_id, issuer, client_id, client_secret_encrypted, is_enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        customerB.tenant.id,
        "https://identity.customer-b.example/issuer-secret-url",
        "customer-b-client-id",
        "encrypted-customer-b-client-secret",
        1,
        TEST_NOW,
        TEST_NOW
      )
      .run();
    await db
      .prepare(
        `INSERT INTO provider_connections (id, tenant_id, provider, api_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "onboarding-provider-b",
        customerB.tenant.id,
        "provider-b",
        "provider-secret",
        TEST_NOW,
        TEST_NOW
      )
      .run();
    await db
      .prepare(
        `INSERT INTO cloud_inference_entitlements (
           tenant_id, provider, model, enabled, max_input_tokens, max_output_tokens, created_at, updated_at
         ) VALUES (?, ?, ?, 1, 1000, 500, ?, ?)`
      )
      .bind(customerB.tenant.id, "provider-b", "model-b", TEST_NOW, TEST_NOW)
      .run();
    await db
      .prepare(
        "UPDATE cloud_tenant_settings SET local_ai_enabled = 1, mcp_enabled = 1 WHERE tenant_id = ?"
      )
      .bind(customerB.tenant.id)
      .run();
    await db
      .prepare(
        `INSERT INTO cloud_gateway_devices (
           id, tenant_id, credential_hash, capabilities_json, status, created_at
         ) VALUES (?, ?, ?, '[]', 'offline', ?)`
      )
      .bind("onboarding-device-b", customerB.tenant.id, "b".repeat(64), TEST_NOW)
      .run();

    const options = { db, now: () => new Date(TEST_NOW_MS) };
    const runtime = createCloudRuntime({ env: { DB: db }, ...options });
    const responseA = await runtime.fetch(getRequest(customerA.ownerApiKey.token));
    assert.equal(responseA?.status, 200);
    assert.equal(responseA?.headers.get("Cache-Control"), "no-store");
    const statusA = (await responseA?.json()) as Record<string, unknown>;
    assert.deepEqual(statusA, {
      activeOwner: true,
      oidcConfigured: true,
      oidcEnabled: false,
      activeProviderConnection: false,
      enabledInferenceEntitlement: false,
      registeredDevice: false,
      localAiEnabled: true,
      mcpEnabled: false,
    });

    await db
      .prepare("UPDATE cloud_customer_memberships SET is_active = 0 WHERE id = ?")
      .bind(customerA.ownerMembership.id)
      .run();
    const noActiveOwnerResponse = await handleCloudCustomerOnboardingRequest(
      getRequest(adminKey.token),
      options
    );
    assert.equal(noActiveOwnerResponse?.status, 200);
    assert.equal((await noActiveOwnerResponse?.json()).activeOwner, false);

    const responseB = await handleCloudCustomerOnboardingRequest(
      getRequest(customerB.ownerApiKey.token),
      options
    );
    assert.equal(responseB?.status, 200);
    const statusB = (await responseB?.json()) as Record<string, unknown>;
    assert.deepEqual(statusB, {
      activeOwner: true,
      oidcConfigured: true,
      oidcEnabled: true,
      activeProviderConnection: true,
      enabledInferenceEntitlement: true,
      registeredDevice: true,
      localAiEnabled: true,
      mcpEnabled: true,
    });

    for (const status of [statusA, statusB]) {
      assert.ok(Object.values(status).every((value) => typeof value === "boolean"));
      assert.deepEqual(Object.keys(status).sort(), [
        "activeOwner",
        "activeProviderConnection",
        "enabledInferenceEntitlement",
        "localAiEnabled",
        "mcpEnabled",
        "oidcConfigured",
        "oidcEnabled",
        "registeredDevice",
      ]);
    }
    const responseText = JSON.stringify(statusB);
    for (const secret of [
      "identity.customer-a.example",
      "customer-a-client-id",
      "encrypted-customer-a-client-secret",
      "identity.customer-b.example",
      "customer-b-client-id",
      "encrypted-customer-b-client-secret",
      "provider-secret",
      "onboarding-device-b",
      "b".repeat(64),
    ]) {
      assert.equal(responseText.includes(secret), false);
    }

    const tenantSelector = await handleCloudCustomerOnboardingRequest(
      getRequest(
        customerA.ownerApiKey.token,
        `https://omniroute.test${CLOUD_CUSTOMER_ONBOARDING_PATH}?tenantId=onboarding-b`
      ),
      options
    );
    assert.equal(tenantSelector?.status, 400);
    assert.match(await tenantSelector!.text(), /Query parameters are not supported/);

    const deniedMember = await handleCloudCustomerOnboardingRequest(
      getRequest(memberKey.token),
      options
    );
    assert.equal(deniedMember?.status, 403);
  } finally {
    db.db.close();
  }
});

test("customer onboarding applies edge-IP pre-auth and authenticated tenant limits", async () => {
  const db = await migratedDb();
  try {
    const customerA = await addCustomer(db, "onboarding-limit-a");
    const customerB = await addCustomer(db, "onboarding-limit-b");
    const now = () => new Date(TEST_NOW_MS);
    const preAuthOptions = {
      db,
      now,
      failedKeyRateLimit: { limit: 1, windowMs: 60_000 },
    };
    const invalidRequest = () => {
      const request = getRequest("orc_live_invalid");
      Object.defineProperty(request, "cf", { value: {} });
      request.headers.set("cf-connecting-ip", "203.0.113.27");
      return request;
    };

    assert.equal(
      (await handleCloudCustomerOnboardingRequest(invalidRequest(), preAuthOptions))?.status,
      401
    );
    assert.equal(
      (await handleCloudCustomerOnboardingRequest(invalidRequest(), preAuthOptions))?.status,
      429
    );

    const tenantOptions = { db, now, tenantRateLimit: { limit: 1, windowMs: 60_000 } };
    assert.equal(
      (
        await handleCloudCustomerOnboardingRequest(
          getRequest(customerA.ownerApiKey.token),
          tenantOptions
        )
      )?.status,
      200
    );
    assert.equal(
      (
        await handleCloudCustomerOnboardingRequest(
          getRequest(customerA.ownerApiKey.token),
          tenantOptions
        )
      )?.status,
      429
    );
    assert.equal(
      (
        await handleCloudCustomerOnboardingRequest(
          getRequest(customerB.ownerApiKey.token),
          tenantOptions
        )
      )?.status,
      200,
      "tenant rate-limit buckets must remain isolated"
    );
  } finally {
    db.db.close();
  }
});

test("customer onboarding fails closed when settings storage is unavailable", async () => {
  const db = await migratedDb();
  try {
    const customer = await addCustomer(db, "onboarding-fail-closed");
    await db.prepare("DROP TABLE cloud_tenant_settings").run();
    const response = await handleCloudCustomerOnboardingRequest(
      getRequest(customer.ownerApiKey.token),
      { db, now: () => new Date(TEST_NOW_MS) }
    );
    assert.equal(response?.status, 503);
    assert.equal(response?.headers.get("Cache-Control"), "no-store");
  } finally {
    db.db.close();
  }
});
