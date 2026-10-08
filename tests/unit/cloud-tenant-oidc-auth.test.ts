import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import {
  CloudMembershipConflictError,
  createCloudCustomerMembership,
  getCloudCustomerMembership,
  issueCloudCustomerApiKey,
  updateCloudCustomerMembership,
} from "../../src/cloud/customerIdentity";
import { createCloudCustomerTenant } from "../../src/cloud/tenants";
import { addCloudTenantOidcIdentity, setCloudTenantOidcConfig } from "../../src/cloud/tenantOidc";
import {
  CLOUD_TENANT_OIDC_CALLBACK_PATH,
  CLOUD_TENANT_OIDC_LOGIN_PATH,
  CLOUD_TENANT_OIDC_LOGOUT_PATH,
  CLOUD_TENANT_OIDC_SESSION_COOKIE,
  CLOUD_TENANT_OIDC_SESSION_PATH,
  CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH,
  CLOUD_TENANT_MEMBERSHIP_INVITATION_REDEEM_PATH,
  CLOUD_TENANT_MEMBERS_PATH,
  cleanupExpiredCloudTenantOidcAuthArtifacts,
} from "../../src/cloud/tenantOidcAuth";
import { createCloudRuntime } from "../../src/cloud/runtime";
import { CLOUD_CUSTOMER_PORTAL_PATH } from "../../src/cloud/customerPortal";

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

class FailingAuditStatement<T = unknown> implements CloudDbStatement<T> {
  private bound: CloudDbStatement<T>;

  constructor(
    private readonly sql: string,
    statement: CloudDbStatement<T>
  ) {
    this.bound = statement;
  }

  bind(...values: unknown[]): CloudDbStatement<T> {
    this.bound = this.bound.bind(...values);
    return this;
  }

  first<U = T>(column?: string): Promise<U | null> {
    return this.bound.first<U>(column);
  }

  all<U = T>(): Promise<{ results: U[]; success: boolean; meta?: Record<string, unknown> }> {
    return this.bound.all<U>();
  }

  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }> {
    if (this.sql.includes("INSERT INTO cloud_compliance_audit")) {
      throw new Error("simulated audit write failure");
    }
    return this.bound.run();
  }
}

class FailingAuditCloudDb implements CloudDb {
  constructor(private readonly inner: CloudDb) {}

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new FailingAuditStatement(sql, this.inner.prepare<T>(sql));
  }

  batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    return this.inner.batch(statements);
  }

  exec(sql: string): Promise<unknown> {
    return this.inner.exec(sql);
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
    "0018_cloud_tenant_membership_invitations.sql",
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

async function createPortalSession(
  db: CloudDb,
  tenantSlug: string,
  subject: string
): Promise<{ app: ReturnType<typeof runtime>; cookie: string }> {
  const state: { nonce?: string; tokenRequests: URLSearchParams[] } = { tokenRequests: [] };
  const app = runtime(db, await makeProvider(state, { subject }));
  const login = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenantSlug}`)
  );
  const authorization = new URL(login.headers.get("location")!);
  state.nonce = authorization.searchParams.get("nonce") ?? undefined;
  const callback = await app.fetch(
    new Request(
      `${ORIGIN}${CLOUD_TENANT_OIDC_CALLBACK_PATH}?code=session-code&state=${authorization.searchParams.get("state")}`,
      { headers: { Cookie: `omni_oidc_state=${getCookieValue(login, "omni_oidc_state")}` } }
    )
  );
  assert.equal(callback.status, 303);
  return { app, cookie: getCookieValue(callback, CLOUD_TENANT_OIDC_SESSION_COOKIE) };
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
  assert.equal(callback.headers.get("location"), `${ORIGIN}${CLOUD_CUSTOMER_PORTAL_PATH}`);
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

test("tenant OIDC logout revokes only the caller session, expires its cookie, and blocks introspection", async () => {
  const { db, tenant } = await setup();
  const portal = await createPortalSession(db, tenant.slug, "external-user-17");
  const otherPortal = await createPortalSession(db, tenant.slug, "external-user-17");
  const before = await portal.app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_SESSION_PATH}`, {
      headers: {
        Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${portal.cookie}`,
        Origin: ORIGIN,
      },
    })
  );
  assert.equal(before.status, 200);

  const logout = await portal.app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGOUT_PATH}`, {
      method: "POST",
      headers: {
        Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${portal.cookie}`,
        Origin: ORIGIN,
      },
    })
  );
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { loggedOut: true });
  const clearedCookie = logout.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${CLOUD_TENANT_OIDC_SESSION_COOKIE}=`));
  assert.ok(clearedCookie);
  assert.match(clearedCookie, /Path=\/__cloud\/auth(?:;|$)/);
  assert.match(clearedCookie, /Max-Age=0(?:;|$)/);
  assert.match(clearedCookie, /HttpOnly/);
  assert.match(clearedCookie, /SameSite=Lax/);

  const after = await portal.app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_SESSION_PATH}`, {
      headers: {
        Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${portal.cookie}`,
        Origin: ORIGIN,
      },
    })
  );
  assert.equal(after.status, 401);

  const otherSession = await otherPortal.app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_SESSION_PATH}`, {
      headers: {
        Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${otherPortal.cookie}`,
        Origin: ORIGIN,
      },
    })
  );
  assert.equal(otherSession.status, 200, "logout must leave a separate session active");

  const activeSessions = await db
    .prepare(
      "SELECT count(*) AS count FROM cloud_tenant_oidc_sessions WHERE tenant_id = ? AND revoked_at_ms IS NULL"
    )
    .bind(tenant.id)
    .first<{ count: number }>();
  assert.equal(activeSessions?.count, 1);
});

test("tenant OIDC logout requires exact same origin and safely handles absent or invalid cookies", async () => {
  const { db, tenant } = await setup();
  const portal = await createPortalSession(db, tenant.slug, "external-user-17");
  const crossOrigin = await portal.app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGOUT_PATH}`, {
      method: "POST",
      headers: {
        Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${portal.cookie}`,
        Origin: "https://attacker.example",
      },
    })
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.getSetCookie().length, 0);
  const missingOrigin = await portal.app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGOUT_PATH}`, {
      method: "POST",
      headers: { Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${portal.cookie}` },
    })
  );
  assert.equal(missingOrigin.status, 403);

  for (const cookieHeader of [undefined, `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=invalid`]) {
    const headers = new Headers({ Origin: ORIGIN });
    if (cookieHeader) headers.set("Cookie", cookieHeader);
    const logout = await portal.app.fetch(
      new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGOUT_PATH}`, {
        method: "POST",
        headers,
      })
    );
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { loggedOut: true });
    assert.ok(
      logout.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith(`${CLOUD_TENANT_OIDC_SESSION_COOKIE}=`) && /Max-Age=0/.test(value)
        )
    );
  }

  const session = await portal.app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_SESSION_PATH}`, {
      headers: { Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${portal.cookie}` },
    })
  );
  assert.equal(
    session.status,
    200,
    "missing and malformed logout cookies must not revoke another session"
  );
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

test("owner can issue a digest-only OIDC invitation that creates membership only after verified callback", async () => {
  const { db, tenant, membership } = await setup();
  await db
    .prepare("UPDATE cloud_customer_memberships SET role = 'owner' WHERE tenant_id = ? AND id = ?")
    .bind(tenant.id, membership.id)
    .run();

  const loginState: { nonce?: string; tokenRequests: URLSearchParams[] } = { tokenRequests: [] };
  const loginApp = runtime(db, await makeProvider(loginState));
  const login = await loginApp.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenant.slug}`)
  );
  const authorization = new URL(login.headers.get("location")!);
  loginState.nonce = authorization.searchParams.get("nonce") ?? undefined;
  const state = authorization.searchParams.get("state")!;
  const callback = await loginApp.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_CALLBACK_PATH}?code=admin-code&state=${state}`, {
      headers: { Cookie: `omni_oidc_state=${getCookieValue(login, "omni_oidc_state")}` },
    })
  );
  const ownerCookie = getCookieValue(callback, CLOUD_TENANT_OIDC_SESSION_COOKIE);

  const create = await loginApp.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH}`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${ownerCookie}`,
      },
      body: JSON.stringify({ role: "admin" }),
    })
  );
  assert.equal(create.status, 201);
  const issued = (await create.json()) as { code: string; role: string; expiresAt: string };
  assert.equal(issued.role, "admin");
  assert.equal(Date.parse(issued.expiresAt), NOW + 15 * 60 * 1000);
  const inviteHash = createHash("sha256").update(issued.code).digest("hex");
  assert.equal(
    db.raw.prepare("SELECT code_hash FROM cloud_tenant_membership_invitations WHERE id != ''").get()
      ?.code_hash,
    inviteHash,
    "only the invitation digest is persisted"
  );
  assert.equal(
    db.raw
      .prepare("SELECT 1 FROM cloud_tenant_membership_invitations WHERE code_hash = ?")
      .get(issued.code),
    undefined,
    "raw code must not be stored"
  );

  const newMemberState: { nonce?: string; tokenRequests: URLSearchParams[] } = {
    tokenRequests: [],
  };
  const newMemberApp = runtime(db, await makeProvider(newMemberState, { subject: "new-person" }));
  const redeem = await newMemberApp.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERSHIP_INVITATION_REDEEM_PATH}`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ code: issued.code }),
    })
  );
  assert.equal(redeem.status, 200);
  assert.equal(
    redeem.headers.get("location"),
    null,
    "redeem returns JSON for top-level navigation"
  );
  const redeemBody = (await redeem.json()) as { authorizationUrl: string };
  const inviteAuthorization = new URL(redeemBody.authorizationUrl);
  assert.equal(inviteAuthorization.origin, ISSUER);
  assert.equal(inviteAuthorization.searchParams.has("code"), false);
  assert.equal(redeemBody.authorizationUrl.includes(issued.code), false);
  newMemberState.nonce = inviteAuthorization.searchParams.get("nonce") ?? undefined;
  const inviteState = inviteAuthorization.searchParams.get("state")!;
  const inviteStateCookie = getCookieValue(redeem, "omni_oidc_state");
  assert.equal(inviteStateCookie, inviteState);

  const accepted = await newMemberApp.fetch(
    new Request(
      `${ORIGIN}${CLOUD_TENANT_OIDC_CALLBACK_PATH}?code=invitee-code&state=${encodeURIComponent(inviteState)}`,
      { headers: { Cookie: `omni_oidc_state=${inviteStateCookie}`, Origin: ORIGIN } }
    )
  );
  assert.equal(accepted.status, 303);
  const createdMembership = db.raw
    .prepare(
      `SELECT membership.id, membership.role, identity.issuer, identity.subject
         FROM cloud_customer_memberships AS membership
         JOIN cloud_tenant_oidc_identities AS identity
           ON identity.tenant_id = membership.tenant_id AND identity.membership_id = membership.id
        WHERE identity.tenant_id = ? AND identity.subject = 'new-person'`
    )
    .get(tenant.id) as { id: string; role: string; issuer: string; subject: string } | undefined;
  assert.ok(createdMembership?.id);
  assert.equal(createdMembership?.role, "admin");
  assert.equal(createdMembership?.issuer, ISSUER);
  assert.equal(createdMembership?.subject, "new-person");
  assert.equal(
    db.raw
      .prepare("SELECT consumed_at_ms FROM cloud_tenant_membership_invitations WHERE code_hash = ?")
      .get(inviteHash)?.consumed_at_ms,
    NOW
  );
  const audit = db.raw
    .prepare(
      "SELECT action, metadata_json FROM cloud_compliance_audit WHERE tenant_id = ? AND action = 'customer.membership.invitation.accepted'"
    )
    .get(tenant.id) as { action: string; metadata_json: string };
  assert.equal(audit.action, "customer.membership.invitation.accepted");
  assert.deepEqual(JSON.parse(audit.metadata_json), {
    invitationId: db.raw
      .prepare("SELECT id FROM cloud_tenant_membership_invitations WHERE code_hash = ?")
      .get(inviteHash)?.id,
    role: "admin",
  });

  const replay = await newMemberApp.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERSHIP_INVITATION_REDEEM_PATH}`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ code: issued.code }),
    })
  );
  assert.equal(replay.status, 400, "consumed invitation cannot start another login");
  assert.ok(await cleanupExpiredCloudTenantOidcAuthArtifacts(db, NOW + 24 * 60 * 60 * 1000 + 1));
  assert.equal(
    db.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM cloud_tenant_membership_invitations WHERE code_hash = ?"
      )
      .get(inviteHash)?.count,
    0,
    "scheduled cleanup removes old consumed invitations"
  );
});

test("membership invitation issue requires a same-origin owner/admin session and never permits owner role", async () => {
  const { db, tenant, membership } = await setup();
  const state: { nonce?: string; tokenRequests: URLSearchParams[] } = { tokenRequests: [] };
  const app = runtime(db, await makeProvider(state));
  const login = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_OIDC_LOGIN_PATH}?tenant=${tenant.slug}`)
  );
  const authorization = new URL(login.headers.get("location")!);
  state.nonce = authorization.searchParams.get("nonce") ?? undefined;
  const callback = await app.fetch(
    new Request(
      `${ORIGIN}${CLOUD_TENANT_OIDC_CALLBACK_PATH}?code=member-code&state=${authorization.searchParams.get("state")}`,
      { headers: { Cookie: `omni_oidc_state=${getCookieValue(login, "omni_oidc_state")}` } }
    )
  );
  const memberCookie = `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${getCookieValue(callback, CLOUD_TENANT_OIDC_SESSION_COOKIE)}`;
  const memberDenied = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH}`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ role: "member" }),
    })
  );
  assert.equal(memberDenied.status, 403, "an authenticated member cannot invite others");
  const memberListDenied = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERS_PATH}`, {
      headers: { Origin: ORIGIN, Cookie: memberCookie },
    })
  );
  assert.equal(memberListDenied.status, 403, "members cannot list tenant membership");
  const crossOrigin = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH}`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
        Cookie: memberCookie,
      },
      body: JSON.stringify({ role: "member" }),
    })
  );
  assert.equal(crossOrigin.status, 403, "invitation creation rejects cross-origin writes");
  const ownerRole = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH}`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ role: "owner" }),
    })
  );
  assert.equal(ownerRole.status, 400);
  assert.equal(
    db.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM cloud_tenant_membership_invitations WHERE tenant_id = ?"
      )
      .get(tenant.id)?.count,
    0
  );
  assert.equal(membership.role, "member");
});

test("OIDC owner member API paginates only its tenant and CAS-updates with key revocation and safe audit", async () => {
  const { db, tenant, membership: owner } = await setup();
  await db
    .prepare("UPDATE cloud_customer_memberships SET role = 'owner' WHERE tenant_id = ? AND id = ?")
    .bind(tenant.id, owner.id)
    .run();
  const target = await createCloudCustomerMembership(db, {
    tenantId: tenant.id,
    principalId: "member-to-update",
    role: "member",
    now: new Date(NOW - 10_000).toISOString(),
  });
  const otherTenant = await createCloudCustomerTenant(db, {
    id: "customer-other-oidc",
    name: "Other OIDC Customer",
    slug: "other-oidc-customer",
  });
  const foreign = await createCloudCustomerMembership(db, {
    tenantId: otherTenant.id,
    principalId: "foreign-member",
    role: "member",
  });
  const { app, cookie } = await createPortalSession(db, tenant.slug, "external-user-17");
  const cookieHeader = `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${cookie}`;

  const firstPageResponse = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERS_PATH}?limit=1`, {
      headers: { Origin: ORIGIN, Cookie: cookieHeader },
    })
  );
  assert.equal(firstPageResponse.status, 200);
  const firstPage = (await firstPageResponse.json()) as {
    members: Array<Record<string, unknown>>;
    nextCursor: string | null;
  };
  assert.equal(firstPage.members.length, 1);
  assert.ok(firstPage.nextCursor);
  assert.equal("principalId" in firstPage.members[0]!, false);
  assert.equal("subject" in firstPage.members[0]!, false);
  assert.equal("issuer" in firstPage.members[0]!, false);

  const secondPageResponse = await app.fetch(
    new Request(
      `${ORIGIN}${CLOUD_TENANT_MEMBERS_PATH}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      { headers: { Origin: ORIGIN, Cookie: cookieHeader } }
    )
  );
  const secondPage = (await secondPageResponse.json()) as {
    members: Array<{ id: string }>;
    nextCursor: string | null;
  };
  assert.equal(secondPageResponse.status, 200);
  assert.equal(secondPage.members.length, 1);
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual(
    new Set([firstPage.members[0]!.id, secondPage.members[0]!.id]),
    new Set([owner.id, target.id])
  );
  assert.equal(
    JSON.stringify([firstPage.members, secondPage.members]).includes(foreign.id),
    false,
    "member listing is tenant-scoped"
  );

  const key = await issueCloudCustomerApiKey(db, { tenantId: tenant.id, membershipId: target.id });
  const targetBefore = await getCloudCustomerMembership(db, tenant.id, target.id);
  assert.ok(targetBefore);
  const update = async (membershipId: string, body: unknown) =>
    app.fetch(
      new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERS_PATH}/${membershipId}`, {
        method: "PATCH",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          Cookie: cookieHeader,
        },
        body: JSON.stringify(body),
      })
    );
  const unknownField = await update(target.id, {
    role: "viewer",
    expectedUpdatedAt: targetBefore.updatedAt,
    oidcSubject: "must-be-rejected",
  });
  assert.equal(unknownField.status, 400);
  const crossOrigin = await app.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERS_PATH}/${target.id}`, {
      method: "PATCH",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ role: "viewer", expectedUpdatedAt: targetBefore.updatedAt }),
    })
  );
  assert.equal(crossOrigin.status, 403);
  const roleResponse = await update(target.id, {
    role: "viewer",
    expectedUpdatedAt: targetBefore.updatedAt,
  });
  assert.equal(roleResponse.status, 200);
  const updated = (await roleResponse.json()) as {
    id: string;
    role: string;
    isActive: boolean;
    updatedAt: string;
    principalId?: string;
  };
  assert.equal(updated.role, "viewer");
  assert.equal(updated.isActive, true);
  assert.equal("principalId" in updated, false);

  const stale = await update(target.id, {
    isActive: false,
    expectedUpdatedAt: targetBefore.updatedAt,
  });
  assert.equal(stale.status, 409);
  assert.equal((await getCloudCustomerMembership(db, tenant.id, target.id))?.isActive, true);

  const deactivate = await update(target.id, {
    isActive: false,
    expectedUpdatedAt: updated.updatedAt,
  });
  assert.equal(deactivate.status, 200);
  assert.equal(((await deactivate.json()) as { isActive: boolean }).isActive, false);
  const storedKey = db.raw
    .prepare("SELECT revoked_at FROM cloud_customer_api_keys WHERE id = ?")
    .get(key.id) as { revoked_at: string | null };
  assert.ok(storedKey.revoked_at, "deactivation permanently revokes issued API keys");

  const foreignUpdate = await update(foreign.id, {
    role: "viewer",
    expectedUpdatedAt: new Date(NOW).toISOString(),
  });
  assert.equal(foreignUpdate.status, 404, "foreign tenant membership IDs are hidden");

  const audits = db.raw
    .prepare(
      `SELECT action, target, metadata_json FROM cloud_compliance_audit
        WHERE tenant_id = ? AND action = 'customer.membership.portal.update'
        ORDER BY timestamp, id`
    )
    .all(tenant.id) as Array<{ action: string; target: string; metadata_json: string }>;
  assert.equal(audits.length, 2);
  assert.equal(audits[0]?.target, target.id);
  assert.deepEqual(JSON.parse(audits[0]!.metadata_json), {
    role: "viewer",
    isActive: true,
    changedFields: ["role"],
  });
  assert.equal(audits[1]?.target, target.id);
  assert.deepEqual(JSON.parse(audits[1]!.metadata_json), {
    role: "viewer",
    isActive: false,
    changedFields: ["isActive"],
  });
  assert.equal(JSON.stringify(audits).includes("external-user-17"), false);
});

test("OIDC member API restricts admins from owners and preserves the last active owner", async () => {
  const { db, tenant, membership: owner } = await setup();
  await db
    .prepare("UPDATE cloud_customer_memberships SET role = 'owner' WHERE tenant_id = ? AND id = ?")
    .bind(tenant.id, owner.id)
    .run();
  const admin = await createCloudCustomerMembership(db, {
    tenantId: tenant.id,
    principalId: "oidc-admin-membership",
    role: "admin",
  });
  await addCloudTenantOidcIdentity(db, {
    tenantId: tenant.id,
    issuer: ISSUER,
    subject: "external-admin",
    membershipId: admin.id,
  });
  const ownerPortal = await createPortalSession(db, tenant.slug, "external-user-17");
  const adminPortal = await createPortalSession(db, tenant.slug, "external-admin");
  const update = (
    portal: { app: ReturnType<typeof runtime>; cookie: string },
    id: string,
    body: unknown
  ) =>
    portal.app.fetch(
      new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERS_PATH}/${id}`, {
        method: "PATCH",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${portal.cookie}`,
        },
        body: JSON.stringify(body),
      })
    );
  const ownerBefore = await getCloudCustomerMembership(db, tenant.id, owner.id);
  assert.ok(ownerBefore);
  const adminDenied = await update(adminPortal, owner.id, {
    role: "admin",
    expectedUpdatedAt: ownerBefore.updatedAt,
  });
  assert.equal(adminDenied.status, 403);
  await assert.rejects(
    updateCloudCustomerMembership(db, {
      tenantId: tenant.id,
      membershipId: owner.id,
      role: "admin",
      isActive: true,
      expectedUpdatedAt: ownerBefore.updatedAt,
      actorMembershipId: admin.id,
      now: new Date(Math.max(NOW, Date.parse(ownerBefore.updatedAt) + 1)).toISOString(),
    }),
    CloudMembershipConflictError,
    "the D1 update guard also denies admin-to-owner edits"
  );

  const lastOwner = await update(ownerPortal, owner.id, {
    isActive: false,
    expectedUpdatedAt: ownerBefore.updatedAt,
  });
  assert.equal(lastOwner.status, 409);
  assert.match(await lastOwner.text(), /At least one active owner must remain/);
  const unchanged = await getCloudCustomerMembership(db, tenant.id, owner.id);
  assert.equal(unchanged?.role, "owner");
  assert.equal(unchanged?.isActive, true);
});

test("membership audit failure rolls back the member update and API-key revocation", async () => {
  const { db, tenant, membership: owner } = await setup();
  await db
    .prepare("UPDATE cloud_customer_memberships SET role = 'owner' WHERE tenant_id = ? AND id = ?")
    .bind(tenant.id, owner.id)
    .run();
  const target = await createCloudCustomerMembership(db, {
    tenantId: tenant.id,
    principalId: "membership-audit-failure-target",
    role: "member",
  });
  const key = await issueCloudCustomerApiKey(db, { tenantId: tenant.id, membershipId: target.id });
  const targetBefore = await getCloudCustomerMembership(db, tenant.id, target.id);
  assert.ok(targetBefore);
  const portal = await createPortalSession(db, tenant.slug, "external-user-17");
  const failingApp = createCloudRuntime({
    env: {
      DB: new FailingAuditCloudDb(db),
      OMNIROUTE_ENV: "production",
      OMNIROUTE_CLOUD_PUBLIC_ORIGIN: ORIGIN,
      OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
    },
    now: () => new Date(NOW),
  });
  const response = await failingApp.fetch(
    new Request(`${ORIGIN}${CLOUD_TENANT_MEMBERS_PATH}/${target.id}`, {
      method: "PATCH",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Cookie: `${CLOUD_TENANT_OIDC_SESSION_COOKIE}=${portal.cookie}`,
      },
      body: JSON.stringify({
        isActive: false,
        expectedUpdatedAt: targetBefore.updatedAt,
      }),
    })
  );
  assert.equal(response.status, 503);
  const unchanged = await getCloudCustomerMembership(db, tenant.id, target.id);
  assert.equal(unchanged?.isActive, true, "membership change must roll back with audit failure");
  const storedKey = db.raw
    .prepare("SELECT revoked_at FROM cloud_customer_api_keys WHERE id = ?")
    .get(key.id) as { revoked_at: string | null };
  assert.equal(storedKey.revoked_at, null, "key revocation must roll back with audit failure");
  assert.equal(
    db.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM cloud_compliance_audit WHERE tenant_id = ? AND action = 'customer.membership.portal.update'"
      )
      .get(tenant.id)?.count,
    0
  );
});
