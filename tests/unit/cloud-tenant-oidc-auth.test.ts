import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { createCloudCustomerMembership } from "../../src/cloud/customerIdentity";
import { createCloudCustomerTenant } from "../../src/cloud/tenants";
import { addCloudTenantOidcIdentity, setCloudTenantOidcConfig } from "../../src/cloud/tenantOidc";
import {
  CLOUD_TENANT_OIDC_CALLBACK_PATH,
  CLOUD_TENANT_OIDC_LOGIN_PATH,
  CLOUD_TENANT_OIDC_SESSION_COOKIE,
  CLOUD_TENANT_OIDC_SESSION_PATH,
  cleanupExpiredCloudTenantOidcAuthArtifacts,
} from "../../src/cloud/tenantOidcAuth";
import { createCloudRuntime } from "../../src/cloud/runtime";

const ISSUER = "https://identity.example.test";
const ORIGIN = "https://cloud.example.test";
const ENCRYPTION_KEY = Buffer.alloc(32, 41).toString("base64");
const NOW = Date.UTC(2026, 9, 8, 12);

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

async function setup() {
  const db = new SqliteCloudDb();
  for (const name of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0005_cloud_customer_identity.sql",
    "0015_cloud_tenant_oidc.sql",
    "0016_cloud_tenant_oidc_sessions.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", name), "utf8"));
  }
  const tenant = await createCloudCustomerTenant(db, {
    id: "customer-oidc",
    name: "OIDC Customer",
    slug: "oidc-customer",
  });
  const membership = await createCloudCustomerMembership(db, {
    tenantId: tenant.id,
    principalId: "principal-oidc",
    role: "member",
  });
  await setCloudTenantOidcConfig(db, ENCRYPTION_KEY, {
    tenantId: tenant.id,
    issuer: ISSUER,
    clientId: "omni-client",
    clientSecret: "client-secret-test",
    isEnabled: true,
  });
  const identity = await addCloudTenantOidcIdentity(db, {
    tenantId: tenant.id,
    issuer: ISSUER,
    subject: "external-user-17",
    membershipId: membership.id,
  });
  return { db, tenant, membership, identity };
}

function getCookieValue(response: Response, name: string): string {
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie, `expected ${name} cookie`);
  return cookie.split(";", 1)[0]!.slice(name.length + 1);
}

function runtime(db: CloudDb, fetcher: typeof fetch = fetch) {
  return createCloudRuntime({
    env: {
      DB: db,
      OMNIROUTE_ENV: "production",
      OMNIROUTE_CLOUD_PUBLIC_ORIGIN: ORIGIN,
      OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
    },
    now: () => new Date(NOW),
    fetcher,
  });
}

async function makeProvider(
  fetcherState: { nonce?: string; tokenRequests: URLSearchParams[] },
  overrides: {
    issuer?: string;
    audience?: string;
    subject?: string;
    nonce?: string;
    corruptSignature?: boolean;
  } = {}
) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.href === `${ISSUER}/token`) {
      const params = new URLSearchParams(String(init?.body ?? ""));
      fetcherState.tokenRequests.push(params);
      const claims = new SignJWT({ nonce: overrides.nonce ?? fetcherState.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(overrides.issuer ?? ISSUER)
        .setSubject(overrides.subject ?? "external-user-17")
        .setAudience(overrides.audience ?? "omni-client")
        .setIssuedAt(Math.floor(NOW / 1000))
        .setExpirationTime(Math.floor(NOW / 1000) + 300);
      let idToken = await claims.sign(privateKey);
      if (overrides.corruptSignature) {
        const segments = idToken.split(".");
        const signature = segments[2] ?? "";
        segments[2] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
        idToken = segments.join(".");
      }
      return Response.json({ id_token: idToken });
    }
    if (url.href === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
    throw new Error(`Unexpected outbound URL: ${url.href}`);
  };
  return fetcher;
}

test("tenant OIDC login uses fixed origin, state, nonce and PKCE, then issues an isolated revocable session", async () => {
  const { db, tenant, membership } = await setup();
  const fetchState: { nonce?: string; tokenRequests: URLSearchParams[] } = { tokenRequests: [] };
  const fetcher = await makeProvider(fetchState);
  const app = runtime(db, fetcher);
  const login = await app.fetch(
    new Request(
      `${ORIGIN}${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenant.slug}&redirect=https://evil.test`,
      {
        headers: { Origin: ORIGIN },
      }
    )
  );
  assert.equal(login.status, 302);
  const authorization = new URL(login.headers.get("location")!);
  assert.equal(authorization.origin, ISSUER);
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    `${ORIGIN}${CLOUD_TENANT_OIDC_CALLBACK_PATH}`
  );
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.has("redirect"), false);
  fetchState.nonce = authorization.searchParams.get("nonce") ?? undefined;
  const state = authorization.searchParams.get("state")!;
  const stateCookie = getCookieValue(login, "omni_oidc_state");
  assert.equal(stateCookie, state);
  assert.equal(login.headers.getSetCookie()[0]?.includes("HttpOnly"), true);
  assert.equal(login.headers.getSetCookie()[0]?.includes("SameSite=Lax"), true);

  const callback = await app.fetch(
    new Request(
      `${ORIGIN}${CLOUD_TENANT_OIDC_CALLBACK_PATH}?code=authorization-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `omni_oidc_state=${stateCookie}`, Origin: ORIGIN } }
    )
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), `${ORIGIN}${CLOUD_TENANT_OIDC_SESSION_PATH}`);
  assert.equal(fetchState.tokenRequests.length, 1);
  assert.equal(fetchState.tokenRequests[0]?.get("code_verifier")?.length, 43);
  assert.equal(fetchState.tokenRequests[0]?.get("client_secret"), "client-secret-test");
  assert.equal(
    fetchState.tokenRequests[0]?.get("redirect_uri"),
    `${ORIGIN}${CLOUD_TENANT_OIDC_CALLBACK_PATH}`
  );
  const sessionCookie = getCookieValue(callback, CLOUD_TENANT_OIDC_SESSION_COOKIE);
  assert.equal(
    callback.headers.getSetCookie().some((value) => value.includes("HttpOnly")),
    true
  );
  assert.equal(
    callback.headers.getSetCookie().some((value) => value.includes("Path=/__cloud/auth")),
    true
  );

  const session = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_SESSION_PATH}`, {
      headers: { Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${sessionCookie}`, Origin: ORIGIN },
    })
  );
  assert.equal(session.status, 200);
  const sessionBody = (await session.json()) as {
    authenticated: boolean;
    tenant: { id: string };
    membership: { id: string; principalId: string };
    identity: { issuer: string };
  };
  assert.equal(sessionBody.authenticated, true);
  assert.equal(sessionBody.tenant.id, tenant.id);
  assert.equal(sessionBody.membership.id, membership.id);
  assert.equal(sessionBody.membership.principalId, membership.principalId);
  assert.deepEqual(sessionBody.identity, { issuer: ISSUER });

  const chat = await app.fetch(
    new Request(`${ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${sessionCookie}`,
      },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
    })
  );
  assert.equal(chat.status, 401, "portal cookie must not authorize chat API");

  const gateway = await app.fetch(
    new Request(`${ORIGIN}/__gateway/v1/customer/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${sessionCookie}`,
      },
      body: JSON.stringify({}),
    })
  );
  const gatewayWithoutCookie = await app.fetch(
    new Request(`${ORIGIN}/__gateway/v1/customer/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  );
  assert.equal(gateway.status, gatewayWithoutCookie.status);
  assert.equal(
    await gateway.text(),
    await gatewayWithoutCookie.text(),
    "portal cookie must not alter gateway authorization"
  );

  await db
    .prepare("UPDATE cloud_customer_memberships SET is_active = 0 WHERE tenant_id = ? AND id = ?")
    .bind(tenant.id, membership.id)
    .run();
  const revoked = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_SESSION_PATH}`, {
      headers: { Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${sessionCookie}` },
    })
  );
  assert.equal(revoked.status, 401);
});

test("tenant OIDC login and introspection fail closed for missing or mismatched public origin", async () => {
  const { db, tenant } = await setup();
  const noOrigin = createCloudRuntime({
    env: { DB: db, OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY },
    now: () => new Date(NOW),
  });
  const unavailable = await noOrigin.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenant.slug}`)
  );
  assert.equal(unavailable.status, 503);

  const app = runtime(db, async () => {
    throw new Error("origin mismatch must not reach issuer");
  });
  const mismatch = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenant.slug}`, {
      headers: { Origin: "https://attacker.example" },
    })
  );
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.headers.get("location"), null);

  const insecureProduction = createCloudRuntime({
    env: {
      DB: db,
      OMNIROUTE_ENV: "production",
      OMNIROUTE_CLOUD_PUBLIC_ORIGIN: "http://localhost:8787",
    },
    now: () => new Date(NOW),
  });
  const insecure = await insecureProduction.fetch(
    new Request(`http://localhost:8787${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenant.slug}`)
  );
  assert.equal(insecure.status, 403, "production must not allow an HTTP public origin");
});

test("OIDC state is one-use and callback issuer redirect metadata must be HTTPS and public", async () => {
  const { db, tenant } = await setup();
  const state: { nonce?: string; tokenRequests: URLSearchParams[] } = { tokenRequests: [] };
  const fetcher = await makeProvider(state);
  const app = runtime(db, fetcher);
  const login = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenant.slug}`)
  );
  const authorization = new URL(login.headers.get("location")!);
  const nonce = authorization.searchParams.get("nonce")!;
  const stateParam = authorization.searchParams.get("state")!;
  state.nonce = nonce;
  const cookieValue = getCookieValue(login, "omni_oidc_state");
  const callbackUrl = `${ORIGIN}${CLOUD_TENANT_OIDC_CALLBACK_PATH}?code=code&state=${stateParam}`;
  const first = await app.fetch(
    new Request(callbackUrl, { headers: { Cookie: `omni_oidc_state=${cookieValue}` } })
  );
  assert.equal(first.status, 303);
  const replay = await app.fetch(
    new Request(callbackUrl, { headers: { Cookie: `omni_oidc_state=${cookieValue}` } })
  );
  assert.equal(replay.status, 400);
  assert.equal(state.tokenRequests.length, 1);

  const badDiscoveryApp = runtime(db, async () =>
    Response.json({
      issuer: ISSUER,
      authorization_endpoint: "http://127.0.0.1/authorize",
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      id_token_signing_alg_values_supported: ["RS256"],
    })
  );
  const badRedirect = await badDiscoveryApp.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenant.slug}`)
  );
  assert.equal(badRedirect.status, 503);
});

test("scheduled cleanup retains a just-consumed OIDC state through its callback read", async () => {
  const { db, tenant } = await setup();
  const fetcher = await makeProvider({ tokenRequests: [] });
  const app = runtime(db, fetcher);
  const login = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenant.slug}`)
  );
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const stateHash = createHash("sha256").update(state).digest("hex");
  db.raw
    .prepare("UPDATE cloud_tenant_oidc_login_states SET consumed_at_ms = ? WHERE state_hash = ?")
    .run(NOW, stateHash);

  assert.equal(await cleanupExpiredCloudTenantOidcAuthArtifacts(db, NOW), 0);
  assert.equal(
    db.raw
      .prepare("SELECT COUNT(*) AS count FROM cloud_tenant_oidc_login_states WHERE state_hash = ?")
      .get(stateHash)?.count,
    1
  );
  assert.equal(await cleanupExpiredCloudTenantOidcAuthArtifacts(db, NOW + 60_001), 1);
  assert.equal(
    db.raw
      .prepare("SELECT COUNT(*) AS count FROM cloud_tenant_oidc_login_states WHERE state_hash = ?")
      .get(stateHash)?.count,
    0
  );
});

test("OIDC callback requires trusted issuer, audience, signature and an active exact membership link", async () => {
  const scenarios: Array<{
    name: string;
    overrides: {
      issuer?: string;
      audience?: string;
      subject?: string;
      nonce?: string;
      corruptSignature?: boolean;
    };
    deactivateMembership?: boolean;
  }> = [
    { name: "issuer", overrides: { issuer: "https://attacker.example" } },
    { name: "audience", overrides: { audience: "another-client" } },
    { name: "signature", overrides: { corruptSignature: true } },
    { name: "nonce", overrides: { nonce: "wrong-nonce" } },
    { name: "unlinked subject", overrides: { subject: "unlinked-subject" } },
    { name: "inactive membership", overrides: {}, deactivateMembership: true },
  ];
  for (const scenario of scenarios) {
    const { db, tenant, membership } = await setup();
    if (scenario.deactivateMembership) {
      await db
        .prepare(
          "UPDATE cloud_customer_memberships SET is_active = 0 WHERE tenant_id = ? AND id = ?"
        )
        .bind(tenant.id, membership.id)
        .run();
    }
    const state: { nonce?: string; tokenRequests: URLSearchParams[] } = { tokenRequests: [] };
    const app = runtime(db, await makeProvider(state, scenario.overrides));
    const login = await app.fetch(
      new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenant.slug}`)
    );
    assert.equal(login.status, 302, `${scenario.name}: login setup`);
    const authorization = new URL(login.headers.get("location")!);
    state.nonce = authorization.searchParams.get("nonce") ?? undefined;
    const stateParam = authorization.searchParams.get("state")!;
    const stateCookie = getCookieValue(login, "omni_oidc_state");
    const result = await app.fetch(
      new Request(
        `${ORIGIN}${CLOUD_TENANT_OIDC_CALLBACK_PATH}?code=code&state=${encodeURIComponent(stateParam)}`,
        { headers: { Cookie: `omni_oidc_state=${stateCookie}` } }
      )
    );
    assert.equal(result.status, 401, `${scenario.name}: invalid identity must not create session`);
    assert.equal(result.headers.get("location"), null);
  }
});
