import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { provisionCloudCustomer } from "../../src/cloud/provisioning";
import { revokeCloudCustomerApiKey } from "../../src/cloud/customerIdentity";
import { registerCloudGatewayDevice } from "../../src/cloud/gatewayDevices";
import { createCloudRuntime } from "../../src/cloud/runtime";
import { registerAdminVerifiedCustomerHost } from "../../src/cloud/tenantHosts";

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
    return (this.db.prepare(this.sql).get(...(this.values as never[])) as U | undefined) ?? null;
  }

  async all<U = T>() {
    return {
      results: this.db.prepare(this.sql).all(...(this.values as never[])) as U[],
      success: true,
    };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...(this.values as never[]));
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

const NOW = "2026-10-09T12:00:00.000Z";
const ADMIN_TOKEN = "frontdesk-config-admin-token-0123456789";
const SERVICE_TOKEN = "frontdesk-config-service-token-0123456789";
const MAINTENANCE_TOKEN = "frontdesk-config-maintenance-token-0123456789";
const IDEMPOTENCY_KEY = "frontdesk-config-idempotency-key-0123456789";
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)));
const DASHBOARD_SECRET = "dashboard_token_secret_for_tenant_b_0123456789";

async function fixture() {
  const db = new SqliteCloudDb();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0004_cloud_gateway_devices.sql",
    "0005_cloud_customer_identity.sql",
    "0007_gateway_device_service_health.sql",
    "0008_cloud_tenant_settings.sql",
    "0025_verified_customer_hosts.sql",
    "0028_cloud_frontdesk_configs.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }

  const [tenantA, tenantB] = await Promise.all(
    ["frontdesk-tenant-a", "frontdesk-tenant-b"].map((id) =>
      provisionCloudCustomer(db, {
        id,
        name: id,
        slug: id,
        ownerPrincipalId: `${id}-owner`,
        now: NOW,
      })
    )
  );
  const hosts = [
    { tenantId: tenantA.tenant.id, hostname: "front-a.example.test" },
    { tenantId: tenantB.tenant.id, hostname: "front-b.example.test" },
  ];
  for (const host of hosts) {
    await registerAdminVerifiedCustomerHost(db, {
      ...host,
      verifiedAt: NOW,
      verifiedBy: "test-platform-admin",
    });
  }

  const [, deviceB] = await Promise.all(
    [tenantA, tenantB].map((tenant, index) =>
      registerCloudGatewayDevice(db, {
        tenantId: tenant.tenant.id,
        id: `frontdesk-device-${index === 0 ? "a" : "b"}`,
        credentialHash: String(index + 1).repeat(64),
        capabilities: ["ollama:chat:llama-3.2"],
        now: NOW,
      })
    )
  );
  const runtime = createCloudRuntime({
    env: {
      DB: db,
      OMNIROUTE_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN,
      OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: MAINTENANCE_TOKEN,
      OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
      OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: IDEMPOTENCY_KEY,
      OMNIROUTE_FRONT_DESK_CONFIG_TOKEN: SERVICE_TOKEN,
    },
    now: () => new Date(NOW),
  });

  const call = (path: string, options: { method?: string; token?: string; body?: unknown } = {}) =>
    runtime.fetch(
      new Request(`https://cloud.test${path}`, {
        method: options.method ?? "GET",
        headers: {
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
    );

  const configBody = (hostname: string, customerApiKey: string, deviceId: string) => ({
    hostname,
    customerApiKey,
    dashboardToken: DASHBOARD_SECRET,
    gateway: {
      baseUrl: "http://127.0.0.1:20128",
      deviceId,
      ollamaModel: "llama-3.2",
      imageGeneration: null,
    },
  });

  return {
    db,
    tenantA,
    tenantB,
    deviceB,
    runtime,
    call,
    configBody,
  };
}

test("Front Desk config writes, service retrieval, and admin listing isolate tenant secrets", async () => {
  const { db, tenantA, tenantB, deviceB, call, configBody } = await fixture();
  try {
    const crossTenantWrite = await call("/__cloud/v1/front-desk/configs", {
      method: "PUT",
      token: ADMIN_TOKEN,
      body: configBody("front-b.example.test", tenantA.ownerApiKey.token, deviceB.id),
    });
    const crossTenantResponse = await crossTenantWrite.text();
    assert.equal(crossTenantWrite.status, 403, crossTenantResponse);
    assert.doesNotMatch(crossTenantResponse, /orc_live_|dashboard_token_secret/);

    const unauthenticatedRead = await call(
      "/__cloud/v1/front-desk/config?hostname=front-b.example.test"
    );
    assert.equal(unauthenticatedRead.status, 401);

    const successfulWrite = await call("/__cloud/v1/front-desk/configs", {
      method: "PUT",
      token: ADMIN_TOKEN,
      body: configBody("front-b.example.test", tenantB.ownerApiKey.token, deviceB.id),
    });
    const successfulWriteText = await successfulWrite.text();
    assert.equal(successfulWrite.status, 200, successfulWriteText);
    assert.doesNotMatch(successfulWriteText, new RegExp(tenantB.ownerApiKey.token));
    assert.doesNotMatch(successfulWriteText, new RegExp(DASHBOARD_SECRET));
    assert.match(successfulWriteText, /"hasCustomerApiKey":true/);
    assert.match(successfulWriteText, /"hasDashboardToken":true/);

    const serviceRead = await call("/__cloud/v1/front-desk/config?hostname=front-b.example.test", {
      token: SERVICE_TOKEN,
    });
    const serviceReadText = await serviceRead.text();
    assert.equal(serviceRead.status, 200, serviceReadText);
    assert.match(serviceReadText, new RegExp(tenantB.ownerApiKey.token));
    assert.match(serviceReadText, new RegExp(DASHBOARD_SECRET));
    assert.doesNotMatch(serviceReadText, new RegExp(tenantA.ownerApiKey.token));

    const adminList = await call("/__cloud/v1/front-desk/configs?tenantId=frontdesk-tenant-b", {
      token: ADMIN_TOKEN,
    });
    const adminListText = await adminList.text();
    assert.equal(adminList.status, 200, adminListText);
    assert.match(adminListText, /"hostname":"front-b.example.test"/);
    assert.match(adminListText, /"hasCustomerApiKey":true/);
    assert.match(adminListText, /"hasDashboardToken":true/);
    assert.doesNotMatch(adminListText, new RegExp(tenantB.ownerApiKey.token));
    assert.doesNotMatch(adminListText, new RegExp(DASHBOARD_SECRET));
    assert.doesNotMatch(adminListText, /customer_api_key_encrypted|dashboard_token_encrypted/);

    const stored = await db
      .prepare<{ customer_api_key_encrypted: string; dashboard_token_encrypted: string }>(
        `SELECT customer_api_key_encrypted, dashboard_token_encrypted
           FROM cloud_frontdesk_configs WHERE hostname = ?`
      )
      .bind("front-b.example.test")
      .first();
    assert.ok(stored);
    assert.notEqual(stored.customer_api_key_encrypted, tenantB.ownerApiKey.token);
    assert.notEqual(stored.dashboard_token_encrypted, DASHBOARD_SECRET);

    assert.equal(
      await revokeCloudCustomerApiKey(db, {
        tenantId: tenantB.tenant.id,
        apiKeyId: tenantB.ownerApiKey.id,
        now: NOW,
      }),
      true
    );
    const revokedKeyRead = await call(
      "/__cloud/v1/front-desk/config?hostname=front-b.example.test",
      { token: SERVICE_TOKEN }
    );
    const revokedKeyBody = await revokedKeyRead.text();
    assert.equal(revokedKeyRead.status, 503);
    assert.doesNotMatch(revokedKeyBody, new RegExp(tenantB.ownerApiKey.token));
    assert.doesNotMatch(revokedKeyBody, new RegExp(DASHBOARD_SECRET));
  } finally {
    db.db.close();
  }
});
