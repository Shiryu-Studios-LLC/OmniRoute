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
import { decryptCloudCredential } from "../../src/cloud/credentialEncryption";
import { provisionCloudCustomer } from "../../src/cloud/provisioning";
import { createCloudRuntime } from "../../src/cloud/runtime";
import { getCloudTenantMcpCredential } from "../../src/cloud/tenantMcpServers";
import { handleCloudTenantMcpRequest } from "../../src/cloud/tenantMcpHttpApi";

const ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
const NOW = "2026-10-08T12:00:00.000Z";
const ORIGIN = "https://cloud.example.test";
const COLLECTION = "/__cloud/v1/customer/mcp-servers";

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
    "0005_cloud_customer_identity.sql",
    "0008_cloud_tenant_settings.sql",
    "0019_cloud_tenant_mcp_servers.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  return db;
}

interface Principal {
  tenantId: string;
  principalId: string;
  membershipId: string;
  token: string;
  role: "owner" | "admin" | "member" | "viewer";
}

async function makePrincipal(
  db: CloudDb,
  tenantId: string,
  role: Principal["role"],
  principalId: string
): Promise<Principal> {
  const membership = await createCloudCustomerMembership(db, {
    tenantId,
    principalId,
    role,
    now: NOW,
  });
  const apiKey = await issueCloudCustomerApiKey(db, {
    tenantId,
    membershipId: membership.id,
    now: NOW,
  });
  return { tenantId, principalId, membershipId: membership.id, token: apiKey.token, role };
}

async function provision(db: CloudDb, id: string, slug = id) {
  const customer = await provisionCloudCustomer(db, {
    id,
    name: id,
    slug,
    ownerPrincipalId: `${id}-owner`,
    now: NOW,
  });
  return {
    tenantId: id,
    principalId: `${id}-owner`,
    membershipId: customer.ownerMembership.id,
    token: customer.ownerApiKey.token,
    role: "owner" as const,
  };
}

async function enableMcp(db: CloudDb, ...tenantIds: string[]): Promise<void> {
  for (const tenantId of tenantIds) {
    await db
      .prepare("UPDATE cloud_tenant_settings SET mcp_enabled = 1 WHERE tenant_id = ?")
      .bind(tenantId)
      .run();
  }
}

function request(
  token: string,
  method: string,
  path = COLLECTION,
  body?: unknown,
  options: { rawBody?: string; includeLength?: boolean } = {}
): Request {
  const rawBody = options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (rawBody !== undefined) {
    headers.set("Content-Type", "application/json");
    if (options.includeLength !== false)
      headers.set("Content-Length", String(Buffer.byteLength(rawBody)));
  }
  const req = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: rawBody,
  });
  (req as Request & { cf?: unknown }).cf = { colo: "test" };
  req.headers.set("cf-connecting-ip", "192.0.2.12");
  return req;
}

async function call(db: CloudDb, req: Request, overrides: Record<string, unknown> = {}) {
  return handleCloudTenantMcpRequest(req, {
    db,
    credentialEncryptionKey: ENCRYPTION_KEY,
    now: () => new Date(NOW),
    ...overrides,
  });
}

async function body<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

test("D1 MCP migration creates tenant-partitioned rows and enforces transport and active checks", async () => {
  const db = await migratedDb();
  try {
    await db.exec(
      readFileSync(
        join(process.cwd(), "cloudflare/migrations/0019_cloud_tenant_mcp_servers.sql"),
        "utf8"
      )
    );
    await assert.rejects(
      db
        .prepare(
          `INSERT INTO cloud_tenant_mcp_servers
        (id, tenant_id, name, transport, endpoint, is_active, created_at, updated_at)
        VALUES ('bad', 'missing', 'bad', 'stdio', 'https://example.test/mcp', 1, ?, ?)`
        )
        .bind(NOW, NOW)
        .run(),
      /CHECK constraint failed/
    );
  } finally {
    db.db.close();
  }
});

test("customer MCP registry CRUD encrypts credentials and never contacts saved endpoints", async () => {
  const db = await migratedDb();
  try {
    const owner = await provision(db, "mcp-crud-a");
    await enableMcp(db, owner.tenantId);
    let outboundRequests = 0;
    const runtime = createCloudRuntime({
      env: { DB: db, OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY },
      now: () => new Date(NOW),
      fetcher: async () => {
        outboundRequests += 1;
        throw new Error("MCP registry routes must never fetch customer endpoints");
      },
    });
    const create = await runtime.fetch(
      request(owner.token, "POST", COLLECTION, {
        name: "Docs",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        credential: "mcp-bearer-secret-123",
      })
    );
    assert.equal(create.status, 201);
    const created = await body<{ server: { id: string; hasCredential: boolean } }>(create);
    assert.equal(created.server.hasCredential, true);

    const row = await db
      .prepare<{ credential_encrypted: string }>(
        "SELECT credential_encrypted FROM cloud_tenant_mcp_servers WHERE tenant_id = ? AND id = ?"
      )
      .bind(owner.tenantId, created.server.id)
      .first();
    assert.ok(row?.credential_encrypted);
    assert.notEqual(row.credential_encrypted, "mcp-bearer-secret-123");
    assert.equal(
      await decryptCloudCredential(row.credential_encrypted, ENCRYPTION_KEY, {
        tenantId: owner.tenantId,
        connectionId: created.server.id,
        field: "mcpCredential",
      }),
      "mcp-bearer-secret-123"
    );

    const list = await runtime.fetch(request(owner.token, "GET"));
    assert.equal(list.status, 200);
    const listText = await list.text();
    assert.match(listText, /mcp\.example\.test/);
    assert.match(listText, /hasCredential/);
    assert.doesNotMatch(listText, /mcp-bearer-secret-123|credential_encrypted/);

    const updated = await runtime.fetch(
      request(owner.token, "PUT", `${COLLECTION}/${created.server.id}`, {
        name: "Docs Updated",
        credential: "mcp-bearer-rotated-secret",
      })
    );
    assert.equal(updated.status, 200);
    const updatedText = await updated.text();
    assert.match(updatedText, /Docs Updated/);
    assert.doesNotMatch(updatedText, /mcp-bearer-rotated-secret/);
    assert.equal(
      await getCloudTenantMcpCredential(db, owner.tenantId, created.server.id, ENCRYPTION_KEY),
      "mcp-bearer-rotated-secret"
    );

    const removed = await runtime.fetch(
      request(owner.token, "DELETE", `${COLLECTION}/${created.server.id}`)
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(await body(removed), { deleted: true });
    assert.equal(
      await getCloudTenantMcpCredential(db, owner.tenantId, created.server.id, ENCRYPTION_KEY),
      null
    );
    assert.equal(outboundRequests, 0);
    const audit = await db
      .prepare<{ action: string; target: string; details_json: string | null }>(
        "SELECT action, target, details_json FROM cloud_compliance_audit WHERE tenant_id = ? AND action LIKE 'cloud.mcp_server.%' ORDER BY timestamp, rowid"
      )
      .bind(owner.tenantId)
      .all();
    assert.deepEqual(
      audit.results.map((entry) => entry.action),
      ["cloud.mcp_server.create", "cloud.mcp_server.update", "cloud.mcp_server.delete"]
    );
    assert.ok(audit.results.every((entry) => !JSON.stringify(entry).includes("mcp-bearer")));
  } finally {
    db.db.close();
  }
});

test("MCP registry requires enabled customer opt-in and owner or admin API keys", async () => {
  const db = await migratedDb();
  try {
    const owner = await provision(db, "mcp-opt-a");
    const member = await makePrincipal(db, owner.tenantId, "member", "mcp-opt-member");
    const admin = await makePrincipal(db, owner.tenantId, "admin", "mcp-opt-admin");
    const config = { name: "One", transport: "sse", endpoint: "https://mcp.example.test" };
    assert.equal((await call(db, request(owner.token, "GET")))?.status, 403);
    assert.equal((await call(db, request(owner.token, "POST", COLLECTION, config)))?.status, 403);
    await enableMcp(db, owner.tenantId);
    assert.equal((await call(db, request(member.token, "GET")))?.status, 403);
    assert.equal((await call(db, request(member.token, "POST", COLLECTION, config)))?.status, 403);
    assert.equal((await call(db, request(admin.token, "POST", COLLECTION, config)))?.status, 201);
    assert.equal((await call(db, request("orc_live_invalid", "GET")))?.status, 401);
  } finally {
    db.db.close();
  }
});

test("MCP registry derives tenant from key and returns 404 for another tenant's server", async () => {
  const db = await migratedDb();
  try {
    const ownerA = await provision(db, "mcp-tenant-a");
    const ownerB = await provision(db, "mcp-tenant-b");
    await enableMcp(db, ownerA.tenantId, ownerB.tenantId);
    const created = await call(
      db,
      request(ownerA.token, "POST", COLLECTION, {
        name: "A only",
        transport: "sse",
        endpoint: "https://mcp-a.example.test/sse",
      })
    );
    assert.equal(created?.status, 201);
    const server = await body<{ server: { id: string } }>(created!);
    for (const [method, bodyValue] of [
      ["GET", undefined],
      ["PUT", { name: "Stolen" }],
      ["DELETE", undefined],
    ] as const) {
      const response = await call(
        db,
        request(ownerB.token, method, `${COLLECTION}/${server.server.id}`, bodyValue)
      );
      assert.equal(response?.status, 404, `${method} must hide a foreign tenant server`);
    }
    const listB = await call(db, request(ownerB.token, "GET"));
    assert.deepEqual(await body(listB!), { servers: [] });
    const override = await call(
      db,
      request(ownerB.token, "POST", COLLECTION, {
        tenantId: ownerA.tenantId,
        name: "Override",
        transport: "sse",
        endpoint: "https://mcp-b.example.test/sse",
      })
    );
    assert.equal(override?.status, 400);
  } finally {
    db.db.close();
  }
});

test("MCP endpoint schemas reject unsafe or ambiguous URLs without probing them", async () => {
  const db = await migratedDb();
  try {
    const owner = await provision(db, "mcp-endpoint-a");
    await enableMcp(db, owner.tenantId);
    for (const endpoint of [
      "http://mcp.example.test/mcp",
      "https://user:pass@mcp.example.test/mcp",
      "https://mcp.example.test/mcp?token=secret",
      "https://mcp.example.test/mcp#fragment",
    ]) {
      const response = await call(
        db,
        request(owner.token, "POST", COLLECTION, { name: "Bad", transport: "sse", endpoint })
      );
      assert.equal(response?.status, 400, endpoint);
    }
    const count = await db
      .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM cloud_tenant_mcp_servers")
      .first();
    assert.equal(count?.count, 0);
  } finally {
    db.db.close();
  }
});

test("credential writes fail closed without encryption and audit failure rolls back CRUD", async () => {
  const db = await migratedDb();
  try {
    const owner = await provision(db, "mcp-atomic-a");
    await enableMcp(db, owner.tenantId);
    const missingKey = await call(
      db,
      request(owner.token, "POST", COLLECTION, {
        name: "No key",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        credential: "secret-must-not-store",
      }),
      { credentialEncryptionKey: undefined }
    );
    assert.equal(missingKey?.status, 503);
    const noRow = await db
      .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM cloud_tenant_mcp_servers")
      .first();
    assert.equal(noRow?.count, 0);

    await db.exec(`CREATE TRIGGER fail_mcp_audit BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action LIKE 'cloud.mcp_server.%'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const response = await call(
      db,
      request(owner.token, "POST", COLLECTION, {
        name: "Atomic",
        transport: "sse",
        endpoint: "https://mcp.example.test/sse",
      })
    );
    assert.equal(response?.status, 503);
    const count = await db
      .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM cloud_tenant_mcp_servers")
      .first();
    assert.equal(count?.count, 0, "server insert must roll back if its audit insert fails");
  } finally {
    db.db.close();
  }
});

test("MCP API enforces IP and tenant rate limits and bounds streamed JSON bodies", async () => {
  const db = await migratedDb();
  try {
    const owner = await provision(db, "mcp-limits-a");
    await enableMcp(db, owner.tenantId);
    const authLimit = await call(db, request("orc_live_invalid", "GET"), {
      failedKeyRateLimit: { limit: 1, windowMs: 60_000 },
    });
    assert.equal(authLimit?.status, 401);
    const authBlocked = await call(db, request("orc_live_invalid", "GET"), {
      failedKeyRateLimit: { limit: 1, windowMs: 60_000 },
    });
    assert.equal(authBlocked?.status, 429);

    const oversized = await call(
      db,
      request(owner.token, "POST", COLLECTION, undefined, {
        rawBody: JSON.stringify({ name: "Large", padding: "x".repeat(17 * 1024) }),
        includeLength: false,
      })
    );
    assert.equal(oversized?.status, 413);
    const slowBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
    });
    const slowRequest = new Request(`${ORIGIN}${COLLECTION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: slowBody,
      // @ts-expect-error Node's RequestInit supports duplex for streaming request bodies.
      duplex: "half",
    });
    (slowRequest as Request & { cf?: unknown }).cf = { colo: "test" };
    slowRequest.headers.set("cf-connecting-ip", "192.0.2.12");
    const timedOut = await call(db, slowRequest, { bodyReadTimeoutMs: 10 });
    assert.equal(timedOut?.status, 408);

    const tenantLimit = await call(db, request(owner.token, "GET"), {
      tenantRateLimit: { limit: 1, windowMs: 60_000 },
    });
    assert.equal(tenantLimit?.status, 200);
    const tenantBlocked = await call(db, request(owner.token, "GET"), {
      tenantRateLimit: { limit: 1, windowMs: 60_000 },
    });
    assert.equal(tenantBlocked?.status, 429);
  } finally {
    db.db.close();
  }
});
