import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { createCloudCustomerMembership } from "../../src/cloud/customerIdentity";
import { createCloudCustomerTenant } from "../../src/cloud/tenants";
import { addCloudTenantOidcIdentity, setCloudTenantOidcConfig } from "../../src/cloud/tenantOidc";
import { createCloudRuntime } from "../../src/cloud/runtime";

const enabled = process.env.RUN_CLOUD_TENANT_OIDC_BROWSER_INT === "1";
const issuer = "https://identity.example.test";
const adminToken = "test-only-tenant-oidc-browser-admin-token";
const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(53)));

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
    return (
      (this.db
        .prepare(this.sql)
        .get(...(this.values as (null | number | bigint | string | Uint8Array)[])) as
        U | undefined) ?? null
    );
  }

  async all<U = T>(): Promise<{ results: U[]; success: boolean }> {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...(this.values as (null | number | bigint | string | Uint8Array)[])) as U[],
      success: true,
    };
  }

  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    const result = this.db
      .prepare(this.sql)
      .run(...(this.values as (null | number | bigint | string | Uint8Array)[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteCloudDb implements CloudDb {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
  }

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new SqliteStatement<T>(this.raw, sql);
  }

  async batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result: unknown[] = [];
      for (const statement of statements) result.push(await statement.run());
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<unknown> {
    return this.raw.exec(sql);
  }
}

async function makeDb() {
  const db = new SqliteCloudDb();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0005_cloud_customer_identity.sql",
    "0015_cloud_tenant_oidc.sql",
    "0016_cloud_tenant_oidc_sessions.sql",
    "0018_cloud_tenant_membership_invitations.sql",
    "0020_cloud_tenant_oidc_owner_claims.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  const tenant = await createCloudCustomerTenant(db, {
    id: "oidc-browser-tenant",
    name: "Browser OIDC Tenant",
    slug: "oidc-browser-tenant",
  });
  const membership = await createCloudCustomerMembership(db, {
    tenantId: tenant.id,
    principalId: "browser-owner",
    role: "owner",
  });
  await setCloudTenantOidcConfig(db, encryptionKey, {
    tenantId: tenant.id,
    issuer,
    clientId: "browser-client",
    clientSecret: "temporary-browser-secret",
    isEnabled: true,
  });
  await addCloudTenantOidcIdentity(db, {
    tenantId: tenant.id,
    issuer,
    subject: "browser-owner-subject",
    membershipId: membership.id,
  });
  return { db, tenant };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test(
  "tenant OIDC login redirects through a temporary mock IdP and completes the browser callback",
  {
    skip:
      !enabled &&
      "Set RUN_CLOUD_TENANT_OIDC_BROWSER_INT=1 to run the local tenant OIDC + Chromium integration.",
    timeout: 120_000,
  },
  async (t) => {
    const { db, tenant } = await makeDb();
    const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    Object.assign(jwk, { kid: "temporary-browser-idp-key", alg: "RS256", use: "sig" });
    const issuerState: { nonce?: string; tokenRequests: URLSearchParams[] } = { tokenRequests: [] };
    const fetcher: typeof fetch = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.href === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ["RS256"],
        });
      }
      if (url.href === `${issuer}/token`) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        issuerState.tokenRequests.push(params);
        const idToken = await new SignJWT({ nonce: issuerState.nonce })
          .setProtectedHeader({ alg: "RS256", kid: "temporary-browser-idp-key" })
          .setIssuer(issuer)
          .setSubject("browser-owner-subject")
          .setAudience("browser-client")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return Response.json({ id_token: idToken });
      }
      if (url.href === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
      throw new Error(`Unexpected mock OIDC request: ${url.href}`);
    };

    let runtime: ReturnType<typeof createCloudRuntime>;
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const host = incoming.headers.host;
        assert.ok(host);
        const url = `http://${host}${incoming.url ?? "/"}`;
        const response = await runtime.fetch(
          new Request(url, {
            method: incoming.method,
            headers: incoming.headers as HeadersInit,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          })
        );
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        outgoing.writeHead(500, { "content-type": "text/plain" });
        outgoing.end(error instanceof Error ? error.message : "server error");
      }
    });
    const baseUrl = await listen(server);
    runtime = createCloudRuntime({
      env: {
        DB: db,
        OMNIROUTE_ENV: "development",
        OMNIROUTE_CLOUD_ADMIN_TOKEN: adminToken,
        OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: "test-only-maintenance-token",
        OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
        OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: "test-only-idempotency-signing-key-value-123456",
        OMNIROUTE_CLOUD_PUBLIC_ORIGIN: baseUrl,
      },
      fetcher,
    });
    assert.equal((await fetch(`${baseUrl}/__cloud/health`)).status, 200);
    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.raw.close();
    });

    const browser: Browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
    t.after(async () => browser.close());
    const context = await browser.newContext();
    let proxiedRequests = 0;
    let proxyError = "";
    let callbackCookieHeader = "";
    const interceptedUrls: string[] = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      interceptedUrls.push(request.url());
      if (new URL(request.url()).pathname.endsWith("/oidc/callback")) {
        callbackCookieHeader = request.headers().cookie ?? "";
      }
      proxiedRequests += 1;
      try {
        const response = await fetch(request.url(), {
          method: request.method(),
          headers: request.headers(),
          ...(request.postData() === null ? {} : { body: request.postData()! }),
          redirect: "manual",
        });
        const headers = Object.fromEntries(response.headers.entries());
        const location = response.headers.get("location");
        if (response.status === 302 && location?.startsWith(`${issuer}/authorize`)) {
          const authorization = new URL(location);
          assert.equal(authorization.searchParams.get("client_id"), "browser-client");
          assert.equal(authorization.searchParams.get("response_type"), "code");
          assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
          issuerState.nonce = authorization.searchParams.get("nonce") ?? undefined;
          const callback = new URL(authorization.searchParams.get("redirect_uri")!);
          callback.searchParams.set("code", "temporary-mock-code");
          callback.searchParams.set("state", authorization.searchParams.get("state")!);
          const cookies = response.headers.getSetCookie();
          await route.fulfill({
            status: 302,
            headers: {
              location: callback.toString(),
              ...(cookies.length > 0 ? { "set-cookie": cookies.join(", ") } : {}),
            },
          });
          return;
        }
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) headers["set-cookie"] = cookies.join(", ");
        await route.fulfill({
          status: response.status,
          headers,
          body: Buffer.from(await response.arrayBuffer()),
        });
      } catch (error) {
        proxyError = error instanceof Error ? error.message : String(error);
        await route.fulfill({ status: 502, body: proxyError });
      }
    });
    const page = await context.newPage();
    const response = await page
      .goto(`${baseUrl}/__cloud/auth/oidc/login?tenant=${tenant.slug}`, {
        waitUntil: "networkidle",
      })
      .catch((error: unknown) => {
        assert.fail(
          `browser navigation failed; intercepted ${proxiedRequests} requests (${interceptedUrls.join(", ")}); proxy error: ${proxyError}; ${String(error)}`
        );
      });
    assert.equal(
      response?.status(),
      200,
      `browser ended at ${page.url()}: ${await response?.text()}; callback cookie: ${callbackCookieHeader}`
    );
    await page.getByRole("heading", { name: "OmniRoute customer portal" }).waitFor();
    assert.match(page.url(), /\/__cloud\/portal$/);
    const session = await page.evaluate(async () => {
      const result = await fetch("/__cloud/auth/session", { credentials: "same-origin" });
      return { status: result.status, body: await result.json() };
    });
    assert.equal(session.status, 200);
    assert.equal((session.body as { authenticated?: boolean }).authenticated, true);
    assert.equal(
      (session.body as { tenant?: { id?: string } }).tenant?.id,
      tenant.id,
      "callback session remains bound to the configured tenant"
    );
    assert.equal(issuerState.tokenRequests.length, 1);
    assert.equal(issuerState.tokenRequests[0]?.get("code"), "temporary-mock-code");
    assert.equal(issuerState.tokenRequests[0]?.get("client_secret"), "temporary-browser-secret");
    assert.equal(issuerState.tokenRequests[0]?.has("code_verifier"), true);
    assert.equal(
      issuerState.tokenRequests[0]?.get("redirect_uri"),
      `${baseUrl}/__cloud/auth/oidc/callback`
    );
    await context.close();
  }
);
