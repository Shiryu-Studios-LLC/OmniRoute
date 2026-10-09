import assert from "node:assert/strict";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "@/cloud/db";
import { decryptCloudCredential, isCloudCredentialEnvelope } from "@/cloud/credentialEncryption";
import { createCloudRuntime } from "@/cloud/runtime";

const adminToken = "test-cloud-admin-secret";
const tenants = [
  {
    id: "tenant_shiryu_admin",
    name: "Shiryu Studios Platform",
    slug: "shiryu-platform-admin",
    kind: "platform_admin",
    is_active: 1,
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T00:00:00.000Z",
  },
  {
    id: "tenant-a",
    name: "Alpha",
    slug: "alpha",
    kind: "customer",
    is_active: 1,
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T00:00:00.000Z",
  },
  {
    id: "tenant-b",
    name: "Beta",
    slug: "beta",
    kind: "customer",
    is_active: 1,
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T00:00:00.000Z",
  },
];
const connections = [
  {
    id: "alpha-openai",
    tenant_id: "tenant-a",
    provider: "openai",
    is_active: 1,
    priority: 0,
    access_token: `enc:v1:${"0".repeat(32)}:abcd:${"1".repeat(32)}`,
    refresh_token: null,
    api_key: null,
    id_token: null,
    provider_specific_data: '{"private":"value"}',
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T00:00:00.000Z",
  },
];
const nodes = [
  {
    id: "alpha-custom",
    tenant_id: "tenant-a",
    type: "openai-compatible",
    name: "Alpha custom provider",
    base_url: "https://provider.example/v1",
    custom_headers_json: '{"Authorization":"Bearer secret"}',
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T00:00:00.000Z",
  },
];

function usageRow(values: unknown[]): Record<string, unknown> {
  const [
    id,
    tenant_id,
    provider,
    model,
    connection_id,
    api_key_id,
    api_key_name,
    tokens_input,
    tokens_output,
    tokens_cache_read,
    tokens_cache_creation,
    tokens_reasoning,
    service_tier,
    status,
    success,
    latency_ms,
    ttft_ms,
    error_code,
    combo_strategy,
    endpoint,
    timestamp,
  ] = values;
  return {
    id,
    tenant_id,
    provider,
    model,
    connection_id,
    api_key_id,
    api_key_name,
    tokens_input,
    tokens_output,
    tokens_cache_read,
    tokens_cache_creation,
    tokens_reasoning,
    service_tier,
    status,
    success,
    latency_ms,
    ttft_ms,
    error_code,
    combo_strategy,
    endpoint,
    timestamp,
  };
}

class Statement<T = unknown> implements CloudDbStatement<T> {
  constructor(
    private readonly database: TestD1,
    private readonly sql: string,
    private readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]) {
    return new Statement<T>(this.database, this.sql, values);
  }

  async first<U = T>(): Promise<U | null> {
    if (this.sql.includes("FROM tenants")) {
      const row = this.database.tenants.find((tenant) => tenant.id === this.values[0]);
      return (row ?? null) as U | null;
    }
    if (this.sql.includes("FROM provider_connections")) {
      const [tenantId, id] = this.values;
      const row = this.database.providerRows.find(
        (connection) => connection.tenant_id === tenantId && connection.id === id
      );
      return (row ?? null) as U | null;
    }
    if (this.sql.includes("FROM provider_nodes")) {
      const [tenantId, id] = this.values;
      const row = this.database.providerNodeRows.find(
        (node) => node.tenant_id === tenantId && node.id === id
      );
      return (row ?? null) as U | null;
    }
    return null;
  }

  async all<U = T>(): Promise<{ results: U[]; success: boolean }> {
    if (this.sql.includes("FROM cloud_maintenance_runs")) {
      return {
        results: this.database.maintenanceRuns.slice(0, Number(this.values[0])) as U[],
        success: true,
      };
    }
    if (this.sql.includes("INSERT INTO cloud_rate_limits")) {
      const [tenantId, bucketHash, nowMs, windowMs, limit] = this.values;
      const key = `${tenantId}:${bucketHash}`;
      const count = (this.database.rateCounts.get(key) ?? 0) + 1;
      this.database.rateCounts.set(key, count);
      return {
        results: [
          {
            request_count: count,
            window_started_at_ms: nowMs,
            window_ms: windowMs,
            limit_count: limit,
          } as U,
        ],
        success: true,
      };
    }
    if (this.sql.includes("FROM provider_connections")) {
      const rows = this.database.providerRows.filter(
        (connection) => connection.tenant_id === this.values[0]
      );
      return { results: rows as U[], success: true };
    }
    if (this.sql.includes("FROM provider_nodes")) {
      const rows = this.database.providerNodeRows.filter(
        (node) => node.tenant_id === this.values[0]
      );
      return { results: rows as U[], success: true };
    }
    if (this.sql.startsWith("SELECT * FROM cloud_usage_history")) {
      let valueIndex = 1;
      const providerIndex = this.sql.includes("provider = ?") ? valueIndex++ : -1;
      const fromIndex = this.sql.includes("timestamp >= ?") ? valueIndex++ : -1;
      const toIndex = this.sql.includes("timestamp <= ?") ? valueIndex++ : -1;
      const beforeIndex = this.sql.includes("(timestamp < ? OR (timestamp = ? AND id < ?))")
        ? valueIndex
        : -1;
      const rows = this.database.usageRows
        .filter((row) => row.tenant_id === this.values[0])
        .filter((row) => providerIndex < 0 || row.provider === this.values[providerIndex])
        .filter((row) => fromIndex < 0 || String(row.timestamp) >= String(this.values[fromIndex]))
        .filter((row) => toIndex < 0 || String(row.timestamp) <= String(this.values[toIndex]))
        .filter(
          (row) =>
            beforeIndex < 0 ||
            String(row.timestamp) < String(this.values[beforeIndex]) ||
            (String(row.timestamp) === String(this.values[beforeIndex + 1]) &&
              String(row.id) < String(this.values[beforeIndex + 2]))
        )
        .sort(
          (left, right) =>
            String(right.timestamp).localeCompare(String(left.timestamp)) ||
            String(right.id).localeCompare(String(left.id))
        )
        .slice(0, Number(this.values[this.values.length - 1]));
      return { results: rows as U[], success: true };
    }
    return { results: [], success: true };
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO tenants")) {
      const [id, name, slug, createdAt, updatedAt] = this.values;
      this.database.tenants.push({
        id: String(id),
        name: String(name),
        slug: String(slug),
        kind: "customer",
        is_active: 1,
        created_at: String(createdAt),
        updated_at: String(updatedAt),
      });
    }
    if (this.sql.startsWith("INSERT INTO provider_connections")) {
      const fields = [
        "id",
        "tenant_id",
        "provider",
        "auth_type",
        "name",
        "email",
        "priority",
        "is_active",
        "access_token",
        "refresh_token",
        "expires_at",
        "token_expires_at",
        "scope",
        "project_id",
        "test_status",
        "error_code",
        "last_error",
        "last_error_at",
        "api_key",
        "id_token",
        "provider_specific_data",
        "expires_in",
        "display_name",
        "global_priority",
        "default_model",
        "token_type",
        "credential_ownership",
        "execution_location",
        "created_at",
        "updated_at",
      ];
      const row = Object.fromEntries(fields.map((field, index) => [field, this.values[index]]));
      this.database.providerRows.push(row);
    }
    if (this.sql.startsWith("UPDATE provider_connections")) {
      const fields = [
        "provider",
        "auth_type",
        "name",
        "email",
        "priority",
        "is_active",
        "access_token",
        "refresh_token",
        "expires_at",
        "token_expires_at",
        "scope",
        "project_id",
        "test_status",
        "error_code",
        "last_error",
        "last_error_at",
        "api_key",
        "id_token",
        "provider_specific_data",
        "expires_in",
        "display_name",
        "global_priority",
        "default_model",
        "token_type",
        "credential_ownership",
        "execution_location",
        "updated_at",
      ];
      const [tenantId, id] = this.values.slice(fields.length);
      const row = this.database.providerRows.find(
        (entry) => entry.tenant_id === tenantId && entry.id === id
      );
      if (row)
        fields.forEach((field, index) => {
          row[field] = this.values[index];
        });
    }
    if (this.sql.startsWith("INSERT INTO provider_nodes")) {
      const fields = [
        "id",
        "tenant_id",
        "type",
        "name",
        "prefix",
        "api_type",
        "base_url",
        "chat_path",
        "models_path",
        "icon_url",
        "custom_headers_json",
        "credential_ownership",
        "execution_location",
        "created_at",
        "updated_at",
      ];
      this.database.providerNodeRows.push(
        Object.fromEntries(fields.map((field, index) => [field, this.values[index]]))
      );
    }
    if (this.sql.includes("INSERT INTO cloud_compliance_audit")) {
      this.database.auditRows.push(this.values);
    }
    if (this.sql.startsWith("INSERT INTO cloud_usage_history")) {
      this.database.usageRows.push(usageRow(this.values));
    }
    return { success: true };
  }
}

class TestD1 implements CloudDb {
  prepareCount = 0;
  readonly tenants = tenants.map((tenant) => ({ ...tenant }));
  readonly providerRows = connections.map((connection) => ({ ...connection }));
  readonly providerNodeRows = nodes.map((node) => ({ ...node }));
  readonly rateCounts = new Map<string, number>();
  readonly auditRows: unknown[][] = [];
  readonly usageRows: Record<string, unknown>[] = [];
  readonly maintenanceRuns = [
    {
      id: 2,
      task_key: "expired-oidc-artifacts",
      started_at_ms: 20_000,
      finished_at_ms: 20_025,
      duration_ms: 25,
      outcome: "succeeded",
    },
    {
      id: 1,
      task_key: "expired-rate-limits",
      started_at_ms: 10_000,
      finished_at_ms: 10_040,
      duration_ms: 40,
      outcome: "failed",
    },
  ];

  prepare<T = unknown>(sql: string) {
    this.prepareCount += 1;
    return new Statement<T>(this, sql);
  }

  async batch() {
    return [];
  }

  async exec() {
    return undefined;
  }
}

function request(path: string, token = adminToken) {
  return new Request(`https://omniroute.test${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

const cloudCredentialKey = Buffer.alloc(32, 7).toString("base64");
const cloudIdempotencyKey = Buffer.alloc(32, 8).toString("base64");
const scopedOperatorTokens = {
  identity: "cloud-identity-admin-token-0123456789",
  inference: "cloud-inference-admin-token-0123456789",
  lifecycle: "cloud-lifecycle-admin-token-0123456789",
  hosts: "cloud-hosts-admin-token-0123456789012345",
  frontDesk: "cloud-frontdesk-admin-token-0123456789",
  maintenance: "cloud-maintenance-token-0123456789012",
};

function runtime(
  db = new TestD1(),
  adminRateLimit?: { limit: number; windowMs: number },
  credentialEncryptionKey?: string,
  maintenanceToken?: string
) {
  return createCloudRuntime({
    env: {
      DB: db,
      OMNIROUTE_CLOUD_ADMIN_TOKEN: adminToken,
      OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: maintenanceToken,
      OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
    },
    adminRateLimit,
  });
}

test("cloud CRUD API requires the configured server-side admin token", async () => {
  const noTokenRuntime = createCloudRuntime({
    env: { DB: new TestD1(), OMNIROUTE_CLOUD_ADMIN_TOKEN: adminToken },
  });
  const response = await noTokenRuntime.fetch(
    request("/__cloud/v1/tenants/tenant-a", "wrong-token")
  );
  assert.equal(response.status, 401);
});

test("production operator tokens are limited to their route families", async () => {
  const db = new TestD1();
  const app = createCloudRuntime({
    env: {
      DB: db,
      OMNIROUTE_ENV: "production",
      OMNIROUTE_CLOUD_ADMIN_TOKEN: "legacy-global-admin-token-0123456789",
      OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN: scopedOperatorTokens.identity,
      OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN: scopedOperatorTokens.inference,
      OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN: scopedOperatorTokens.lifecycle,
      OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN: scopedOperatorTokens.hosts,
      OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN: scopedOperatorTokens.frontDesk,
      OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: scopedOperatorTokens.maintenance,
      OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: cloudCredentialKey,
      OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: cloudIdempotencyKey,
    },
  });
  const authorized = (path: string, token: string, method = "GET", body?: unknown) =>
    app.fetch(
      new Request(`https://omniroute.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );

  assert.equal(
    (await authorized("/__cloud/v1/tenants/tenant-a/oidc", scopedOperatorTokens.identity)).status,
    200
  );
  assert.equal(
    (
      await authorized(
        "/__cloud/v1/tenants/tenant-a/inference-budget",
        scopedOperatorTokens.inference
      )
    ).status,
    200
  );
  assert.equal(
    (await authorized("/__cloud/v1/tenants/tenant-a/status", scopedOperatorTokens.lifecycle))
      .status,
    200
  );
  assert.equal(
    (await authorized("/__cloud/v1/tenant-hosts?tenantId=tenant-a", scopedOperatorTokens.hosts))
      .status,
    200
  );
  assert.equal(
    (
      await authorized(
        "/__cloud/v1/front-desk/configs?tenantId=tenant-a",
        scopedOperatorTokens.frontDesk
      )
    ).status,
    200
  );
  assert.equal(
    (
      await authorized(
        "/__cloud/v1/front-desk/configs?tenantId=tenant-a",
        scopedOperatorTokens.hosts
      )
    ).status,
    401
  );
  assert.equal(
    (await authorized("/__cloud/v1/tenant-hosts?tenantId=tenant-a", scopedOperatorTokens.frontDesk))
      .status,
    401
  );

  assert.equal(
    (
      await authorized(
        "/__cloud/v1/tenants/tenant-a/inference-budget",
        scopedOperatorTokens.identity
      )
    ).status,
    401
  );
  assert.equal(
    (await authorized("/__cloud/v1/tenants/tenant-a/oidc", scopedOperatorTokens.inference)).status,
    401
  );
  assert.equal(
    (await authorized("/__cloud/v1/tenants/tenant-a/oidc", scopedOperatorTokens.lifecycle)).status,
    401
  );
  assert.equal(
    (await authorized("/__cloud/v1/tenants/tenant-a/status", scopedOperatorTokens.identity)).status,
    401
  );
  const tenantProvisioningBody = {
    id: "tenant-new",
    name: "New customer",
    slug: "new-customer",
  };
  assert.equal(
    (
      await authorized(
        "/__cloud/v1/tenants",
        scopedOperatorTokens.maintenance,
        "POST",
        tenantProvisioningBody
      )
    ).status,
    401,
    "maintenance credentials must not provision customers"
  );
  assert.equal(
    (
      await authorized(
        "/__cloud/v1/tenants",
        scopedOperatorTokens.lifecycle,
        "POST",
        tenantProvisioningBody
      )
    ).status,
    400,
    "the lifecycle credential reaches provisioning validation, which still requires a trusted owner"
  );
  assert.equal(
    (await authorized("/__cloud/v1/tenants/tenant-a/oidc", scopedOperatorTokens.maintenance))
      .status,
    401
  );
  assert.equal(
    (await authorized("/__cloud/v1/tenants/tenant-a/oidc", "legacy-global-admin-token-0123456789"))
      .status,
    401
  );
  assert.equal(
    (
      await authorized(
        "/__cloud/v1/tenant-hosts?tenantId=tenant-a",
        "legacy-global-admin-token-0123456789"
      )
    ).status,
    401
  );
  assert.equal(
    (
      await authorized(
        "/__cloud/v1/front-desk/configs?tenantId=tenant-a",
        "legacy-global-admin-token-0123456789"
      )
    ).status,
    401
  );

  const duplicateScopeApp = createCloudRuntime({
    env: {
      DB: new TestD1(),
      OMNIROUTE_ENV: "production",
      OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN: scopedOperatorTokens.identity,
      OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN: scopedOperatorTokens.inference,
      OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN: scopedOperatorTokens.lifecycle,
      OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN: scopedOperatorTokens.identity,
      OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN: scopedOperatorTokens.frontDesk,
      OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: scopedOperatorTokens.maintenance,
      OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: cloudCredentialKey,
      OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: cloudIdempotencyKey,
    },
  });
  assert.equal(
    (
      await duplicateScopeApp.fetch(
        new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/oidc", {
          headers: { Authorization: `Bearer ${scopedOperatorTokens.identity}` },
        })
      )
    ).status,
    503,
    "duplicate operator credentials disable admin routes until corrected"
  );
});

test("staging readiness requires valid cloud runtime secrets without exposing their values", async () => {
  const sessions = {
    idFromName: (name: string) => name,
    get: () => ({ checkReadiness: async () => undefined }),
  } as never;
  const legacyAdminToken = "valid-admin-token-0123456789012345";
  const encryptionKey = Buffer.alloc(32, 7).toString("base64");
  const idempotencyKey = Buffer.alloc(32, 8).toString("base64");
  const runtimeBindings = {
    OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN: scopedOperatorTokens.identity,
    OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN: scopedOperatorTokens.inference,
    OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN: scopedOperatorTokens.lifecycle,
    OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN: scopedOperatorTokens.hosts,
    OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN: scopedOperatorTokens.frontDesk,
    OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: scopedOperatorTokens.maintenance,
    OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: idempotencyKey,
    GATEWAY_ARTIFACTS: { get: async () => null } as never,
  };
  const readinessRequest = () =>
    new Request("https://omniroute.test/__cloud/readiness", { method: "GET" });

  const missingRuntimeSecrets = createCloudRuntime({
    env: {
      OMNIROUTE_ENV: "staging",
      DB: new TestD1(),
      GATEWAY_SESSIONS: sessions,
      OMNIROUTE_CLOUD_ADMIN_TOKEN: legacyAdminToken,
      GATEWAY_ARTIFACTS: { get: async () => null } as never,
    },
  });
  const missingResponse = await missingRuntimeSecrets.fetch(readinessRequest());
  assert.equal(missingResponse.status, 503);
  const missingBody = (await missingResponse.json()) as {
    status: string;
    checks: Record<string, unknown>;
  };
  assert.equal(missingBody.status, "not_ready");
  assert.deepEqual(missingBody.checks, {
    database: "ok",
    gateway: "ok",
    artifacts: "ok",
    configuration: "unconfigured",
    configurationIssues: [
      "missing:identityAdminToken",
      "missing:inferenceAdminToken",
      "missing:lifecycleAdminToken",
      "missing:tenantHostsAdminToken",
      "missing:frontDeskAdminToken",
      "missing:maintenanceToken",
      "missing:credentialEncryptionKey",
      "missing:idempotencyKey",
    ],
  });
  assert.doesNotMatch(JSON.stringify(missingBody), /valid-admin|valid-maintenance/i);

  const malformedSecret = createCloudRuntime({
    env: {
      OMNIROUTE_ENV: "production",
      DB: new TestD1(),
      GATEWAY_SESSIONS: sessions,
      ...runtimeBindings,
      OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: "malformed-encryption-key",
    },
  });
  const malformedResponse = await malformedSecret.fetch(readinessRequest());
  assert.equal(malformedResponse.status, 503);
  const malformedBody = (await malformedResponse.json()) as {
    checks: Record<string, string>;
  };
  assert.equal(malformedBody.checks.configuration, "error");
  assert.doesNotMatch(JSON.stringify(malformedBody), /malformed-encryption-key/i);

  const configuredRuntime = createCloudRuntime({
    env: {
      OMNIROUTE_ENV: "staging",
      DB: new TestD1(),
      GATEWAY_SESSIONS: sessions,
      ...runtimeBindings,
    },
  });
  const configuredResponse = await configuredRuntime.fetch(readinessRequest());
  assert.equal(configuredResponse.status, 200);
  const configuredBody = (await configuredResponse.json()) as {
    status: string;
    checks: Record<string, string>;
  };
  assert.equal(configuredBody.status, "ready");
  assert.deepEqual(configuredBody.checks, {
    database: "ok",
    gateway: "ok",
    artifacts: "ok",
    configuration: "ok",
    configurationIssues: [],
  });

  const reusedSecretRuntime = createCloudRuntime({
    env: {
      OMNIROUTE_ENV: "staging",
      DB: new TestD1(),
      GATEWAY_SESSIONS: sessions,
      ...runtimeBindings,
      OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN: encryptionKey,
      OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    },
  });
  const reusedSecretResponse = await reusedSecretRuntime.fetch(readinessRequest());
  assert.equal(reusedSecretResponse.status, 503);
  const reusedSecretBody = (await reusedSecretResponse.json()) as {
    checks: Record<string, string>;
  };
  assert.equal(reusedSecretBody.checks.configuration, "error");
});

test("staging and production scoped operator tokens must meet the deployment secret policy", async () => {
  const weakTokenDb = new TestD1();
  const weakTokenRuntime = createCloudRuntime({
    env: {
      DB: weakTokenDb,
      OMNIROUTE_ENV: "staging",
      OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN: "short-admin-secret",
      OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: scopedOperatorTokens.maintenance,
    },
  });
  const weakAdminResponse = await weakTokenRuntime.fetch(
    request("/__cloud/v1/tenants/tenant-a/oidc", "short-admin-secret")
  );
  assert.equal(weakAdminResponse.status, 503);
  assert.equal(
    weakTokenDb.prepareCount,
    0,
    "invalid deployment secrets must fail before D1 access"
  );

  const weakMaintenanceDb = new TestD1();
  const weakMaintenanceRuntime = createCloudRuntime({
    env: {
      DB: weakMaintenanceDb,
      OMNIROUTE_ENV: "production",
      OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: "short-maintenance",
    },
  });
  const weakMaintenanceResponse = await weakMaintenanceRuntime.fetch(
    request("/__cloud/v1/tenants/tenant-a/status", "short-maintenance")
  );
  assert.equal(weakMaintenanceResponse.status, 503);
  assert.equal(
    weakMaintenanceDb.prepareCount,
    0,
    "invalid maintenance secrets must fail before D1 access"
  );

  const validTokenRuntime = createCloudRuntime({
    env: {
      DB: new TestD1(),
      OMNIROUTE_ENV: "staging",
      OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN: "valid-admin.token_0123456789-abcdefgh",
      OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN: scopedOperatorTokens.inference,
      OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN: scopedOperatorTokens.lifecycle,
      OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN: scopedOperatorTokens.hosts,
      OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN: scopedOperatorTokens.frontDesk,
      OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: scopedOperatorTokens.maintenance,
      OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: cloudCredentialKey,
      OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: cloudIdempotencyKey,
    },
  });
  assert.equal(
    (
      await validTokenRuntime.fetch(
        request("/__cloud/v1/tenants/tenant-a/oidc", "valid-admin.token_0123456789-abcdefgh")
      )
    ).status,
    200,
    "the configured URL-safe deployment token format must remain accepted"
  );
});

test("cloud runtime sends only the tenant admin API path boundary to the D1 admin handler", async () => {
  const db = new TestD1();
  const app = runtime(db);

  for (const path of ["/__cloud/v1/unrelated", "/__cloud/v1/tenantsExtra"]) {
    const response = await app.fetch(request(path));
    assert.equal(response.status, 404, `${path} should be rejected by the Worker router`);
  }
  assert.equal(db.prepareCount, 0, "unrelated cloud paths must not start a D1 operation");

  const tenantResponse = await app.fetch(request("/__cloud/v1/tenants/tenant-a"));
  assert.equal(tenantResponse.status, 200, "tenant admin routes must still reach the D1 handler");
  assert.ok(db.prepareCount > 0, "a valid tenant path must perform its D1-backed lookup");

  db.prepareCount = 0;
  const collectionResponse = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: "{invalid tenant payload}",
    })
  );
  assert.equal(collectionResponse.status, 400, "the tenant collection POST must remain routed");
  assert.ok(db.prepareCount > 0, "tenant collection creation must still reach the D1 handler");
});

test("cloud admin API bounds chunked JSON bodies while reading and cancels oversized streams", async () => {
  const app = runtime();
  let cancelled = false;
  let chunksSent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!chunksSent) {
        chunksSent = true;
        controller.enqueue(new Uint8Array(256 * 1024));
        controller.enqueue(new Uint8Array(1));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" })
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Request body is too large" });
  assert.equal(cancelled, true);
});

test("maintenance run history is bounded and readable only by the platform admin", async () => {
  const db = new TestD1();
  const app = runtime(db, undefined, undefined, "test-cloud-maintenance-secret");
  const response = await app.fetch(request("/__cloud/v1/tenants/maintenance/runs?limit=1"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    runs: [
      {
        id: 2,
        taskKey: "expired-oidc-artifacts",
        startedAtMs: 20_000,
        finishedAtMs: 20_025,
        durationMs: 25,
        outcome: "succeeded",
      },
    ],
  });

  const maintenanceOnly = await app.fetch(
    request("/__cloud/v1/tenants/maintenance/runs", "test-cloud-maintenance-secret")
  );
  assert.equal(maintenanceOnly.status, 401);
  assert.equal(
    (await app.fetch(request("/__cloud/v1/tenants/maintenance/runs?limit=101"))).status,
    400
  );
  assert.equal(
    (await app.fetch(request("/__cloud/v1/tenants/maintenance/runs?tenant=customer-a"))).status,
    400
  );
});

test("maintenance identity can inspect lifecycle status but cannot provision or access cloud CRUD", async () => {
  const db = new TestD1();
  const app = runtime(db, undefined, undefined, "test-cloud-maintenance-secret");
  const provision = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-cloud-maintenance-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "tenant-maintained",
        name: "Maintained",
        slug: "maintained",
      }),
    })
  );
  assert.equal(provision.status, 401);
  assert.equal(db.auditRows.length, 0);

  const lifecycle = await app.fetch(
    request("/__cloud/v1/tenants/tenant-a/status", "test-cloud-maintenance-secret")
  );
  assert.equal(lifecycle.status, 200);

  const providerRead = await app.fetch(
    request(
      "/__cloud/v1/tenants/tenant-a/provider-connections/alpha-openai",
      "test-cloud-maintenance-secret"
    )
  );
  assert.equal(providerRead.status, 401);

  const membershipMutation = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/memberships", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-cloud-maintenance-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ principalId: "principal-a", role: "owner" }),
    })
  );
  assert.equal(membershipMutation.status, 401);
});

test("tenant and device lifecycle routes enforce the platform-admin and maintenance token boundary", async () => {
  const maintenanceToken = "test-cloud-maintenance-secret";
  const tenantStatusPath = "/__cloud/v1/tenants/tenant-a/status";
  const deviceListPath = "/__cloud/v1/tenants/tenant-a/gateway-devices";

  const makeLifecycleRequest = (method: "GET" | "POST", token?: string) =>
    new Request(`https://omniroute.test${tenantStatusPath}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify({ status: "suspended" }) } : {}),
    });

  const makeDeviceRequest = (path: string, method: "GET" | "POST" | "DELETE", token?: string) =>
    new Request(`https://omniroute.test${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
    });

  const db = new TestD1();
  const app = runtime(db, undefined, undefined, maintenanceToken);

  // The maintenance credential is intentionally scoped to status lifecycle and
  // provisioning operations; it cannot enumerate or manage customer devices.
  assert.equal((await app.fetch(makeLifecycleRequest("GET"))).status, 401);
  assert.equal((await app.fetch(makeLifecycleRequest("GET", adminToken))).status, 200);
  assert.equal((await app.fetch(makeLifecycleRequest("GET", maintenanceToken))).status, 200);
  assert.equal((await app.fetch(makeDeviceRequest(deviceListPath, "GET"))).status, 401);
  assert.equal((await app.fetch(makeDeviceRequest(deviceListPath, "GET", adminToken))).status, 200);
  for (const [path, method] of [
    [deviceListPath, "GET"],
    [deviceListPath, "POST"],
    [`${deviceListPath}/device-a`, "DELETE"],
    [`${deviceListPath}/device-a/rotate-credential`, "POST"],
  ] as const) {
    const maintenanceDeviceResponse = await app.fetch(
      makeDeviceRequest(path, method, maintenanceToken)
    );
    assert.equal(maintenanceDeviceResponse.status, 401, `${method} ${path} is admin-only`);
    assert.deepEqual(await maintenanceDeviceResponse.json(), { error: "Unauthorized" });
  }

  const maintenanceMutation = await app.fetch(
    new Request(`https://omniroute.test${tenantStatusPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${maintenanceToken}`,
        "Content-Type": "application/json",
        "x-request-id": "maintenance-lifecycle-request",
      },
      body: JSON.stringify({ status: "suspended" }),
    })
  );
  assert.equal(maintenanceMutation.status, 200);
  assert.equal(db.auditRows.length, 2);
  for (const row of db.auditRows) {
    assert.equal(row[1], "tenant_shiryu_admin", "lifecycle audits use the platform tenant");
    assert.equal(row[3], "tenant.lifecycle.status");
    assert.equal(row[4], "cloud-maintenance", "actor comes from the verified token class");
    assert.equal(row[5], "tenant-a");
    assert.equal(row[8], "tenant");
    assert.equal(row[9], row === db.auditRows[0] ? "attempted" : "success");
    assert.equal(row[10], "maintenance-lifecycle-request");
    assert.equal(String(row[11]).includes(maintenanceToken), false);
  }

  const adminDb = new TestD1();
  const adminApp = runtime(adminDb, undefined, undefined, maintenanceToken);
  const adminMutation = await adminApp.fetch(
    new Request(`https://omniroute.test${tenantStatusPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
        "x-request-id": "admin-lifecycle-request",
      },
      body: JSON.stringify({ status: "suspended" }),
    })
  );
  assert.equal(adminMutation.status, 200);
  assert.equal(adminDb.auditRows.length, 2);
  assert.deepEqual(
    adminDb.auditRows.map((row) => row[4]),
    ["cloud-admin", "cloud-admin"],
    "platform-admin requests retain canonical audit attribution"
  );
  assert.equal(JSON.stringify(adminDb.auditRows).includes(adminToken), false);
});

test("cloud admin API fails closed when admin and maintenance tokens are identical", async () => {
  const app = createCloudRuntime({
    env: {
      DB: new TestD1(),
      OMNIROUTE_CLOUD_ADMIN_TOKEN: "shared-cloud-token",
      OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: "shared-cloud-token",
    },
  });
  const providerRead = await app.fetch(
    request("/__cloud/v1/tenants/tenant-a/provider-connections/alpha-openai", "shared-cloud-token")
  );
  assert.equal(providerRead.status, 503);
});

test("provider connection reads remain tenant-scoped and redact credentials", async () => {
  const app = runtime();
  const allowed = await app.fetch(
    request("/__cloud/v1/tenants/tenant-a/provider-connections/alpha-openai")
  );
  assert.equal(allowed.status, 200);
  const body = (await allowed.json()) as Record<string, unknown>;
  assert.equal(body.id, "alpha-openai");
  assert.equal(body.tenantId, "tenant-a");
  assert.equal(body.credentialOwnership, "customer_managed");
  assert.equal(body.executionLocation, "third_party");
  assert.equal(body.hasCredentials, true);
  assert.equal("accessToken" in body, false);
  assert.equal("providerSpecificData" in body, false);

  const crossTenant = await app.fetch(
    request("/__cloud/v1/tenants/tenant-b/provider-connections/alpha-openai")
  );
  assert.equal(crossTenant.status, 404);
});

test("provider API persists the typed ownership and execution location contract", async () => {
  const db = new TestD1();
  const app = runtime(db);
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/provider-connections", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "hosted-connection",
        provider: "openai",
        credentialOwnership: "shiryu_hosted",
        executionLocation: "shiryu_hosted",
      }),
    })
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.credentialOwnership, "shiryu_hosted");
  assert.equal(body.executionLocation, "shiryu_hosted");
  const stored = db.providerRows.find((row) => row.id === "hosted-connection");
  assert.equal(stored?.credential_ownership, "shiryu_hosted");
  assert.equal(stored?.execution_location, "shiryu_hosted");

  const invalid = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/provider-connections", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "invalid-contract",
        provider: "openai",
        credentialOwnership: "shiryu_owned",
      }),
    })
  );
  assert.equal(invalid.status, 400);
  assert.equal(
    db.providerRows.some((row) => row.id === "invalid-contract"),
    false
  );
});

test("cloud runtime rejects client-submitted provider credential ciphertext", async () => {
  const app = runtime();
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/provider-connections", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "new-connection",
        provider: "openai",
        apiKey: `enc:v1:${"0".repeat(32)}:abcd:${"1".repeat(32)}`,
      }),
    })
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "apiKey must be submitted as plaintext" });

  const v2Response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/provider-connections", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "new-connection-v2", provider: "openai", apiKey: "enc:v2:fake" }),
    })
  );
  assert.equal(v2Response.status, 400);
  assert.deepEqual(await v2Response.json(), { error: "apiKey must be submitted as plaintext" });
});

test("provider credential writes fail closed when the Worker wrapping key is missing", async () => {
  const db = new TestD1();
  const app = runtime(db);
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/provider-connections", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "new-connection", provider: "openai", apiKey: "plain-secret" }),
    })
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Cloud credential encryption is unavailable" });
  assert.equal(
    db.providerRows.some((row) => row.id === "new-connection"),
    false
  );
});

test("provider credential writes encrypt at the Worker and redact plaintext", async () => {
  const db = new TestD1();
  const app = runtime(db, undefined, cloudCredentialKey);
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/provider-connections", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "new-connection",
        provider: "openai",
        apiKey: "plain-secret",
        providerSpecificData: { refreshSecret: "nested-secret" },
      }),
    })
  );
  assert.equal(response.status, 201);
  const responseText = await response.text();
  assert.equal(responseText.includes("plain-secret"), false);
  assert.equal(responseText.includes("nested-secret"), false);
  assert.equal(responseText.includes("enc:v2:"), false);
  assert.equal(JSON.stringify(db.auditRows).includes("plain-secret"), false);
  assert.equal(JSON.stringify(db.auditRows).includes("nested-secret"), false);
  const stored = db.providerRows.find((row) => row.id === "new-connection");
  assert.ok(stored);
  assert.equal(isCloudCredentialEnvelope(stored.api_key), true);
  assert.equal(isCloudCredentialEnvelope(stored.provider_specific_data), true);
  assert.equal(
    await decryptCloudCredential(String(stored.api_key), cloudCredentialKey, {
      tenantId: "tenant-a",
      connectionId: "new-connection",
      field: "apiKey",
    }),
    "plain-secret"
  );
  assert.equal(
    await decryptCloudCredential(String(stored.provider_specific_data), cloudCredentialKey, {
      tenantId: "tenant-a",
      connectionId: "new-connection",
      field: "providerSpecificData",
    }),
    '{"refreshSecret":"nested-secret"}'
  );
});

test("provider connection patches preserve omitted legacy ciphertext", async () => {
  const db = new TestD1();
  const existing = db.providerRows.find((row) => row.id === "alpha-openai");
  assert.ok(existing);
  const legacy = existing.access_token;
  existing.provider_specific_data = `enc:v1:${"2".repeat(32)}:abcd:${"3".repeat(32)}`;
  const legacyProviderData = existing.provider_specific_data;
  const app = runtime(db, undefined, cloudCredentialKey);
  const response = await app.fetch(
    new Request(
      "https://omniroute.test/__cloud/v1/tenants/tenant-a/provider-connections/alpha-openai",
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Renamed" }),
      }
    )
  );
  assert.equal(response.status, 200);
  assert.equal(existing.access_token, legacy);
  assert.equal(existing.provider_specific_data, legacyProviderData);
  assert.equal(existing.name, "Renamed");
});

test("provider node routes redact custom header values", async () => {
  const app = runtime();
  const response = await app.fetch(request("/__cloud/v1/tenants/tenant-a/provider-nodes"));
  assert.equal(response.status, 200);
  const [node] = (await response.json()) as Array<Record<string, unknown>>;
  assert.equal(node.id, "alpha-custom");
  assert.equal(node.hasCustomHeaders, true);
  assert.equal("customHeadersJson" in node, false);
});

test("provider node custom headers are encrypted before D1 storage and redacted", async () => {
  const db = new TestD1();
  const app = runtime(db, undefined, cloudCredentialKey);
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/provider-nodes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "new-custom",
        type: "openai-compatible",
        name: "Custom provider",
        customHeadersJson: '{"Authorization":"Bearer node-secret"}',
      }),
    })
  );
  assert.equal(response.status, 201);
  const body = await response.text();
  assert.equal(body.includes("node-secret"), false);
  const stored = db.providerNodeRows.find((row) => row.id === "new-custom");
  assert.ok(stored);
  assert.equal(isCloudCredentialEnvelope(stored.custom_headers_json), true);
  assert.equal(
    await decryptCloudCredential(String(stored.custom_headers_json), cloudCredentialKey, {
      tenantId: "tenant-a",
      connectionId: "new-custom",
      field: "customHeadersJson",
    }),
    '{"Authorization":"Bearer node-secret"}'
  );
});

test("cloud admin mutations are audited against the resolved target tenant", async () => {
  const db = new TestD1();
  const app = runtime(db);
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/provider-connections", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenantId: "tenant-b", id: "invalid" }),
    })
  );
  assert.equal(response.status, 400);
  assert.equal(db.auditRows.length, 1);
  assert.equal(db.auditRows[0][1], "tenant-a");
  assert.equal(db.auditRows[0][3], "cloud.api.post");
  assert.equal(db.auditRows[0][4], "cloud-admin");
});

test("cloud admin request rate limits are tenant isolated and reject excess requests", async () => {
  const db = new TestD1();
  const app = runtime(db, { limit: 1, windowMs: 60_000 });
  assert.equal((await app.fetch(request("/__cloud/v1/tenants/tenant-a"))).status, 200);
  assert.equal((await app.fetch(request("/__cloud/v1/tenants/tenant-a"))).status, 429);
  assert.equal((await app.fetch(request("/__cloud/v1/tenants/tenant-b"))).status, 200);
});

test("tenant creation accounting uses the seeded platform tenant and omits request bodies", async () => {
  const db = new TestD1();
  const app = runtime(db);
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: "{invalid tenant payload}",
    })
  );
  assert.equal(response.status, 400);
  assert.equal(db.rateCounts.size, 1);
  assert.equal([...db.rateCounts.keys()][0].startsWith("tenant_shiryu_admin:"), true);
  assert.equal(db.auditRows.length, 1);
  assert.equal(db.auditRows[0][1], "tenant_shiryu_admin");
  assert.equal(db.auditRows[0][3], "cloud.api.post");
  assert.equal(db.auditRows[0][5], "tenants");
  assert.equal(String(db.auditRows[0][11]).includes("invalid tenant payload"), false);
});

test("cloud usage API writes and reads tenant-scoped D1 history", async () => {
  const db = new TestD1();
  const app = runtime(db);
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/usage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "request-a",
        provider: "openai",
        model: "gpt-test",
        tokensInput: 12,
        tokensOutput: 7,
        endpoint: "/v1/chat/completions?api_key=do-not-store",
        timestamp: "2026-10-08T12:00:00.000Z",
      }),
    })
  );

  assert.equal(response.status, 201);
  const written = (await response.json()) as Record<string, unknown>;
  assert.equal(written.tenantId, "tenant-a");
  assert.equal(written.endpoint, "/v1/chat/completions");

  const tenantOverride = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/usage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "request-spoof", tenantId: "tenant-b" }),
    })
  );
  assert.equal(tenantOverride.status, 400);
  assert.equal(db.usageRows.length, 1);

  const ownRows = await app.fetch(request("/__cloud/v1/tenants/tenant-a/usage"));
  assert.equal(ownRows.status, 200);
  const own = (await ownRows.json()) as Array<Record<string, unknown>>;
  assert.equal(own.length, 1);
  assert.equal(own[0].id, "request-a");
  assert.equal(own[0].tokensInput, 12);

  const otherRows = await app.fetch(request("/__cloud/v1/tenants/tenant-b/usage"));
  assert.deepEqual(await otherRows.json(), []);

  const badLimit = await app.fetch(request("/__cloud/v1/tenants/tenant-a/usage?limit=501"));
  assert.equal(badLimit.status, 400);
  const badDate = await app.fetch(request("/__cloud/v1/tenants/tenant-a/usage?from=not-a-date"));
  assert.equal(badDate.status, 400);
});

test("cloud usage API exposes a stable timestamp and id cursor", async () => {
  const db = new TestD1();
  const app = runtime(db);
  const timestamp = "2026-10-08T12:00:00.000Z";
  for (const id of ["usage-a", "usage-b", "usage-c"]) {
    const response = await app.fetch(
      new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/usage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, timestamp }),
      })
    );
    assert.equal(response.status, 201);
  }

  const page = await app.fetch(
    request(
      `/__cloud/v1/tenants/tenant-a/usage?limit=2&beforeTimestamp=${encodeURIComponent(timestamp)}&beforeId=usage-c`
    )
  );
  assert.equal(page.status, 200);
  assert.deepEqual(
    ((await page.json()) as Array<Record<string, unknown>>).map((row) => row.id),
    ["usage-b", "usage-a"]
  );

  const partialCursor = await app.fetch(
    request(`/__cloud/v1/tenants/tenant-a/usage?beforeTimestamp=${encodeURIComponent(timestamp)}`)
  );
  assert.equal(partialCursor.status, 400);
  const invalidCursor = await app.fetch(
    request(`/__cloud/v1/tenants/tenant-a/usage?beforeTimestamp=not-a-date&beforeId=usage-c`)
  );
  assert.equal(invalidCursor.status, 400);
});

test("tenant creation accounting fails closed when the platform row is not platform-admin", async () => {
  const db = new TestD1();
  db.tenants[0].kind = "customer";
  const app = runtime(db);
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "new-tenant", name: "New tenant", slug: "new-tenant" }),
    })
  );
  assert.equal(response.status, 503);
  assert.equal(db.rateCounts.size, 0);
  assert.equal(db.auditRows.length, 0);
});
