import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as createHttpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { TcpNetConnectOpts } from "node:net";
import test from "node:test";
import type { McpOutboundTransport } from "../../src/lib/mcp/mcpOutboundTransport.ts";
import {
  createNodePinnedMcpTransport,
  createPinnedMcpLookup,
  type McpPinnedAddress,
} from "../../src/lib/mcp/nodePinnedMcpTransport.ts";
import {
  createMcpEgressProxyHandler,
  createMcpEgressSignature,
  DEFAULT_PROXY_MAX_IN_FLIGHT,
  MAX_PROXY_PAYLOAD_BYTES,
} from "../../cloudflare/mcp-egress-proxy/handler.ts";
import { startMcpEgressProxyServer } from "../../cloudflare/mcp-egress-proxy/server.ts";

const TOKEN = "proxy-secret-for-tests-with-at-least-thirty-two-characters";
const VALID_URL = "https://mcp.example.com/mcp";
let nonceCounter = 0;

function request(
  body: unknown,
  options: {
    method?: string;
    url?: string;
    timestamp?: string;
    nonce?: string;
    signature?: string;
    rawBody?: string;
  } = {}
): Request {
  const rawBody = options.rawBody ?? JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? `${randomBytes(16).toString("base64url")}${++nonceCounter}`;
  const signature = options.signature ?? createMcpEgressSignature(rawBody, timestamp, nonce, TOKEN);
  return new Request(options.url ?? "http://proxy.test/v1/mcp/forward", {
    method: options.method ?? "POST",
    headers: {
      "x-omniroute-timestamp": timestamp,
      "x-omniroute-nonce": nonce,
      "x-omniroute-signature": signature,
      "content-type": "application/json",
    },
    ...(options.method === "GET" || options.method === "HEAD" ? {} : { body: rawBody }),
  });
}

function envelope(
  body: unknown = {
    tenantId: "tenant_test_01",
    serverId: "server_test_01",
    url: VALID_URL,
    headers: {
      accept: "application/json, text/event-stream",
      contentType: "application/json",
      mcpSessionId: "session-123",
      upstreamAuthorization: "Bearer upstream-secret",
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  }
) {
  return body;
}

test("authenticated forward calls only the pinned transport and returns selected MCP headers", async () => {
  let captured:
    | { url: string; init: RequestInit; context?: { tenantId: string; serverId: string } }
    | undefined;
  const transport: McpOutboundTransport = {
    async fetch(url, init, context) {
      captured = { url, init, context };
      return new Response('{"jsonrpc":"2.0","result":{}}', {
        status: 202,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "mcp-session-id": "session-next",
          "set-cookie": "private=ignored",
        },
      });
    },
  };
  const handler = createMcpEgressProxyHandler({ proxyToken: TOKEN, transport });
  const response = await handler(request(envelope()));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 202,
    headers: {
      contentType: "application/json; charset=utf-8",
      mcpSessionId: "session-next",
    },
    body: '{"jsonrpc":"2.0","result":{}}',
  });
  assert.equal(captured?.url, VALID_URL);
  assert.deepEqual(captured?.context, { tenantId: "tenant_test_01", serverId: "server_test_01" });
  assert.equal(captured?.init.method, "POST");
  assert.equal(captured?.init.redirect, "manual");
  const headers = new Headers(captured?.init.headers);
  assert.equal(headers.get("accept"), "application/json, text/event-stream");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("mcp-session-id"), "session-123");
  assert.equal(headers.get("authorization"), "Bearer upstream-secret");
  assert.equal(headers.has("set-cookie"), false);
});

test("proxy rejects missing, malformed, and incorrect HMAC signatures", async () => {
  let calls = 0;
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    transport: {
      async fetch() {
        calls += 1;
        return new Response("ok");
      },
    },
  });
  const rawBody = JSON.stringify(envelope());
  const invalid = [
    new Request("http://proxy.test/v1/mcp/forward", { method: "POST", body: rawBody }),
    request(envelope(), { signature: "a".repeat(64) }),
    request(envelope(), { signature: "not-a-signature" }),
    request(envelope(), { timestamp: "not-a-time" }),
  ];
  for (const signedRequest of invalid) {
    const response = await handler(signedRequest);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
  assert.equal(calls, 0);
});

test("proxy rejects stale/future timestamps and replayed nonces", async () => {
  let calls = 0;
  const now = Math.floor(Date.now() / 1000);
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    transport: {
      async fetch() {
        calls += 1;
        return new Response("ok");
      },
    },
  });
  for (const timestamp of [String(now - 31), String(now + 31)]) {
    assert.equal((await handler(request(envelope(), { timestamp }))).status, 401);
  }
  const nonce = randomBytes(16).toString("base64url");
  const first = await handler(request(envelope(), { nonce }));
  const replay = await handler(request(envelope(), { nonce }));
  assert.equal(first.status, 200);
  assert.equal(replay.status, 401);
  assert.equal(calls, 1);
});

test("proxy rate-limits the authenticated Worker identity within each window", async () => {
  let calls = 0;
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    transport: {
      async fetch() {
        calls += 1;
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    },
    rateLimit: { limit: 1, windowMs: 60_000 },
    nowSeconds: () => 1_000,
  });
  assert.equal((await handler(request(envelope(), { timestamp: "1000" }))).status, 200);
  assert.equal((await handler(request(envelope(), { timestamp: "1000" }))).status, 429);
  assert.equal(calls, 1);
});

test("only the endpoint and POST method are accepted", async () => {
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    transport: {
      async fetch() {
        return new Response();
      },
    },
  });
  assert.equal(
    (await handler(request({}, { url: "http://proxy.test/v1/mcp/forward/extra" }))).status,
    404
  );
  const methodResponse = await handler(request({}, { method: "GET" }));
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "POST");
});

test("rejects extra JSON fields, unsupported header names, and unsafe header values", async () => {
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    transport: {
      async fetch() {
        throw new Error("unexpected");
      },
    },
  });
  const invalidBodies = [
    { ...(envelope() as object), other: "extra" },
    {
      tenantId: "tenant_test",
      serverId: "server_test",
      url: VALID_URL,
      body: "",
      headers: { cookie: "x=y" },
    },
    {
      tenantId: "tenant_test",
      serverId: "server_test",
      url: VALID_URL,
      body: "",
      headers: { upstreamAuthorization: "Bearer x\r\nX-Evil: y" },
    },
    {
      tenantId: "tenant_test",
      serverId: "server_test",
      url: VALID_URL,
      body: "",
      headers: { accept: 123 },
    },
    { tenantId: "bad/id", serverId: "server_test", url: VALID_URL, body: "" },
  ];
  for (const body of invalidBodies) {
    const response = await handler(request(body));
    assert.equal(response.status, 400);
  }
});

test("rejects invalid JSON and requests over the 2 MiB total input cap", async () => {
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    transport: {
      async fetch() {
        throw new Error("unexpected");
      },
    },
  });
  const invalidJson = request(null, { rawBody: "{" });
  assert.equal((await handler(invalidJson)).status, 400);
  const tooLarge = request({
    tenantId: "tenant_test",
    serverId: "server_test",
    url: VALID_URL,
    body: "x".repeat(MAX_PROXY_PAYLOAD_BYTES),
  });
  assert.equal((await handler(tooLarge)).status, 413);
});

test("caps upstream body and serialized output", async () => {
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    transport: {
      async fetch() {
        return new Response("x".repeat(MAX_PROXY_PAYLOAD_BYTES + 1));
      },
    },
  });
  const response = await handler(
    request({ tenantId: "tenant_test", serverId: "server_test", url: VALID_URL, body: "" })
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "upstream_failure" });
});

test("times out even when an injected transport does not observe abort", async () => {
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    timeoutMs: 10,
    transport: { fetch: async () => new Promise<Response>(() => undefined) },
  });
  const response = await handler(
    request({ tenantId: "tenant_test", serverId: "server_test", url: VALID_URL, body: "" })
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "upstream_timeout" });
});

test("bounds concurrent upstream work and releases the slot after completion", async () => {
  let releaseFirst: ((response: Response) => void) | undefined;
  let startedFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    startedFirst = resolve;
  });
  let calls = 0;
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    maxInFlight: 1,
    transport: {
      async fetch() {
        calls += 1;
        if (calls === 1) {
          startedFirst?.();
          return new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return new Response("ok");
      },
    },
  });

  const first = handler(request(envelope()));
  await firstStarted;
  const busy = await handler(request(envelope()));
  assert.equal(busy.status, 503);
  assert.deepEqual(await busy.json(), { error: "proxy_busy" });
  assert.equal(calls, 1);

  releaseFirst?.(new Response("first"));
  assert.equal((await first).status, 200);
  const afterCompletion = await handler(request(envelope()));
  assert.equal(afterCompletion.status, 200);
  assert.equal(calls, 2);
});

test("releases the concurrency slot after an upstream failure", async () => {
  let calls = 0;
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    maxInFlight: 1,
    transport: {
      async fetch() {
        calls += 1;
        if (calls === 1) throw new Error("upstream failed");
        return new Response("recovered");
      },
    },
  });

  assert.equal((await handler(request(envelope()))).status, 502);
  assert.equal((await handler(request(envelope()))).status, 200);
  assert.equal(calls, 2);
});

test("keeps a timed-out slot occupied until ignored upstream work settles", async () => {
  let releaseFirst: ((response: Response) => void) | undefined;
  let calls = 0;
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    timeoutMs: 10,
    maxInFlight: 1,
    transport: {
      async fetch() {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return new Response("ok");
      },
    },
  });

  assert.equal((await handler(request(envelope()))).status, 504);
  const busy = await handler(request(envelope()));
  assert.equal(busy.status, 503);
  assert.deepEqual(await busy.json(), { error: "proxy_busy" });
  assert.equal(calls, 1);

  releaseFirst?.(new Response("late"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await handler(request(envelope()))).status, 200);
  assert.equal(calls, 2);
});

test("rejects an invalid upstream concurrency limit", () => {
  assert.throws(
    () =>
      createMcpEgressProxyHandler({
        proxyToken: TOKEN,
        maxInFlight: DEFAULT_PROXY_MAX_IN_FLIGHT + 0.5,
        transport: { fetch: async () => new Response() },
      }),
    /in-flight limit is invalid/
  );
});

test("cancels an upstream response stream when the proxy timeout expires", async () => {
  let streamCancelled = false;
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    timeoutMs: 10,
    transport: {
      async fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
            cancel() {
              streamCancelled = true;
            },
          })
        );
      },
    },
  });
  const response = await handler(
    request({ tenantId: "tenant_test", serverId: "server_test", url: VALID_URL, body: "" })
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "upstream_timeout" });
  assert.equal(streamCancelled, true);
});

test("times out and cancels a stalled unauthenticated Web request body", async () => {
  let streamCancelled = false;
  const handler = createMcpEgressProxyHandler({
    proxyToken: TOKEN,
    bodyReadTimeoutMs: 10,
    transport: {
      async fetch() {
        throw new Error("unexpected");
      },
    },
  });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([123]));
      return new Promise<void>(() => undefined);
    },
    cancel() {
      streamCancelled = true;
    },
  });
  const stalledRequest = new Request("http://proxy.test/v1/mcp/forward", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    // Node's Fetch implementation requires half duplex for streaming request bodies.
    duplex: "half",
  } as RequestInit);
  const response = await handler(stalledRequest);
  assert.equal(response.status, 408);
  assert.deepEqual(await response.json(), { error: "request_timeout" });
  assert.equal(streamCancelled, true);
});

test("Node pinned transport rejects non-HTTPS and private literal destinations", async () => {
  let resolverCalls = 0;
  const transport = createNodePinnedMcpTransport({
    lookupAll: async () => {
      resolverCalls += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });
  await assert.rejects(transport.fetch("http://mcp.example.com/mcp", { method: "POST" }));
  await assert.rejects(transport.fetch("https://127.0.0.1/mcp", { method: "POST" }));
  assert.equal(resolverCalls, 0);
});

test("Node pinned transport rejects mixed public/private DNS before transport can connect", async () => {
  let resolverCalls = 0;
  const transport = createNodePinnedMcpTransport({
    lookupAll: async () => {
      resolverCalls += 1;
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ];
    },
  });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("test must not establish a socket"));

  await assert.rejects(
    transport.fetch(VALID_URL, { method: "POST", body: "{}", signal: alreadyAborted.signal }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "MCP_OUTBOUND_DNS_REJECTED"
  );
  assert.equal(resolverCalls, 1);
});

test("Node pinned transport rejects IPv6 ULA and link-local DNS answers", async (context) => {
  for (const address of ["fd00::1", "fe80::1"]) {
    await context.test(address, async () => {
      let resolverCalls = 0;
      const transport = createNodePinnedMcpTransport({
        lookupAll: async () => {
          resolverCalls += 1;
          return [
            { address: "2606:4700:4700::1111", family: 6 },
            { address, family: 6 },
          ];
        },
      });
      const alreadyAborted = new AbortController();
      alreadyAborted.abort(new Error("test must not establish a socket"));

      await assert.rejects(
        transport.fetch(VALID_URL, { method: "POST", body: "{}", signal: alreadyAborted.signal }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "MCP_OUTBOUND_DNS_REJECTED"
      );
      assert.equal(resolverCalls, 1);
    });
  }
});

test("pinned DNS lookup only returns validated addresses across lookup modes", async () => {
  const records: McpPinnedAddress[] = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ];
  const lookup = createPinnedMcpLookup(records);
  type LookupOptions = Parameters<NonNullable<TcpNetConnectOpts["lookup"]>>[1];
  const resolve = (options: LookupOptions): Promise<Array<{ address: string; family: number }>> =>
    new Promise((resolve, reject) => {
      lookup("mcp.example.com", options, (error, address, family) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Array.isArray(address) ? address : [{ address, family: family ?? 0 }]);
      });
    });

  assert.deepEqual(await resolve({}), [records[0]]);
  assert.deepEqual(await resolve({ all: true }), records);
  assert.deepEqual(await resolve({ all: true, family: 4 }), [records[0]]);
  assert.deepEqual(await resolve({ family: 6 }), [records[1]]);
  await assert.rejects(
    resolve({ family: 5 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOTFOUND"
  );
});

test("Node HTTP server exposes the handler and rejects unauthenticated requests", async () => {
  const server = startMcpEgressProxyServer({ proxyToken: TOKEN, host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const healthResponse = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.equal(healthResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await healthResponse.json(), { status: "ok" });
    const invalidHealthMethod = await fetch(`http://127.0.0.1:${address.port}/healthz`, {
      method: "POST",
    });
    assert.equal(invalidHealthMethod.status, 405);
    assert.equal(invalidHealthMethod.headers.get("allow"), "GET");

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/mcp/forward`, {
      method: "POST",
      headers: {
        "x-omniroute-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-omniroute-nonce": randomBytes(16).toString("base64url"),
        "x-omniroute-signature": "0".repeat(64),
        "content-type": "application/json",
      },
      body: JSON.stringify(envelope()),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("Node HTTP server returns 408 and closes a stalled request body", async () => {
  const server = startMcpEgressProxyServer({
    proxyToken: TOKEN,
    host: "127.0.0.1",
    port: 0,
    bodyReadTimeoutMs: 30,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await new Promise<{ statusCode?: number }>((resolve, reject) => {
      const clientRequest = createHttpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/v1/mcp/forward",
          method: "POST",
          headers: {
            "content-length": "128",
            "content-type": "application/json",
            "x-omniroute-timestamp": String(Math.floor(Date.now() / 1000)),
            "x-omniroute-nonce": randomBytes(16).toString("base64url"),
            "x-omniroute-signature": "0".repeat(64),
          },
        },
        (incomingResponse) => {
          incomingResponse.resume();
          incomingResponse.once("end", () => resolve({ statusCode: incomingResponse.statusCode }));
        }
      );
      clientRequest.once("error", reject);
      clientRequest.write("{");
    });
    assert.equal(response.statusCode, 408);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
