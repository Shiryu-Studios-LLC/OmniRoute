import { createLocalJWKSet, jwtVerify } from "jose";
import type { CloudDb } from "./db";
import { encryptCloudCredential, decryptCloudCredential } from "./credentialEncryption";
import { CLOUD_PLATFORM_TENANT_ID, getCloudTenantBySlug } from "./tenants";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";
import { getActiveCloudTenantOidcIdentity, getCloudTenantOidcCredentials } from "./tenantOidc";

export const CLOUD_TENANT_OIDC_LOGIN_PATH = "/__cloud/auth/oidc/login";
export const CLOUD_TENANT_OIDC_CALLBACK_PATH = "/__cloud/auth/oidc/callback";
export const CLOUD_TENANT_OIDC_SESSION_PATH = "/__cloud/auth/session";
export const CLOUD_TENANT_OIDC_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const CLOUD_TENANT_OIDC_STATE_TTL_MS = 10 * 60 * 1000;
export const CLOUD_TENANT_OIDC_SESSION_COOKIE = "omni_customer_session";

const STATE_COOKIE = "omni_oidc_state";
const SESSION_COOKIE_PATH = "/__cloud/auth";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 32 * 1024;
const MAX_JWKS_BYTES = 64 * 1024;
const ALLOWED_ID_TOKEN_ALGORITHMS = ["RS256", "ES256", "PS256"] as const;

interface OidcLoginStateRow {
  state_hash: string;
  tenant_id: string;
  issuer: string;
  client_id: string;
  redirect_uri: string;
  token_endpoint: string;
  jwks_uri: string;
  signing_algorithms_json: string;
  nonce_hash: string;
  code_verifier_encrypted: string;
  created_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
}

interface OidcSessionRow {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  membership_id: string;
  principal_id: string;
  role: "owner" | "admin" | "member" | "viewer";
  identity_id: string;
  issuer: string;
  subject: string;
  expires_at_ms: number;
}

export interface CloudTenantOidcAuthOptions {
  db?: CloudDb;
  /** Exact origin, for example https://cloud.example.com, with no path or slash. */
  publicOrigin?: string;
  environment?: string;
  credentialEncryptionKey?: string;
  now?: () => number;
  fetcher?: typeof fetch;
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  result.set("Pragma", "no-cache");
  return Response.json(body, { status, headers: result });
}

function originFromConfig(
  configured: string | undefined,
  environment: string | undefined
): URL | null {
  if (typeof configured !== "string" || !configured) return null;
  try {
    const origin = new URL(configured);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname.toLowerCase());
    const localEnvironment =
      environment === undefined ||
      ["test", "development", "local"].includes(environment.toLowerCase());
    if (
      origin.origin !== configured ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== "" ||
      origin.username !== "" ||
      origin.password !== "" ||
      (origin.protocol !== "https:" &&
        !(origin.protocol === "http:" && loopback && localEnvironment))
    ) {
      return null;
    }
    return origin;
  } catch {
    return null;
  }
}

function expectedOrigin(request: Request, options: CloudTenantOidcAuthOptions): URL | null {
  const configured = originFromConfig(options.publicOrigin, options.environment);
  if (!configured) return null;
  try {
    return new URL(request.url).origin === configured.origin ? configured : null;
  } catch {
    return null;
  }
}

function safeRemoteUrl(value: unknown, publicOrigin: URL): URL {
  if (typeof value !== "string" || value.length > 2048) throw new Error("invalid endpoint");
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const isIpLiteral = hostname.startsWith("[") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    isIpLiteral ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    url.origin === publicOrigin.origin
  ) {
    throw new Error("invalid endpoint");
  }
  return url;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes)
    throw new Error("response too large");
  if (!response.body) throw new Error("response body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchJson(
  fetcher: typeof fetch,
  url: URL,
  maxBytes: number,
  timeoutMs: number
): Promise<unknown> {
  const response = await fetcher(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    throw new Error("remote OIDC endpoint failed");
  }
  return readJsonBounded(response, maxBytes);
}

async function discoverOidc(
  issuer: string,
  publicOrigin: URL,
  fetcher: typeof fetch
): Promise<{
  authorizationEndpoint: URL;
  tokenEndpoint: URL;
  jwksUri: URL;
  algorithms: string[];
}> {
  const issuerUrl = safeRemoteUrl(issuer, publicOrigin);
  const discoveryUrl = new URL(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  const metadata = await fetchJson(
    fetcher,
    safeRemoteUrl(discoveryUrl.toString(), publicOrigin),
    MAX_METADATA_BYTES,
    5000
  );
  if (!isRecord(metadata) || metadata.issuer !== issuer) throw new Error("OIDC issuer mismatch");
  const authorizationEndpoint = safeRemoteUrl(metadata.authorization_endpoint, publicOrigin);
  const tokenEndpoint = safeRemoteUrl(metadata.token_endpoint, publicOrigin);
  const jwksUri = safeRemoteUrl(metadata.jwks_uri, publicOrigin);
  if (issuerUrl.protocol !== "https:") throw new Error("OIDC issuer must use HTTPS");

  const advertised = Array.isArray(metadata.id_token_signing_alg_values_supported)
    ? metadata.id_token_signing_alg_values_supported.filter(
        (algorithm): algorithm is string => typeof algorithm === "string"
      )
    : ["RS256"];
  const algorithms = ALLOWED_ID_TOKEN_ALGORITHMS.filter((algorithm) =>
    advertised.includes(algorithm)
  );
  if (algorithms.length === 0) throw new Error("No supported ID token signing algorithm");
  return { authorizationEndpoint, tokenEndpoint, jwksUri, algorithms: [...algorithms] };
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header || header.length > 8192) return null;
  const found: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) found.push(part.slice(separator + 1).trim());
  }
  return found.length === 1 ? found[0] : null;
}

function cookie(
  name: string,
  value: string,
  options: { path: string; maxAge: number; secure: boolean; sameSite: "Lax" | "Strict" }
): string {
  return `${name}=${value}; Path=${options.path}; Max-Age=${options.maxAge}; HttpOnly; SameSite=${options.sameSite}${options.secure ? "; Secure" : ""}`;
}

function withSetCookie(response: Response, setCookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function secureCookie(origin: URL): boolean {
  return origin.protocol === "https:";
}

async function checkLoginRateLimit(
  request: Request,
  db: CloudDb,
  tenantId: string,
  nowMs: number
): Promise<boolean> {
  const address = cloudflareClientIpBucket(request) ?? "unknown";
  const result = await consumeCloudRateLimit(db, {
    tenantId: CLOUD_PLATFORM_TENANT_ID,
    bucketKey: `customer-oidc:${tenantId}:${address}`,
    limit: 20,
    windowMs: 60_000,
    nowMs,
  });
  return result.allowed;
}

async function cleanupOldStates(db: CloudDb, nowMs: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM cloud_tenant_oidc_login_states WHERE rowid IN (
           SELECT rowid FROM cloud_tenant_oidc_login_states
            WHERE expires_at_ms <= ? OR (consumed_at_ms IS NOT NULL AND consumed_at_ms <= ?)
            ORDER BY expires_at_ms, state_hash LIMIT 50
         )`
    )
    .bind(nowMs, nowMs - 60_000)
    .run();
}

async function startLogin(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  const db = options.db;
  if (!db || !options.credentialEncryptionKey)
    return json({ error: "OIDC login unavailable" }, 503);
  const url = new URL(request.url);
  const tenantSelector = url.searchParams.get("tenant");
  if (!tenantSelector || tenantSelector.length > 128)
    return json({ error: "Tenant required" }, 400);
  const tenant = await getCloudTenantBySlug(db, tenantSelector);
  if (!tenant || tenant.kind !== "customer" || !tenant.isActive) {
    return json({ error: "OIDC login unavailable" }, 404);
  }
  if (!(await checkLoginRateLimit(request, db, tenant.id, nowMs))) {
    return json({ error: "OIDC login rate limit exceeded" }, 429);
  }
  const credentials = await getCloudTenantOidcCredentials(
    db,
    options.credentialEncryptionKey,
    tenant.id
  );
  if (!credentials) return json({ error: "OIDC login unavailable" }, 404);

  try {
    const fetcher = options.fetcher ?? fetch;
    const metadata = await discoverOidc(credentials.issuer, origin, fetcher);
    await cleanupOldStates(db, nowMs);
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const stateHash = await sha256(state);
    const nonceHash = await sha256(nonce);
    const redirectUri = new URL(CLOUD_TENANT_OIDC_CALLBACK_PATH, origin).toString();
    const verifierEnvelope = await encryptCloudCredential(
      verifier,
      options.credentialEncryptionKey,
      { tenantId: tenant.id, connectionId: `oidc-state-${stateHash}`, field: "pkceVerifier" }
    );
    await db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_login_states
           (state_hash, tenant_id, issuer, client_id, redirect_uri, authorization_endpoint,
            token_endpoint, jwks_uri, signing_algorithms_json, nonce_hash,
            code_verifier_encrypted, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        stateHash,
        tenant.id,
        credentials.issuer,
        credentials.clientId,
        redirectUri,
        metadata.authorizationEndpoint.toString(),
        metadata.tokenEndpoint.toString(),
        metadata.jwksUri.toString(),
        JSON.stringify(metadata.algorithms),
        nonceHash,
        verifierEnvelope,
        nowMs,
        nowMs + CLOUD_TENANT_OIDC_STATE_TTL_MS
      )
      .run();
    const authorizationUrl = new URL(metadata.authorizationEndpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", credentials.clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set(
      "scope",
      credentials.scopes.includes("openid")
        ? credentials.scopes.join(" ")
        : ["openid", ...credentials.scopes].join(" ")
    );
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set(
      "code_challenge",
      base64Url(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
      )
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    const response = new Response(null, {
      status: 302,
      headers: { Location: authorizationUrl.toString(), "Cache-Control": "no-store" },
    });
    return withSetCookie(
      response,
      cookie(STATE_COOKIE, state, {
        path: SESSION_COOKIE_PATH,
        maxAge: CLOUD_TENANT_OIDC_STATE_TTL_MS / 1000,
        secure: secureCookie(origin),
        sameSite: "Lax",
      })
    );
  } catch {
    return json({ error: "OIDC login unavailable" }, 503);
  }
}

async function consumeState(
  db: CloudDb,
  state: string,
  nowMs: number
): Promise<OidcLoginStateRow | null> {
  if (!TOKEN_PATTERN.test(state)) return null;
  const stateHash = await sha256(state);
  const result = await db
    .prepare(
      `UPDATE cloud_tenant_oidc_login_states SET consumed_at_ms = ?
        WHERE state_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`
    )
    .bind(nowMs, stateHash, nowMs)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) return null;
  return db
    .prepare<OidcLoginStateRow>(
      "SELECT * FROM cloud_tenant_oidc_login_states WHERE state_hash = ? LIMIT 1"
    )
    .bind(stateHash)
    .first();
}

async function callback(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  const db = options.db;
  const state = new URL(request.url).searchParams.get("state") ?? "";
  const code = new URL(request.url).searchParams.get("code") ?? "";
  const stateCookie = getCookie(request, STATE_COOKIE);
  const clearedStateCookie = cookie(STATE_COOKIE, "", {
    path: SESSION_COOKIE_PATH,
    maxAge: 0,
    secure: secureCookie(origin),
    sameSite: "Lax",
  });
  if (!db || !options.credentialEncryptionKey) {
    return withSetCookie(json({ error: "OIDC callback unavailable" }, 503), clearedStateCookie);
  }
  if (
    !stateCookie ||
    stateCookie !== state ||
    !TOKEN_PATTERN.test(state) ||
    !code ||
    code.length > 2048
  ) {
    return withSetCookie(json({ error: "Invalid OIDC response" }, 400), clearedStateCookie);
  }
  let consumed: OidcLoginStateRow | null;
  try {
    consumed = await consumeState(db, state, nowMs);
  } catch {
    consumed = null;
  }
  if (!consumed || consumed.expires_at_ms <= nowMs) {
    return withSetCookie(json({ error: "Invalid or expired OIDC state" }, 400), clearedStateCookie);
  }
  try {
    if (consumed.redirect_uri !== new URL(CLOUD_TENANT_OIDC_CALLBACK_PATH, origin).toString()) {
      throw new Error("redirect URI mismatch");
    }
    const credentials = await getCloudTenantOidcCredentials(
      db,
      options.credentialEncryptionKey,
      consumed.tenant_id
    );
    if (
      !credentials ||
      credentials.issuer !== consumed.issuer ||
      credentials.clientId !== consumed.client_id
    ) {
      throw new Error("OIDC config changed during login");
    }
    const verifier = await decryptCloudCredential(
      consumed.code_verifier_encrypted,
      options.credentialEncryptionKey,
      {
        tenantId: consumed.tenant_id,
        connectionId: `oidc-state-${consumed.state_hash}`,
        field: "pkceVerifier",
      }
    );
    const tokenEndpoint = safeRemoteUrl(consumed.token_endpoint, origin);
    const tokenResponse = await (options.fetcher ?? fetch)(tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: consumed.redirect_uri,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code_verifier: verifier,
      }),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok || (tokenResponse.status >= 300 && tokenResponse.status < 400)) {
      throw new Error("token exchange failed");
    }
    const tokenData = await readJsonBounded(tokenResponse, MAX_TOKEN_RESPONSE_BYTES);
    if (
      !isRecord(tokenData) ||
      typeof tokenData.id_token !== "string" ||
      tokenData.id_token.length > 24_000
    ) {
      throw new Error("ID token missing");
    }
    const jwksUri = safeRemoteUrl(consumed.jwks_uri, origin);
    const jwks = await fetchJson(options.fetcher ?? fetch, jwksUri, MAX_JWKS_BYTES, 5000);
    if (
      !isRecord(jwks) ||
      !Array.isArray(jwks.keys) ||
      jwks.keys.length < 1 ||
      jwks.keys.length > 20
    ) {
      throw new Error("invalid JWKS");
    }
    const algorithms = JSON.parse(consumed.signing_algorithms_json) as unknown;
    if (
      !Array.isArray(algorithms) ||
      algorithms.length < 1 ||
      algorithms.some(
        (algorithm) =>
          typeof algorithm !== "string" ||
          !ALLOWED_ID_TOKEN_ALGORITHMS.includes(
            algorithm as (typeof ALLOWED_ID_TOKEN_ALGORITHMS)[number]
          )
      )
    ) {
      throw new Error("invalid signing algorithm configuration");
    }
    const { payload, protectedHeader } = await jwtVerify(
      tokenData.id_token,
      createLocalJWKSet(jwks as { keys: Record<string, unknown>[] }),
      {
        issuer: consumed.issuer,
        audience: credentials.clientId,
        algorithms: algorithms as string[],
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
        maxTokenAge: "10m",
        currentDate: new Date(nowMs),
      }
    );
    if (
      !algorithms.includes(protectedHeader.alg) ||
      (payload.azp !== undefined && payload.azp !== credentials.clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== credentials.clientId) ||
      typeof payload.iat !== "number" ||
      payload.iat > Math.floor(nowMs / 1000) + 60 ||
      typeof payload.sub !== "string" ||
      payload.sub.length < 1 ||
      payload.sub.length > 512 ||
      typeof payload.nonce !== "string" ||
      (await sha256(payload.nonce)) !== consumed.nonce_hash
    ) {
      throw new Error("ID token claims invalid");
    }
    const identity = await getActiveCloudTenantOidcIdentity(db, {
      tenantId: consumed.tenant_id,
      issuer: consumed.issuer,
      subject: payload.sub,
    });
    if (!identity) throw new Error("Identity is not linked to an active membership");

    const sessionToken = randomToken();
    const tokenHash = await sha256(sessionToken);
    const expiresAtMs = nowMs + CLOUD_TENANT_OIDC_SESSION_TTL_MS;
    await db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_sessions
           (token_hash, tenant_id, membership_id, identity_id, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(tokenHash, identity.tenantId, identity.membershipId, identity.id, nowMs, expiresAtMs)
      .run();
    const response = new Response(null, {
      status: 303,
      headers: {
        Location: new URL(CLOUD_TENANT_OIDC_SESSION_PATH, origin).toString(),
        "Cache-Control": "no-store",
      },
    });
    const withStateCleared = withSetCookie(response, clearedStateCookie);
    return withSetCookie(
      withStateCleared,
      cookie(CLOUD_TENANT_OIDC_SESSION_COOKIE, sessionToken, {
        path: SESSION_COOKIE_PATH,
        maxAge: CLOUD_TENANT_OIDC_SESSION_TTL_MS / 1000,
        secure: secureCookie(origin),
        sameSite: "Lax",
      })
    );
  } catch {
    return withSetCookie(json({ error: "OIDC authentication failed" }, 401), clearedStateCookie);
  }
}

async function introspectSession(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  if (!options.db) return json({ error: "Session service unavailable" }, 503);
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  const token = getCookie(request, CLOUD_TENANT_OIDC_SESSION_COOKIE);
  if (!token || !TOKEN_PATTERN.test(token)) {
    return json({ authenticated: false }, 401, { Vary: "Cookie" });
  }
  const tokenHash = await sha256(token);
  const row = await options.db
    .prepare<OidcSessionRow>(
      `SELECT session.tenant_id, tenant.name AS tenant_name, tenant.slug AS tenant_slug,
              membership.id AS membership_id, membership.principal_id, membership.role,
              identity.id AS identity_id, identity.issuer, identity.subject,
              session.expires_at_ms
         FROM cloud_tenant_oidc_sessions AS session
         JOIN tenants AS tenant ON tenant.id = session.tenant_id
           AND tenant.kind = 'customer' AND tenant.is_active = 1
         JOIN cloud_customer_memberships AS membership
           ON membership.tenant_id = session.tenant_id AND membership.id = session.membership_id
          AND membership.is_active = 1
         JOIN cloud_tenant_oidc_identities AS identity
           ON identity.tenant_id = session.tenant_id AND identity.id = session.identity_id
          AND identity.membership_id = session.membership_id
         JOIN cloud_tenant_oidc_configs AS config
           ON config.tenant_id = identity.tenant_id AND config.issuer = identity.issuer
          AND config.is_enabled = 1
        WHERE session.token_hash = ? AND session.revoked_at_ms IS NULL
          AND session.expires_at_ms > ?
        LIMIT 1`
    )
    .bind(tokenHash, nowMs)
    .first();
  if (!row) return json({ authenticated: false }, 401, { Vary: "Cookie" });
  return json(
    {
      authenticated: true,
      tenant: { id: row.tenant_id, name: row.tenant_name, slug: row.tenant_slug },
      membership: { id: row.membership_id, principalId: row.principal_id, role: row.role },
      identity: { issuer: row.issuer },
      session: { expiresAt: new Date(row.expires_at_ms).toISOString() },
    },
    200,
    { Vary: "Cookie" }
  );
}

/** Called only by the Cloud runtime for the isolated OIDC auth paths. */
export async function handleCloudTenantOidcAuthRequest(
  request: Request,
  options: CloudTenantOidcAuthOptions
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const isLogin = pathname === CLOUD_TENANT_OIDC_LOGIN_PATH;
  const isCallback = pathname === CLOUD_TENANT_OIDC_CALLBACK_PATH;
  const isSession = pathname === CLOUD_TENANT_OIDC_SESSION_PATH;
  if (!isLogin && !isCallback && !isSession) return null;
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const origin = expectedOrigin(request, options);
  if (!origin)
    return json({ error: "OIDC origin is unavailable" }, options.publicOrigin ? 403 : 503);
  const suppliedOrigin = request.headers.get("origin");
  if (suppliedOrigin !== null && suppliedOrigin !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  const nowMs = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return json({ error: "Service unavailable" }, 503);
  if (isLogin) {
    return startLogin(request, options, origin, nowMs);
  }
  if (isCallback) return callback(request, options, origin, nowMs);
  return introspectSession(request, options, origin, nowMs);
}

/** Bounded scheduled cleanup for expired authorization state and revoked sessions. */
export async function cleanupExpiredCloudTenantOidcAuthArtifacts(
  db: CloudDb,
  nowMs = Date.now(),
  batchSize = 500
): Promise<number> {
  const limit = Math.max(1, Math.min(1000, Math.floor(batchSize)));
  const [states, sessions] = await Promise.all([
    db
      .prepare(
        `DELETE FROM cloud_tenant_oidc_login_states WHERE rowid IN (
           SELECT rowid FROM cloud_tenant_oidc_login_states
            WHERE expires_at_ms <= ? OR (consumed_at_ms IS NOT NULL AND consumed_at_ms <= ?)
            ORDER BY expires_at_ms, state_hash LIMIT ?
         )`
      )
      .bind(nowMs, nowMs - 60_000, limit)
      .run(),
    db
      .prepare(
        `DELETE FROM cloud_tenant_oidc_sessions WHERE rowid IN (
           SELECT rowid FROM cloud_tenant_oidc_sessions
            WHERE expires_at_ms <= ? OR (revoked_at_ms IS NOT NULL AND revoked_at_ms <= ?)
            ORDER BY expires_at_ms, token_hash LIMIT ?
         )`
      )
      .bind(nowMs - 24 * 60 * 60 * 1000, nowMs - 24 * 60 * 60 * 1000, limit)
      .run(),
  ]);
  return Number(states.meta?.changes ?? 0) + Number(sessions.meta?.changes ?? 0);
}
