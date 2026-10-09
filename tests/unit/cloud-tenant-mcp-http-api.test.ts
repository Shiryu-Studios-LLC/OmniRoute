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
import { createMcpEgressProxyHandler } from "../../cloudflare/mcp-egress-proxy/handler.ts";

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
    const config = {
      name: "One",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test",
    };
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
        transport: "streamable_http",
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
        transport: "streamable_http",
        endpoint: "https://mcp-b.example.test/sse",
      })
    );
    assert.equal(override?.status, 400);
  } finally {
    db.db.close();
  }
});

test("MCP discovery and invocation require explicit controlled-egress enablement and remain tenant scoped", async () => {
  const db = await migratedDb();
  try {
    const owner = await provision(db, "mcp-egress-owner");
    const other = await provision(db, "mcp-egress-other");
    await enableMcp(db, owner.tenantId, other.tenantId);
    const created = await call(
      db,
      request(owner.token, "POST", COLLECTION, {
        name: "Private tools",
        transport: "streamable_http",
        endpoint: "https://mcp.example.com/rpc",
        credential: "tenant-server-secret",
      })
    );
    const server = await body<{ server: { id: string } }>(created!);
    const serverPath = `${COLLECTION}/${server.server.id}`;
    let proxyCalls = 0;
    const egressBinding = {
      async fetch(proxyRequest: Request): Promise<Response> {
        proxyCalls += 1;
        assert.equal(proxyRequest.url, "http://omniroute-mcp-egress.internal:8080/v1/mcp/forward");
        const proxyBody = (await proxyRequest.json()) as {
          tenantId: string;
          serverId: string;
          body: string;
          headers?: { upstreamAuthorization?: string };
        };
        assert.equal(proxyBody.tenantId, owner.tenantId);
        assert.equal(proxyBody.serverId, server.server.id);
        assert.equal(proxyBody.headers?.upstreamAuthorization, "Bearer tenant-server-secret");
        const rpc = JSON.parse(proxyBody.body) as { method: string; id?: number };
        const result =
          rpc.method === "initialize"
            ? { protocolVersion: "2024-11-05", serverInfo: { name: "fixture" } }
            : rpc.method === "tools/list"
              ? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: "ok" }] };
        return Response.json({
          status: 200,
          headers: { contentType: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
        });
      },
    };

    const disabled = await call(db, request(owner.token, "GET", `${serverPath}/tools`), {
      egressBinding,
      egressProxyToken: "proxy-token-" + "x".repeat(32),
    });
    assert.equal(disabled?.status, 503);
    assert.equal(proxyCalls, 0);

    const discovered = await call(db, request(owner.token, "GET", `${serverPath}/tools`), {
      egressEnabled: true,
      egressBinding,
      egressProxyToken: "proxy-token-" + "x".repeat(32),
    });
    assert.equal(discovered?.status, 200, await discovered?.clone().text());
    assert.equal(proxyCalls, 3);
    assert.doesNotMatch(await discovered!.text(), /tenant-server-secret/);

    const invoked = await call(
      db,
      request(owner.token, "POST", `${serverPath}/tools/lookup`, { arguments: {} }),
      {
        egressEnabled: true,
        egressBinding,
        egressProxyToken: "proxy-token-" + "x".repeat(32),
      }
    );
    assert.equal(invoked?.status, 200);
    assert.equal(proxyCalls, 7);
    assert.match(await invoked!.text(), /"text":"ok"/);

    const invokedByOtherTenant = await call(
      db,
      request(other.token, "POST", `${serverPath}/tools/lookup`, { arguments: {} }),
      {
        egressEnabled: true,
        egressBinding,
        egressProxyToken: "proxy-token-" + "x".repeat(32),
      }
    );
    assert.equal(invokedByOtherTenant?.status, 404);
    assert.equal(proxyCalls, 7);
  } finally {
    db.db.close();
  }
});

test("Worker MCP egress adapter authenticates against the real proxy handler with tenant context", async () => {
  const db = await migratedDb();
  const proxyToken = "test-proxy-token-which-is-long-enough-32-chars";
  try {
    const owner = await provision(db, "mcp-cross-layer-owner");
    const other = await provision(db, "mcp-cross-layer-other");
    await enableMcp(db, owner.tenantId, other.tenantId);
    const created = await call(
      db,
      request(owner.token, "POST", COLLECTION, {
        name: "Cross layer server",
        transport: "streamable_http",
        endpoint: "https://mcp.example.com/mcp",
        credential: "cross-layer-upstream-secret",
      })
    );
    assert.equal(created?.status, 201);
    const server = await body<{ server: { id: string } }>(created!);

    const forwarded: Array<{
      context: { tenantId: string; serverId: string };
      authorization: string | null;
      method: string;
    }> = [];
    const proxyHandler = createMcpEgressProxyHandler({
      proxyToken,
      transport: {
        async fetch(_url, init, context) {
          assert.ok(context, "the proxy must supply its validated tenant and server context");
          const rpc = JSON.parse(String(init.body)) as { id?: number; method: string };
          forwarded.push({
            context,
            authorization: new Headers(init.headers).get("authorization"),
            method: rpc.method,
          });
          const result =
            rpc.method === "initialize"
              ? { protocolVersion: "2024-11-05", serverInfo: { name: "real-proxy" } }
              : rpc.method === "tools/list"
                ? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
                : { content: [{ type: "text", text: "cross-layer-ok" }] };
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
        },
      },
    });
    let signedProxyRequests = 0;
    const egressBinding = {
      async fetch(proxyRequest: Request): Promise<Response> {
        signedProxyRequests += 1;
        assert.equal(proxyRequest.url, "http://omniroute-mcp-egress.internal:8080/v1/mcp/forward");
        const response = await proxyHandler(proxyRequest);
        assert.equal(response.status, 200, "the real handler must accept the Worker HMAC");
        return response;
      },
    };

    const noEnablement = await call(
      db,
      request(owner.token, "GET", `${COLLECTION}/${server.server.id}/tools`),
      { egressBinding, egressProxyToken: proxyToken }
    );
    assert.equal(noEnablement?.status, 503);
    const noBinding = await call(
      db,
      request(owner.token, "GET", `${COLLECTION}/${server.server.id}/tools`),
      { egressEnabled: true, egressProxyToken: proxyToken }
    );
    assert.equal(noBinding?.status, 503);
    const noSigningToken = await call(
      db,
      request(owner.token, "GET", `${COLLECTION}/${server.server.id}/tools`),
      { egressEnabled: true, egressBinding }
    );
    assert.equal(noSigningToken?.status, 503);
    assert.equal(signedProxyRequests, 0, "disabled configuration must not reach proxy egress");

    const discovered = await call(
      db,
      request(owner.token, "GET", `${COLLECTION}/${server.server.id}/tools`),
      { egressEnabled: true, egressBinding, egressProxyToken: proxyToken }
    );
    assert.equal(discovered?.status, 200, await discovered?.clone().text());
    assert.equal(signedProxyRequests, 3, "discovery sends initialize and tools/list calls");
    assert.deepEqual(
      forwarded.map((item) => item.context),
      Array.from({ length: 3 }, () => ({ tenantId: owner.tenantId, serverId: server.server.id }))
    );
    assert.ok(
      forwarded.every((item) => item.authorization === "Bearer cross-layer-upstream-secret")
    );

    const invocation = await call(
      db,
      request(owner.token, "POST", `${COLLECTION}/${server.server.id}/tools/lookup`, {
        arguments: {},
      }),
      { egressEnabled: true, egressBinding, egressProxyToken: proxyToken }
    );
    assert.equal(invocation?.status, 200, await invocation?.clone().text());
    assert.match(await invocation!.text(), /cross-layer-ok/);
    assert.equal(signedProxyRequests, 7);
    assert.ok(forwarded.slice(3).every((item) => item.context.tenantId === owner.tenantId));
    assert.ok(forwarded.slice(3).every((item) => item.context.serverId === server.server.id));
    assert.ok(
      forwarded
        .slice(3)
        .every((item) => item.authorization === "Bearer cross-layer-upstream-secret")
    );

    const foreignTenant = await call(
      db,
      request(other.token, "GET", `${COLLECTION}/${server.server.id}/tools`),
      { egressEnabled: true, egressBinding, egressProxyToken: proxyToken }
    );
    assert.equal(foreignTenant?.status, 404);
    assert.equal(signedProxyRequests, 7, "foreign tenant access must be rejected before egress");
  } finally {
    db.db.close();
  }
});

test("MCP endpoint schemas reject unsafe or ambiguous URLs without probing them", async () => {
  const db = await migratedDb();
  try {
    const owner = await provision(db, "mcp-endpoint-a");
    await enableMcp(db, owner.tenantId);
    const unsupportedTransport = await call(
      db,
      request(owner.token, "POST", COLLECTION, {
        name: "Legacy SSE",
        transport: "sse",
        endpoint: "https://mcp.example.test/events",
      })
    );
    assert.equal(unsupportedTransport?.status, 400);

    for (const endpoint of [
      "http://mcp.example.test/mcp",
      "https://user:pass@mcp.example.test/mcp",
      "https://mcp.example.test/mcp?token=secret",
      "https://mcp.example.test/mcp#fragment",
      "https://mcp.example.test:8443/mcp",
    ]) {
      const response = await call(
        db,
        request(owner.token, "POST", COLLECTION, {
          name: "Bad",
          transport: "streamable_http",
          endpoint,
        })
      );
      assert.equal(response?.status, 400, endpoint);
    }

    const legacyDisabledEndpoint = "https://legacy.example.test:8443/mcp";
    const insertLegacy = db.prepare(
      `INSERT INTO cloud_tenant_mcp_servers
         (id, tenant_id, name, transport, endpoint, credential_encrypted, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`
    );
    await insertLegacy
      .bind(
        "legacy-disabled-sse",
        owner.tenantId,
        "Legacy SSE",
        "sse",
        "https://legacy.example.test/mcp",
        NOW,
        NOW
      )
      .run();
    await insertLegacy
      .bind(
        "legacy-disabled-port",
        owner.tenantId,
        "Legacy port",
        "streamable_http",
        legacyDisabledEndpoint,
        NOW,
        NOW
      )
      .run();
    const listed = await call(db, request(owner.token, "GET", COLLECTION));
    const listedBody = await body<{
      servers: Array<{ id: string; transport: string; endpoint: string; isActive: boolean }>;
    }>(listed!);
    assert.deepEqual(
      listedBody.servers.find((server) => server.id === "legacy-disabled-sse"),
      {
        id: "legacy-disabled-sse",
        tenantId: owner.tenantId,
        name: "Legacy SSE",
        transport: "sse",
        endpoint: "https://legacy.example.test/mcp",
        isActive: false,
        hasCredential: false,
        createdAt: NOW,
        updatedAt: NOW,
      }
    );
    assert.equal(
      listedBody.servers.find((server) => server.id === "legacy-disabled-port")?.endpoint,
      legacyDisabledEndpoint
    );

    const deactivateLegacy = await call(
      db,
      request(owner.token, "PUT", `${COLLECTION}/legacy-disabled-sse`, { isActive: false })
    );
    assert.equal(deactivateLegacy?.status, 200, "legacy rows remain editable while disabled");
    const activateSseWithoutMigration = await call(
      db,
      request(owner.token, "PUT", `${COLLECTION}/legacy-disabled-sse`, { isActive: true })
    );
    assert.equal(activateSseWithoutMigration?.status, 400);
    const activateSseWithMigration = await call(
      db,
      request(owner.token, "PUT", `${COLLECTION}/legacy-disabled-sse`, {
        transport: "streamable_http",
        endpoint: "https://legacy.example.test/mcp",
        isActive: true,
      })
    );
    assert.equal(activateSseWithMigration?.status, 200);

    const activatePortWithoutMigration = await call(
      db,
      request(owner.token, "PUT", `${COLLECTION}/legacy-disabled-port`, {
        endpoint: "https://legacy.example.test/mcp",
        isActive: true,
      })
    );
    assert.equal(activatePortWithoutMigration?.status, 400);
    const activatePortWithMigration = await call(
      db,
      request(owner.token, "PUT", `${COLLECTION}/legacy-disabled-port`, {
        transport: "streamable_http",
        endpoint: "https://legacy.example.test/mcp",
        isActive: true,
      })
    );
    assert.equal(activatePortWithMigration?.status, 200);
    const deleteMigratedLegacy = await call(
      db,
      request(owner.token, "DELETE", `${COLLECTION}/legacy-disabled-port`)
    );
    assert.equal(deleteMigratedLegacy?.status, 200, "legacy rows remain deletable");
    const count = await db
      .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM cloud_tenant_mcp_servers")
      .first();
    assert.equal(count?.count, 1, "legacy rows remain available for owner cleanup");
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
        transport: "streamable_http",
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
