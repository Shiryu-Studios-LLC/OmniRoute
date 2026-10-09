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
import {
  decryptCloudCredential,
  isCloudCredentialEnvelope,
} from "../../src/cloud/credentialEncryption";
import { createCloudRuntime } from "../../src/cloud/runtime";
import { createCloudProviderConnection } from "../../src/cloud/providers";

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
  async all<U = T>(): Promise<{ results: U[]; success: boolean }> {
    return {
      results: this.db.prepare(this.sql).all(...(this.values as never[])) as U[],
      success: true,
    };
  }
  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    const result = this.db.prepare(this.sql).run(...(this.values as never[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteCloudDb implements CloudDb {
  readonly db = new DatabaseSync(":memory:");
  beforeNextBatch?: () => void;
  constructor() {
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new SqliteStatement<T>(this.db, sql);
  }
  async batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const beforeNextBatch = this.beforeNextBatch;
      this.beforeNextBatch = undefined;
      beforeNextBatch?.();
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

const NOW = "2026-10-08T12:00:00.000Z";
const WRAP_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const SECRET = "sk-test-customer-provider-secret";

async function fixture() {
  const db = new SqliteCloudDb();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0005_cloud_customer_identity.sql",
    "0022_provider_execution_contract.sql",
  ])
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));

  const tokens: Record<string, string> = {};
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    await db
      .prepare(
        `INSERT INTO tenants (id,name,slug,kind,is_active,created_at,updated_at)
       VALUES (?, ?, ?, 'customer', 1, ?, ?)`
      )
      .bind(tenantId, tenantId, tenantId, NOW, NOW)
      .run();
  }
  for (const [tenantId, role, name] of [
    ["tenant-a", "owner", "owner"],
    ["tenant-a", "admin", "admin"],
    ["tenant-a", "member", "member"],
    ["tenant-a", "viewer", "viewer"],
    ["tenant-b", "owner", "owner-b"],
  ] as const) {
    const membership = await createCloudCustomerMembership(db, {
      tenantId,
      principalId: `${tenantId}-${name}`,
      role,
      now: NOW,
    });
    tokens[name] = (
      await issueCloudCustomerApiKey(db, {
        tenantId,
        membershipId: membership.id,
        now: NOW,
      })
    ).token;
  }
  const runtime = createCloudRuntime({
    env: { DB: db, OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: WRAP_KEY },
    now: () => new Date(NOW),
    customerProviderBodyTimeoutMs: 10,
  });
  const call = (token: string, method = "GET", path = "", body?: unknown) =>
    runtime.fetch(
      new Request(`https://cloud.test/__cloud/v1/customer/provider-connections${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    );
  return { db, tokens, call, runtime };
}

test("customer owners/admins provision only the fixed provider contract and never receive secrets", async () => {
  const { db, tokens, call } = await fixture();
  const response = await call(tokens.owner, "POST", "", {
    id: "openai-a",
    provider: "openai",
    apiKey: SECRET,
    name: "Team OpenAI",
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.provider, "openai");
  assert.equal(body.credentialOwnership, "customer_managed");
  assert.equal(body.executionLocation, "third_party");
  assert.equal(body.hasCredentials, true);
  assert.equal(JSON.stringify(body).includes(SECRET), false);
  assert.equal(JSON.stringify(body).includes("apiKey"), false);

  const stored = await db
    .prepare<{ api_key: string; provider: string; default_model: string }>(
      "SELECT api_key, provider, default_model FROM provider_connections WHERE tenant_id = ? AND id = ?"
    )
    .bind("tenant-a", "openai-a")
    .first();
  assert.ok(stored && isCloudCredentialEnvelope(stored.api_key));
  assert.equal(
    await decryptCloudCredential(stored!.api_key, WRAP_KEY, {
      tenantId: "tenant-a",
      connectionId: "openai-a",
      field: "apiKey",
    }),
    SECRET
  );
  await assert.rejects(() =>
    decryptCloudCredential(stored!.api_key, WRAP_KEY, {
      tenantId: "tenant-b",
      connectionId: "openai-a",
      field: "apiKey",
    })
  );
  assert.equal(stored!.provider, "openai");
  assert.equal(stored!.default_model, "gpt-4o-mini-2024-07-18");

  const admin = await call(tokens.admin, "POST", "", {
    id: "openai-admin",
    provider: "openai",
    apiKey: "sk-admin-key",
  });
  assert.equal(admin.status, 201);
  const audit = await db
    .prepare<{ count: number }>(
      "SELECT COUNT(*) AS count FROM cloud_compliance_audit WHERE tenant_id = ? AND action = ?"
    )
    .bind("tenant-a", "customer.provider_connection.create")
    .first();
  assert.equal(audit?.count, 2);
});

test("provider configuration is tenant-isolated and member/viewer keys cannot read or mutate it", async () => {
  const { db, tokens, call } = await fixture();
  assert.equal(
    (
      await call(tokens.owner, "POST", "", {
        id: "openai-a",
        provider: "openai",
        apiKey: SECRET,
      })
    ).status,
    201
  );
  await createCloudProviderConnection(db, {
    id: "platform-owned-openai",
    tenantId: "tenant-a",
    provider: "openai",
    apiKey: "platform-owned-secret",
    credentialOwnership: "shiryu_hosted",
    executionLocation: "shiryu_hosted",
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(
    (
      await call(tokens["owner-b"], "POST", "", {
        id: "openai-b",
        provider: "openai",
        apiKey: "sk-tenant-b-secret",
      })
    ).status,
    201
  );

  const crossTenantRead = await call(tokens["owner-b"], "GET", "/openai-a");
  assert.equal(crossTenantRead.status, 404);
  assert.equal((await call(tokens.owner, "GET", "/openai-b")).status, 404);
  const crossTenantList = (await (await call(tokens["owner-b"])).json()) as {
    connections: unknown[];
  };
  assert.equal(crossTenantList.connections.length, 1);
  assert.equal((crossTenantList.connections[0] as { id: string }).id, "openai-b");
  const tenantAList = (await (await call(tokens.owner)).json()) as {
    connections: { id: string }[];
  };
  assert.deepEqual(
    tenantAList.connections.map((connection) => connection.id),
    ["openai-a"]
  );
  assert.equal((await call(tokens.owner, "GET", "/platform-owned-openai")).status, 404);
  assert.equal(
    (await call(tokens.owner, "PATCH", "/platform-owned-openai", { name: "take over" })).status,
    404
  );
  assert.equal((await call(tokens.owner, "DELETE", "/platform-owned-openai")).status, 404);
  const platformRow = await db
    .prepare<{ credential_ownership: string; name: string | null }>(
      "SELECT credential_ownership, name FROM provider_connections WHERE tenant_id = ? AND id = ?"
    )
    .bind("tenant-a", "platform-owned-openai")
    .first();
  assert.equal(platformRow?.credential_ownership, "shiryu_hosted");
  assert.equal(platformRow?.name, null);

  for (const role of ["member", "viewer"] as const) {
    assert.equal((await call(tokens[role])).status, 403);
    assert.equal(
      (
        await call(tokens[role], "POST", "", {
          id: `blocked-${role}`,
          provider: "openai",
          apiKey: SECRET,
        })
      ).status,
      403
    );
    assert.equal((await call(tokens[role], "PATCH", "/openai-a", { name: "changed" })).status, 403);
    assert.equal((await call(tokens[role], "DELETE", "/openai-a")).status, 403);
  }
});

test("customer API rejects unsupported providers and contract overrides", async () => {
  const { tokens, call } = await fixture();
  for (const body of [
    { id: "claude", provider: "anthropic", apiKey: SECRET },
    { id: "hosted", provider: "openai", apiKey: SECRET, executionLocation: "shiryu_hosted" },
    { id: "alternate-model", provider: "openai", apiKey: SECRET, defaultModel: "gpt-4.1" },
    { id: "ciphertext", provider: "openai", apiKey: "enc:v2:client-submitted" },
  ])
    assert.equal((await call(tokens.owner, "POST", "", body)).status, 400);
  assert.equal(
    (
      await call(tokens.owner, "POST", "", {
        id: "malformed",
        provider: "openai",
        apiKey: SECRET,
        credentialOwnership: "shiryu_hosted",
      })
    ).status,
    400
  );
});

test("provider mutation rolls back when its atomic compliance audit insert fails", async () => {
  const { db, tokens, call } = await fixture();
  await db.exec(`CREATE TRIGGER fail_provider_audit BEFORE INSERT ON cloud_compliance_audit
    WHEN NEW.action = 'customer.provider_connection.create'
    BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
  const response = await call(tokens.owner, "POST", "", {
    id: "atomic",
    provider: "openai",
    apiKey: SECRET,
  });
  assert.equal(response.status, 503);
  const created = await db
    .prepare<{ count: number }>(
      "SELECT COUNT(*) AS count FROM provider_connections WHERE tenant_id = ? AND id = ?"
    )
    .bind("tenant-a", "atomic")
    .first();
  assert.equal(created?.count, 0);
});

test("duplicate IDs conflict, updates and deletes audit atomically, and concurrent deletion returns not-found", async () => {
  const { db, tokens, call } = await fixture();
  const createBody = { id: "lifecycle", provider: "openai", apiKey: SECRET };
  assert.equal((await call(tokens.owner, "POST", "", createBody)).status, 201);
  assert.equal((await call(tokens.owner, "POST", "", createBody)).status, 409);

  const patch = await call(tokens.owner, "PATCH", "/lifecycle", {
    apiKey: "sk-rotated-customer-secret",
    name: "Rotated",
  });
  assert.equal(patch.status, 200);
  const patchBody = await patch.text();
  assert.equal(patchBody.includes("sk-rotated-customer-secret"), false);
  assert.equal(patchBody.includes(SECRET), false);

  assert.equal((await call(tokens.owner, "DELETE", "/lifecycle")).status, 200);
  assert.equal((await call(tokens.owner, "DELETE", "/lifecycle")).status, 404);

  assert.equal(
    (
      await call(tokens.owner, "POST", "", {
        id: "raced-delete",
        provider: "openai",
        apiKey: SECRET,
      })
    ).status,
    201
  );
  db.beforeNextBatch = () => {
    db.db
      .prepare("DELETE FROM provider_connections WHERE tenant_id = ? AND id = ?")
      .run("tenant-a", "raced-delete");
  };
  assert.equal((await call(tokens.owner, "DELETE", "/raced-delete")).status, 404);
  const audit = await db
    .prepare<{ action: string; count: number }>(
      `SELECT action, COUNT(*) AS count FROM cloud_compliance_audit
     WHERE tenant_id = 'tenant-a' AND action LIKE 'customer.provider_connection.%'
     GROUP BY action ORDER BY action`
    )
    .all();
  assert.deepEqual(
    audit.results.map((row) => ({ ...row })),
    [
      { action: "customer.provider_connection.create", count: 2 },
      { action: "customer.provider_connection.delete", count: 1 },
      { action: "customer.provider_connection.update", count: 1 },
    ]
  );
});

test("customer provider request body reads time out", async () => {
  const { runtime, tokens } = await fixture();
  const request = new Request("https://cloud.test/__cloud/v1/customer/provider-connections", {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.owner}`,
      "content-type": "application/json",
    },
    body: new ReadableStream<Uint8Array>({ start() {} }),
    duplex: "half",
  } as RequestInit);
  const response = await runtime.fetch(request);
  assert.equal(response.status, 408);
});
