import assert from "node:assert/strict";
import test from "node:test";
import { createCloudRuntime } from "../../src/cloud/runtime";
import { CLOUD_CUSTOMER_PORTAL_PATH } from "../../src/cloud/customerPortal";

const ORIGIN = "https://cloud.example.test";

test("Cloud Worker serves the customer portal with nonce CSP and safe DOM rendering", async () => {
  const app = createCloudRuntime({
    env: { OMNIROUTE_CLOUD_PUBLIC_ORIGIN: ORIGIN, OMNIROUTE_ENV: "production" },
  });
  const response = await app.fetch(new Request(`${ORIGIN}${CLOUD_CUSTOMER_PORTAL_PATH}`));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html; charset=utf-8$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

  const html = await response.text();
  const policy = response.headers.get("content-security-policy") ?? "";
  const scriptNonce = html.match(/<script nonce="([a-f0-9]+)">/)?.[1];
  const styleNonce = html.match(/<style nonce="([a-f0-9]+)">/)?.[1];
  assert.ok(scriptNonce);
  assert.equal(styleNonce, scriptNonce);
  assert.ok(policy.includes(`script-src 'nonce-${scriptNonce}'`));
  assert.ok(policy.includes(`style-src 'nonce-${scriptNonce}'`));
  assert.ok(policy.includes("default-src 'none'"));
  assert.ok(policy.includes("connect-src 'self'"));
  assert.ok(!policy.includes("unsafe-inline"));
  assert.ok(!policy.includes("unsafe-eval"));

  assert.match(html, /textContent/);
  assert.match(html, /document\.createElement/);
  assert.match(html, /__cloud\/auth\/members/);
  assert.match(html, /__cloud\/auth\/members\/invitations/);
  assert.match(html, /__cloud\/auth\/oidc\/invitations\/redeem/);
  assert.match(html, /__cloud\/auth\/logout/);
  assert.match(html, /__cloud\/auth\/api-keys/);
  assert.match(html, /api-key-panel/);
  assert.match(html, /expiresAt:/);
  assert.match(html, /method: "DELETE"/);
  assert.match(html, /Copy and hide token/);
  assert.match(html, /writeText\(newlyIssuedToken\)/);
  assert.match(html, /clearIssuedToken/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
  assert.match(html, /expectedUpdatedAt/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "the page must not use inline event handlers");
  assert.doesNotMatch(html, /principalId|\.subject|identity\.subject/);
});

test("Cloud Worker restricts the customer portal route to GET", async () => {
  const app = createCloudRuntime({ env: { OMNIROUTE_CLOUD_PUBLIC_ORIGIN: ORIGIN } });
  const response = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_CUSTOMER_PORTAL_PATH}`, { method: "POST" })
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(response.headers.get("cache-control"), "no-store");
});
