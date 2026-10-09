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
  readonly tenants = tenants.map((tenant) => ({ ...tenant }));
  readonly providerRows = connections.map((connection) => ({ ...connection }));
  readonly providerNodeRows = nodes.map((node) => ({ ...node }));
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

const cloudCredentialKey = Buffer.alloc(32, 7).toString("base64");

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

test("maintenance identity requires an owner to provision and cannot access cloud CRUD", async () => {
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
  assert.equal(provision.status, 400);
  assert.equal(db.auditRows[0][4], "cloud-maintenance");

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
  assert.equal(body.hasCredentials, true);
  assert.equal("accessToken" in body, false);
  assert.equal("providerSpecificData" in body, false);

  const crossTenant = await app.fetch(
    request("/__cloud/v1/tenants/tenant-b/provider-connections/alpha-openai")
  );
  assert.equal(crossTenant.status, 404);
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
