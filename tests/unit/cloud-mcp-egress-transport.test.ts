import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createCloudMcpEgressTransport } from "../../src/cloud/mcpEgressTransport";
import { McpOutboundEgressError } from "../../src/lib/mcp/mcpOutboundTransport";

const TOKEN = "proxy-token-" + "x".repeat(32);
const CONTEXT = { tenantId: "tenant_a", serverId: "server_a" };

test("Worker MCP transport calls only the fixed VPC proxy and maps bounded response envelopes", async () => {
  const seen: Request[] = [];
  const transport = createCloudMcpEgressTransport({
    proxyToken: TOKEN,
    binding: {
      async fetch(request) {
        seen.push(request);
        return Response.json({
          status: 200,
          headers: { contentType: "application/json", mcpSessionId: "session-safe" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
        });
      },
    },
  });
  assert.ok(transport);
  const result = await transport.fetch(
    "https://mcp.customer.example/mcp",
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer tenant-mcp-secret",
        "Content-Type": "application/json",
        "Mcp-Session-Id": "session-request",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
    CONTEXT
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "http://omniroute-mcp-egress.internal:8080/v1/mcp/forward");
  assert.equal(seen[0]?.redirect, "manual");
  assert.match(seen[0]?.headers.get("x-omniroute-timestamp") ?? "", /^\d+$/);
  assert.match(seen[0]?.headers.get("x-omniroute-nonce") ?? "", /^[\w-]{16,}$/);
  assert.match(seen[0]?.headers.get("x-omniroute-signature") ?? "", /^[a-f0-9]{64}$/);
  const payload = (await seen[0]!.json()) as {
    tenantId: string;
    serverId: string;
    url: string;
    headers: {
      upstreamAuthorization?: string;
      mcpSessionId?: string;
      mcpProtocolVersion?: string;
    };
  };
  const signedBody = JSON.stringify(payload);
  assert.equal(
    seen[0]!.headers.get("x-omniroute-signature"),
    createHmac("sha256", TOKEN)
      .update(
        `${seen[0]!.headers.get("x-omniroute-timestamp")}\n${seen[0]!.headers.get("x-omniroute-nonce")}\n${signedBody}`
      )
      .digest("hex")
  );
  assert.equal(payload.tenantId, CONTEXT.tenantId);
  assert.equal(payload.serverId, CONTEXT.serverId);
  assert.equal(payload.url, "https://mcp.customer.example/mcp");
  assert.equal(payload.headers.upstreamAuthorization, "Bearer tenant-mcp-secret");
  assert.equal(payload.headers.mcpSessionId, "session-request");
  assert.equal(payload.headers.mcpProtocolVersion, "2025-11-25");
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("mcp-session-id"), "session-safe");
  assert.deepEqual(await result.json(), { jsonrpc: "2.0", id: 1, result: { tools: [] } });
});

test("Worker MCP transport does not follow redirects from the private proxy", async () => {
  const seen: Request[] = [];
  const transport = createCloudMcpEgressTransport({
    proxyToken: TOKEN,
    binding: {
      async fetch(request) {
        seen.push(request);
        return new Response(null, {
          status: 307,
          headers: { Location: "https://attacker.example/collect" },
        });
      },
    },
  });
  assert.ok(transport);

  await assert.rejects(
    transport.fetch(
      "https://mcp.customer.example/mcp",
      {
        method: "POST",
        headers: { Authorization: "Bearer tenant-mcp-secret" },
        body: JSON.stringify({ method: "tools/call", params: { name: "private_tool" } }),
      },
      CONTEXT
    ),
    McpOutboundEgressError
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.redirect, "manual");
});

test("Worker MCP transport fails closed when the VPC binding or proxy token is absent", () => {
  assert.equal(createCloudMcpEgressTransport({ proxyToken: TOKEN }), null);
  assert.equal(
    createCloudMcpEgressTransport({ binding: { fetch: async () => new Response() } }),
    null
  );
  assert.throws(
    () =>
      createCloudMcpEgressTransport({
        proxyToken: "short",
        binding: { fetch: async () => new Response() },
      }),
    /token is invalid/
  );
});

test("Worker MCP transport rejects unsafe endpoints, methods, and unexpected headers before proxying", async () => {
  let calls = 0;
  const transport = createCloudMcpEgressTransport({
    proxyToken: TOKEN,
    binding: { fetch: async () => (calls++, Response.json({})) },
  });
  assert.ok(transport);
  for (const endpoint of [
    "http://mcp.example.com/mcp",
    "https://127.0.0.1/mcp",
    "https://mcp.example.com:8443/mcp",
  ]) {
    await assert.rejects(
      transport.fetch(endpoint, { method: "POST", body: "{}" }, CONTEXT),
      McpOutboundEgressError
    );
  }
  await assert.rejects(
    transport.fetch(
      "https://mcp.example.com/mcp",
      {
        method: "GET",
        body: "{}",
      },
      CONTEXT
    ),
    McpOutboundEgressError
  );
  await assert.rejects(
    transport.fetch(
      "https://mcp.example.com/mcp",
      {
        method: "POST",
        headers: { "X-Forwarded-Host": "attacker.example" },
        body: "{}",
      },
      CONTEXT
    ),
    McpOutboundEgressError
  );
  assert.equal(calls, 0);
});

test("Worker MCP transport rejects malformed and oversized proxy responses", async () => {
  const transport = createCloudMcpEgressTransport({
    proxyToken: TOKEN,
    binding: {
      fetch: async () => Response.json({ status: 200, headers: {}, body: "x".repeat(2_100_000) }),
    },
  });
  assert.ok(transport);
  await assert.rejects(
    transport.fetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" }, CONTEXT),
    McpOutboundEgressError
  );
});

test("Worker MCP transport preserves valid SSE content type and rejects unsafe response headers", async () => {
  const sseBody = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n';
  const transport = createCloudMcpEgressTransport({
    proxyToken: TOKEN,
    binding: {
      fetch: async () =>
        Response.json({
          status: 200,
          headers: { contentType: "text/event-stream; charset=utf-8" },
          body: sseBody,
        }),
    },
  });
  assert.ok(transport);
  const response = await transport.fetch(
    "https://mcp.example.com/mcp",
    { method: "POST", body: "{}" },
    CONTEXT
  );
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(await response.text(), sseBody);

  const unsafeHeaderTransport = createCloudMcpEgressTransport({
    proxyToken: TOKEN,
    binding: {
      fetch: async () =>
        Response.json({
          status: 200,
          headers: { contentType: "application/json\r\nset-cookie: leaked=yes" },
          body: "{}",
        }),
    },
  });
  assert.ok(unsafeHeaderTransport);
  await assert.rejects(
    unsafeHeaderTransport.fetch(
      "https://mcp.example.com/mcp",
      { method: "POST", body: "{}" },
      CONTEXT
    ),
    McpOutboundEgressError
  );
});

test("Worker MCP transport cancels a proxy response body that stalls past the request deadline", async () => {
  let cancelled = false;
  const transport = createCloudMcpEgressTransport({
    proxyToken: TOKEN,
    timeoutMs: 100,
    binding: {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"status":200,'));
            },
            cancel() {
              cancelled = true;
            },
          })
        ),
    },
  });
  assert.ok(transport);

  await assert.rejects(
    transport.fetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" }, CONTEXT),
    (error: unknown) => error instanceof McpOutboundEgressError && /timed out/.test(error.message)
  );
  assert.equal(cancelled, true, "the response reader is cancelled after the deadline");
});

test("Worker MCP transport propagates caller cancellation to the VPC proxy request", async () => {
  let aborted = false;
  const transport = createCloudMcpEgressTransport({
    proxyToken: TOKEN,
    timeoutMs: 5_000,
    binding: {
      fetch: async (request) =>
        new Promise<Response>((_resolve, reject) => {
          if (request.signal.aborted) {
            aborted = true;
            reject(new Error("aborted"));
            return;
          }
          request.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true }
          );
        }),
    },
  });
  assert.ok(transport);
  const controller = new AbortController();
  const request = transport.fetch(
    "https://mcp.example.com/mcp",
    {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    },
    CONTEXT
  );
  controller.abort();
  await assert.rejects(request, McpOutboundEgressError);
  assert.equal(aborted, true);
});
