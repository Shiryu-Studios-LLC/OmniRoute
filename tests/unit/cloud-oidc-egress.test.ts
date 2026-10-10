import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { McpOutboundTransport } from "../../src/lib/mcp/mcpOutboundTransport.ts";
import { createCloudOidcEgressTransport } from "../../src/cloud/oidcEgressTransport.ts";
import {
  createOidcEgressProxyHandler,
  OIDC_PROXY_PATH,
} from "../../cloudflare/mcp-egress-proxy/oidcHandler.ts";
import { createMcpEgressSignature } from "../../cloudflare/mcp-egress-proxy/handler.ts";

const TOKEN = "proxy-secret-for-tests-with-at-least-thirty-two-characters";
const ISSUER = "https://login.customer-idp.com/tenant";
let nonceSequence = 0;

function signedRequest(payload: unknown): Request {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `${randomBytes(16).toString("base64url")}${++nonceSequence}`;
  return new Request(`http://proxy.internal${OIDC_PROXY_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omniroute-timestamp": timestamp,
      "x-omniroute-nonce": nonce,
      "x-omniroute-signature": createMcpEgressSignature(rawBody, timestamp, nonce, TOKEN),
    },
    body: rawBody,
  });
}

test("OIDC proxy accepts issuer-bound discovery, token, and JWKS with manual redirects", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown; redirect?: RequestRedirect }> =
    [];
  const transport: McpOutboundTransport = {
    async fetch(url, init) {
      calls.push({ url, method: init.method, body: init.body, redirect: init.redirect });
      return new Response('{"issuer":"ok"}', { headers: { "content-type": "application/json" } });
    },
  };
  const handler = createOidcEgressProxyHandler({ proxyToken: TOKEN, transport });
  const discovery = await handler(
    signedRequest({
      issuer: ISSUER,
      operation: "discovery",
      url: `${ISSUER}/.well-known/openid-configuration`,
      method: "GET",
    })
  );
  assert.equal(discovery.status, 200);
  assert.deepEqual(await discovery.json(), {
    status: 200,
    contentType: "application/json",
    body: '{"issuer":"ok"}',
  });
  const tokenBody = "grant_type=authorization_code&client_secret=secret-value";
  const token = await handler(
    signedRequest({
      issuer: ISSUER,
      operation: "token",
      url: "https://login.customer-idp.com/oauth/token",
      method: "POST",
      body: tokenBody,
    })
  );
  assert.equal(token.status, 200);
  const jwks = await handler(
    signedRequest({
      issuer: ISSUER,
      operation: "jwks",
      url: "https://login.customer-idp.com/oauth/keys",
      method: "GET",
    })
  );
  assert.equal(jwks.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.redirect, "manual");
  assert.equal(calls[1]?.method, "POST");
  assert.equal(calls[1]?.body, tokenBody);
});

test("OIDC proxy rejects cross-origin and malformed path requests before outbound fetch", async () => {
  let calls = 0;
  const handler = createOidcEgressProxyHandler({
    proxyToken: TOKEN,
    transport: {
      async fetch() {
        calls += 1;
        return new Response("{}");
      },
    },
  });
  const cases = [
    {
      issuer: ISSUER,
      operation: "discovery",
      url: "https://other.example.com/.well-known/openid-configuration",
      method: "GET",
    },
    { issuer: ISSUER, operation: "discovery", url: `${ISSUER}/oauth/token`, method: "GET" },
    { issuer: ISSUER, operation: "jwks", url: `${ISSUER}/keys%2f..%2fprivate`, method: "GET" },
    {
      issuer: ISSUER,
      operation: "jwks",
      url: "https://login.customer-idp.com:8443/keys",
      method: "GET",
    },
  ];
  for (const payload of cases) {
    const response = await handler(signedRequest(payload));
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test("OIDC proxy bounds upstream time and response size", async () => {
  const hanging = createOidcEgressProxyHandler({
    proxyToken: TOKEN,
    timeoutMs: 15,
    transport: { fetch: () => new Promise<Response>(() => undefined) },
  });
  const timedOut = await hanging(
    signedRequest({
      issuer: ISSUER,
      operation: "jwks",
      url: `${ISSUER}/jwks`,
      method: "GET",
    })
  );
  assert.equal(timedOut.status, 504);
  assert.deepEqual(await timedOut.json(), { error: "upstream_timeout" });

  const oversized = createOidcEgressProxyHandler({
    proxyToken: TOKEN,
    transport: {
      async fetch() {
        return new Response("x".repeat(64 * 1024 + 1));
      },
    },
  });
  const rejected = await oversized(
    signedRequest({
      issuer: ISSUER,
      operation: "jwks",
      url: `${ISSUER}/jwks`,
      method: "GET",
    })
  );
  assert.equal(rejected.status, 502);
  assert.deepEqual(await rejected.json(), { error: "upstream_too_large" });
});

test("Worker OIDC transport uses the fixed private binding and refuses issuer-origin changes", async () => {
  let calledUrl = "";
  let proxyRedirect: RequestRedirect | undefined;
  const binding = {
    async fetch(request: Request) {
      calledUrl = request.url;
      proxyRedirect = request.redirect;
      const body = JSON.parse(await request.text()) as { url: string };
      assert.equal(body.url, `${ISSUER}/.well-known/openid-configuration`);
      return new Response(
        JSON.stringify({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
        { headers: { "content-type": "application/json" } }
      );
    },
  };
  const transport = createCloudOidcEgressTransport({ binding, proxyToken: TOKEN });
  assert.ok(transport);
  const response = await transport.fetch(
    ISSUER,
    "discovery",
    new URL(`${ISSUER}/.well-known/openid-configuration`),
    { method: "GET", redirect: "manual" }
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(calledUrl, "http://omniroute-mcp-egress.internal:8080/v1/oidc/fetch");
  assert.equal(proxyRedirect, "manual");
  await assert.rejects(
    transport.fetch(ISSUER, "jwks", new URL("https://attacker.example/keys"), {
      method: "GET",
      redirect: "manual",
    }),
    /issuer origin/
  );
  assert.equal(createCloudOidcEgressTransport({ proxyToken: TOKEN }), null);
});

test("Worker OIDC transport does not follow redirects from the private proxy", async () => {
  let calls = 0;
  let proxyRedirect: RequestRedirect | undefined;
  const transport = createCloudOidcEgressTransport({
    proxyToken: TOKEN,
    binding: {
      async fetch(request) {
        calls += 1;
        proxyRedirect = request.redirect;
        return new Response(null, {
          status: 307,
          headers: { Location: "https://attacker.example/collect" },
        });
      },
    },
  });
  assert.ok(transport);

  await assert.rejects(
    transport.fetch(ISSUER, "token", new URL(`${ISSUER}/oauth/token`), {
      method: "POST",
      body: "grant_type=authorization_code&client_secret=sensitive-value",
      redirect: "manual",
    }),
    /proxy rejected the request/
  );
  assert.equal(proxyRedirect, "manual");
  assert.equal(calls, 1);
});

test("Worker signed envelope authenticates through the Node proxy handler", async () => {
  const proxy = createOidcEgressProxyHandler({
    proxyToken: TOKEN,
    transport: {
      async fetch() {
        return Response.json({ issuer: ISSUER });
      },
    },
  });
  const transport = createCloudOidcEgressTransport({
    binding: { fetch: (request) => proxy(request) },
    proxyToken: TOKEN,
  });
  assert.ok(transport);
  const response = await transport.fetch(
    ISSUER,
    "discovery",
    new URL(`${ISSUER}/.well-known/openid-configuration`),
    { method: "GET", redirect: "manual" }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { issuer: ISSUER });
});
