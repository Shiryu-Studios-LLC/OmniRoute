import test from "node:test";
import assert from "node:assert/strict";
import {
  createTenantRemoteMcpRuntime,
  TenantRemoteMcpError,
  type RegisteredRemoteMcpServer,
  type RemoteMcpPrincipal,
} from "../../src/lib/mcp/tenantRemoteMcpRuntime.ts";

const serverA: RegisteredRemoteMcpServer = {
  id: "server-a",
  tenantId: "tenant-a",
  name: "Tenant A tools",
  transport: "streamable_http",
  endpoint: "https://mcp-a.example.com/mcp",
  isActive: true,
};

const serverB: RegisteredRemoteMcpServer = {
  ...serverA,
  id: "server-b",
  tenantId: "tenant-b",
  name: "Tenant B tools",
  endpoint: "https://mcp-b.example.com/mcp",
};

function principal(subject: string): RemoteMcpPrincipal {
  return { subject };
}

function runtime(overrides: Partial<Parameters<typeof createTenantRemoteMcpRuntime>[0]> = {}) {
  const servers = [serverA, serverB];
  const base = {
    authorization: {
      resolveTenant: async (user: RemoteMcpPrincipal) =>
        user.subject === "a" ? "tenant-a" : user.subject === "b" ? "tenant-b" : null,
      canAccessServer: async (_user: RemoteMcpPrincipal, tenantId: string, id: string) =>
        servers.some((server) => server.id === id && server.tenantId === tenantId),
    },
    registry: {
      listByTenant: async (tenantId: string) =>
        servers.filter((server) => server.tenantId === tenantId),
      getById: async (tenantId: string, id: string) =>
        servers.find((server) => server.tenantId === tenantId && server.id === id) ?? null,
    },
    transport: {
      fetch: async () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
    },
  };
  return createTenantRemoteMcpRuntime({ ...base, ...overrides });
}

async function assertRuntimeError(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TenantRemoteMcpError);
    assert.equal(error.code, code);
    return true;
  });
}

test("tenant discovery returns only active registered servers for the authenticated tenant", async () => {
  const runtimeInstance = runtime();
  assert.deepEqual(await runtimeInstance.discoverForTenant(principal("a")), [serverA]);
  assert.deepEqual(await runtimeInstance.discoverForTenant(principal("b")), [serverB]);
  await assertRuntimeError(
    runtimeInstance.discoverForTenant(principal("anonymous")),
    "UNAUTHENTICATED"
  );
});

test("remote tool discovery is tenant-authorized and never sends stored credentials", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let dnsChecks = 0;
  const runtimeInstance = runtime({
    transport: {
      fetch: async (input, init = {}) => {
        dnsChecks += 1;
        const url = String(input);
        requests.push({ url, init });
        const request = JSON.parse(String(init.body)) as { id?: number; method?: string };
        if (request.method === "initialize") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                protocolVersion: "2024-11-05",
                serverInfo: { name: "Example MCP", version: "1.2" },
                capabilities: { tools: {} },
              },
            },
            { headers: { "Mcp-Session-Id": "session-123" } }
          );
        }
        if (request.method === "notifications/initialized")
          return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            tools: [
              {
                name: "lookup",
                description: "Lookup a record",
                inputSchema: { type: "object", properties: { id: { type: "string" } } },
              },
            ],
          },
        });
      },
    },
  });

  const discovered = await runtimeInstance.discoverTools(principal("a"), serverA.id);
  assert.equal(discovered.serverId, serverA.id);
  assert.equal(discovered.serverInfo?.name, "Example MCP");
  assert.equal(discovered.tools[0]?.name, "lookup");
  assert.equal(requests.length, 3);
  assert.equal(dnsChecks, 3);
  for (const [index, { init }] of requests.entries()) {
    const headers = new Headers(init.headers);
    assert.equal(headers.has("Authorization"), false);
    assert.equal(headers.get("Mcp-Session-Id"), index === 0 ? null : "session-123");
    assert.equal(init.redirect, "manual");
  }

  await assertRuntimeError(
    runtimeInstance.discoverTools(principal("a"), serverB.id),
    "TENANT_FORBIDDEN"
  );
});

test("cloud discovery refuses stdio and unsafe endpoint URLs", async () => {
  const sseRuntime = runtime({
    registry: {
      listByTenant: async () => [],
      getById: async () => ({ ...serverA, transport: "sse" }),
    },
  });
  await assertRuntimeError(
    sseRuntime.discoverTools(principal("a"), serverA.id),
    "MCP_TRANSPORT_UNSUPPORTED"
  );

  for (const endpoint of [
    "http://mcp.example.com/mcp",
    "https://127.0.0.1/mcp",
    "https://10.2.3.4/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/mcp",
    "https://[2001:db8::1]/mcp",
    "https://mcp.example.com:8443/mcp",
    "https://user:password@mcp.example.com/mcp",
  ]) {
    const unsafeRuntime = runtime({
      registry: {
        listByTenant: async () => [],
        getById: async () => ({ ...serverA, endpoint }),
      },
    });
    await assertRuntimeError(
      unsafeRuntime.discoverTools(principal("a"), serverA.id),
      "MCP_OUTBOUND_TARGET_REJECTED"
    );
  }
});

test("redirects are not followed and response size is bounded", async () => {
  let redirectFetches = 0;
  const redirectRuntime = runtime({
    transport: {
      fetch: async () => {
        redirectFetches += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/mcp" },
        });
      },
    },
  });
  await assertRuntimeError(
    redirectRuntime.discoverTools(principal("a"), serverA.id),
    "MCP_UPSTREAM_REDIRECT_REJECTED"
  );
  assert.equal(redirectFetches, 1);

  const largeBody = "x".repeat(1_100);
  const oversizedRuntime = runtime({
    maxResponseBytes: 1_024,
    transport: {
      fetch: async () =>
        new Response(largeBody, { headers: { "Content-Type": "application/json" } }),
    },
  });
  await assertRuntimeError(
    oversizedRuntime.discoverTools(principal("a"), serverA.id),
    "MCP_UPSTREAM_RESPONSE_TOO_LARGE"
  );
});

test("upstream timeouts are bounded and invocation stays disabled without secure credentials", async () => {
  const timedOutRuntime = runtime({
    timeoutMs: 100,
    transport: {
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    },
  });
  await assertRuntimeError(
    timedOutRuntime.discoverTools(principal("a"), serverA.id),
    "MCP_UPSTREAM_TIMEOUT"
  );
  await assertRuntimeError(
    runtime().invokeTool(principal("a"), serverA.id, "lookup", {}),
    "MCP_INVOCATION_DISABLED"
  );
  await assertRuntimeError(
    runtime().invokeTool(principal("a"), serverB.id, "lookup", {}),
    "TENANT_FORBIDDEN"
  );
});
