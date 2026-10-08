import assert from "node:assert/strict";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "@/cloud/db";
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
      const row = connections.find(
        (connection) => connection.tenant_id === tenantId && connection.id === id
      );
      return (row ?? null) as U | null;
    }
    if (this.sql.includes("FROM provider_nodes")) {
      const [tenantId, id] = this.values;
      const row = nodes.find((node) => node.tenant_id === tenantId && node.id === id);
      return (row ?? null) as U | null;
    }
    return null;
  }

  async all<U = T>(): Promise<{ results: U[]; success: boolean }> {
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
      const rows = connections.filter((connection) => connection.tenant_id === this.values[0]);
      return { results: rows as U[], success: true };
    }
    if (this.sql.includes("FROM provider_nodes")) {
      const rows = nodes.filter((node) => node.tenant_id === this.values[0]);
      return { results: rows as U[], success: true };
    }
    if (this.sql.startsWith("SELECT * FROM cloud_usage_history")) {
      const rows = this.database.usageRows
        .filter((row) => row.tenant_id === this.values[0])
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
  readonly tenants = tenants.map((tenant) => ({ ...tenant }));
  readonly rateCounts = new Map<string, number>();
  readonly auditRows: unknown[][] = [];
  readonly usageRows: Record<string, unknown>[] = [];

  prepare<T = unknown>(sql: string) {
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

function runtime(db = new TestD1(), adminRateLimit?: { limit: number; windowMs: number }) {
  return createCloudRuntime({
    env: { DB: db, OMNIROUTE_CLOUD_ADMIN_TOKEN: adminToken },
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

test("provider connection reads remain tenant-scoped and redact credentials", async () => {
  const app = runtime();
  const allowed = await app.fetch(
    request("/__cloud/v1/tenants/tenant-a/provider-connections/alpha-openai")
  );
  assert.equal(allowed.status, 200);
  const body = (await allowed.json()) as Record<string, unknown>;
  assert.equal(body.id, "alpha-openai");
  assert.equal(body.tenantId, "tenant-a");
  assert.equal(body.hasCredentials, true);
  assert.equal("accessToken" in body, false);
  assert.equal("providerSpecificData" in body, false);

  const crossTenant = await app.fetch(
    request("/__cloud/v1/tenants/tenant-b/provider-connections/alpha-openai")
  );
  assert.equal(crossTenant.status, 404);
});

test("cloud runtime rejects plaintext provider credentials at the API boundary", async () => {
  const app = runtime();
  const response = await app.fetch(
    new Request("https://omniroute.test/__cloud/v1/tenants/tenant-a/provider-connections", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "new-connection", provider: "openai", apiKey: "plaintext" }),
    })
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "apiKey must be encrypted before storage" });
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
