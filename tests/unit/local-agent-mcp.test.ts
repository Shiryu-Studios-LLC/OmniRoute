import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  discoverLocalMcpServers,
  invokeLocalMcpTool,
  localMcpCapability,
  parseLocalMcpCapability,
  validateLocalMcpServers,
} from "../../src/lib/localAgent/localMcp";
import { executeLocalCapability } from "../../src/lib/localAgent/capabilityExecutor";
import { createNodePinnedMcpTransport } from "../../src/lib/mcp/nodePinnedMcpTransport";

function transport(handler: (request: Record<string, unknown>) => Response) {
  const requests: Record<string, unknown>[] = [];
  const headers: Headers[] = [];
  return {
    requests,
    value: {
      async fetch(input: string, init: RequestInit) {
        assert.equal(input, "http://127.0.0.1:9911/mcp");
        assert.equal(init.redirect, "manual");
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push(body);
        headers.push(new Headers(init.headers));
        return handler(body);
      },
    },
    headers,
  };
}

test("Local Agent MCP config accepts only loopback HTTP(S) or public HTTPS-shaped endpoints", () => {
  assert.deepEqual(
    validateLocalMcpServers([
      { id: "local", endpoint: "http://127.0.0.1:9911/mcp" },
      { id: "public", endpoint: "https://mcp.example.com/mcp" },
    ]),
    [
      { id: "local", endpoint: "http://127.0.0.1:9911/mcp" },
      { id: "public", endpoint: "https://mcp.example.com/mcp" },
    ]
  );
  for (const endpoint of [
    "http://192.168.1.5:9911/mcp",
    "http://mcp.internal/mcp",
    "http://127.0.0.2:9911/mcp",
    "https://mcp.example.com:8443/mcp",
    "https://user:password@mcp.example.com/mcp",
    "https://mcp.example.com/mcp?token=secret",
  ]) {
    assert.throws(() => validateLocalMcpServers([{ id: "server", endpoint }]));
  }
  assert.throws(() =>
    validateLocalMcpServers([
      { id: "same", endpoint: "http://127.0.0.1:9911/mcp" },
      { id: "same", endpoint: "http://127.0.0.1:9912/mcp" },
    ])
  );
});

test("discovery advertises bounded, syntactically safe tool names", async () => {
  const fake = transport((request) => {
    if (request.method === "initialize") {
      return Response.json(
        { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05" } },
        { headers: { "mcp-session-id": "session-1" } }
      );
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(request.method, "tools/list");
    assert.equal(request.params && typeof request.params, "object");
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          { name: "read_file", inputSchema: { type: "object" } },
          { name: "unsafe tool name" },
          ...Array.from({ length: 12 }, (_, index) => ({ name: `tool_${index}` })),
        ],
      },
    });
  });
  const discovered = await discoverLocalMcpServers(
    [{ id: "docs", endpoint: "http://127.0.0.1:9911/mcp" }],
    { transport: fake.value }
  );
  assert.equal(discovered.length, 1);
  assert.deepEqual(
    discovered[0].tools.map((tool) => tool.name),
    ["read_file", "tool_0", "tool_1", "tool_2", "tool_3", "tool_4", "tool_5"]
  );
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ["initialize", "notifications/initialized", "tools/list"]
  );
  assert.equal(fake.headers[2].get("mcp-protocol-version"), "2024-11-05");
  assert.equal(fake.headers[2].get("mcp-session-id"), "session-1");
  assert.equal(localMcpCapability("docs", "read_file"), "mcp:docs:read_file");
  assert.deepEqual(parseLocalMcpCapability("mcp:docs:read_file"), {
    serverId: "docs",
    toolName: "read_file",
  });
  assert.equal(parseLocalMcpCapability("mcp:docs:../read_file"), null);
});

test("dispatch requires an advertised server/tool pair and sends only bounded arguments", async () => {
  const fake = transport((request) => {
    if (request.method === "initialize") {
      return Response.json(
        { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25" } },
        { headers: { "mcp-session-id": "session-2" } }
      );
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(request.method, "tools/call");
    assert.deepEqual(request.params, { name: "read_file", arguments: { path: "README.md" } });
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  });
  const server = {
    id: "docs",
    endpoint: "http://127.0.0.1:9911/mcp",
    tools: [{ name: "read_file" }],
  };
  await assert.rejects(() =>
    invokeLocalMcpTool(server, "delete_file", {}, { transport: fake.value })
  );
  await assert.rejects(() =>
    invokeLocalMcpTool(server, "read_file", "not-an-object", { transport: fake.value })
  );
  const result = await invokeLocalMcpTool(
    server,
    "read_file",
    { path: "README.md" },
    { transport: fake.value }
  );
  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ["initialize", "notifications/initialized", "tools/call"]
  );
  assert.equal(fake.headers[2].get("mcp-protocol-version"), "2025-11-25");
  await assert.rejects(
    () =>
      invokeLocalMcpTool(
        server,
        "read_file",
        { path: "x".repeat(70_000) },
        { transport: fake.value }
      ),
    /size limit/
  );
});

test("Local Agent executor dispatches only a configured server and advertised tool capability", async () => {
  const fake = transport((request) => {
    if (request.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: "2025-11-25" },
      });
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(request.method, "tools/call");
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "done" }] },
    });
  });
  const mcpServer = {
    id: "docs",
    endpoint: "http://127.0.0.1:9911/mcp",
    tools: [{ name: "read_file" }],
  };
  const discovery = {
    heartbeat: { status: "online" as const, capabilities: ["mcp:docs:read_file"] },
    services: [],
    mcpServers: [mcpServer],
  };
  const common = {
    fetch: globalThis.fetch,
    mcp: { transport: fake.value },
  };
  const output = await executeLocalCapability(
    { mcpServers: [{ id: "docs", endpoint: "http://127.0.0.1:9911/mcp" }] },
    discovery,
    { capability: "mcp:docs:read_file", payload: { path: "README.md" } },
    common
  );
  assert.deepEqual(output, { content: [{ type: "text", text: "done" }] });
  await assert.rejects(() =>
    executeLocalCapability(
      { mcpServers: [{ id: "other", endpoint: "http://127.0.0.1:9911/mcp" }] },
      discovery,
      { capability: "mcp:docs:read_file", payload: { path: "README.md" } },
      common
    )
  );
});

test("discovery parses SSE response events and selects the matching JSON-RPC id", async () => {
  const fake = transport((request) => {
    if (request.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: "2025-11-25" },
      });
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(
      [
        "event: message",
        'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
        "",
        "event: message",
        `data: {"jsonrpc":"2.0","id":${request.id},"result":{"tools":[{"name":"sse_tool"}]}}`,
        "",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" } }
    );
  });
  const discovered = await discoverLocalMcpServers(
    [{ id: "docs", endpoint: "http://127.0.0.1:9911/mcp" }],
    { transport: fake.value }
  );
  assert.deepEqual(
    discovered[0].tools.map((tool) => tool.name),
    ["sse_tool"]
  );
});

test("Node MCP transport pins localhost to loopback and rejects DNS rebinding", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const allowed = createNodePinnedMcpTransport({
      allowLoopback: true,
      lookupAll: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const response = await allowed.fetch(`http://localhost:${address.port}/mcp`, {
      method: "POST",
      body: "{}",
    });
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  const rebinding = createNodePinnedMcpTransport({
    allowLoopback: true,
    lookupAll: async () => [
      { address: "127.0.0.1", family: 4 },
      { address: "192.168.1.5", family: 4 },
    ],
  });
  await assert.rejects(
    () => rebinding.fetch("http://localhost:9911/mcp", { method: "POST", body: "{}" }),
    /DNS policy rejected/
  );
});
