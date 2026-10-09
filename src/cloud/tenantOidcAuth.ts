import { createLocalJWKSet, jwtVerify } from "jose";
import type { CloudDb } from "./db";
import { encryptCloudCredential, decryptCloudCredential } from "./credentialEncryption";
import {
  CloudMembershipConflictError,
  CloudLastActiveOwnerError,
  getCloudCustomerMembership,
  issueCloudCustomerApiKey,
  revokeCloudCustomerApiKey,
  updateCloudCustomerMembership,
  type CloudCustomerRole,
} from "./customerIdentity";
import { CLOUD_PLATFORM_TENANT_ID, getCloudTenantById, getCloudTenantBySlug } from "./tenants";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";
import { getActiveCloudTenantOidcIdentity, getCloudTenantOidcCredentials } from "./tenantOidc";
import {
  acceptCloudTenantMembershipInvitation,
  cleanupExpiredCloudTenantMembershipInvitations,
  createCloudTenantMembershipInvitation,
  getPendingCloudTenantMembershipInvitation,
  CLOUD_TENANT_MEMBERSHIP_INVITATION_TTL_MS,
} from "./tenantMembershipInvitations";
import { listCloudTenantPortalMembers } from "./tenantMembershipManagement";
import { CLOUD_CUSTOMER_PORTAL_PATH } from "./customerPortal";
import {
  getCloudCustomerBusinessProfile,
  updateCloudCustomerBusinessProfile,
} from "./customerBusinessProfile";
import { validateCloudCustomerBusinessProfile } from "./customerBusinessProfileHttpApi";
import {
  CLOUD_CUSTOMER_PROVIDER_PORTAL_CONNECTIONS_PATH,
  handleCloudCustomerProviderPortalRequest,
} from "./customerProviderHttpApi";
import { handleCloudTenantMcpPortalRequest } from "./tenantMcpHttpApi";
import { getCloudCustomerOnboardingReadiness } from "./tenantOnboardingHttpApi";
import { readCloudCustomerSettingsBody } from "./tenantSettingsHttpApi";
import { updateCloudTenantSettings } from "./tenantSettings";
import {
  acceptCloudTenantOidcOwnerClaim,
  getPendingCloudTenantOidcOwnerClaim,
  getPendingCloudTenantOidcOwnerClaimByHash,
  hashCloudTenantOidcOwnerClaim,
} from "./tenantOidcOwnerClaims";

export const CLOUD_TENANT_OIDC_LOGIN_PATH = "/__cloud/auth/oidc/login";
export const CLOUD_TENANT_OIDC_CALLBACK_PATH = "/__cloud/auth/oidc/callback";
export const CLOUD_TENANT_OIDC_SESSION_PATH = "/__cloud/auth/session";
export const CLOUD_TENANT_OIDC_LOGOUT_PATH = "/__cloud/auth/logout";
export const CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH = "/__cloud/auth/members/invitations";
export const CLOUD_TENANT_MEMBERSHIP_INVITATION_REDEEM_PATH =
  "/__cloud/auth/oidc/invitations/redeem";
export const CLOUD_TENANT_OIDC_OWNER_CLAIM_REDEEM_PATH = "/__cloud/auth/oidc/owner/claim";
export const CLOUD_TENANT_MEMBERS_PATH = "/__cloud/auth/members";
export const CLOUD_TENANT_API_KEYS_PATH = "/__cloud/auth/api-keys";
export const CLOUD_TENANT_BUSINESS_PROFILE_PATH = "/__cloud/auth/business-profile";
export const CLOUD_TENANT_PROVIDER_CONNECTIONS_PATH =
  CLOUD_CUSTOMER_PROVIDER_PORTAL_CONNECTIONS_PATH;
export const CLOUD_TENANT_MCP_SERVERS_PATH = "/__cloud/auth/mcp-servers";
export const CLOUD_TENANT_ONBOARDING_PATH = "/__cloud/auth/onboarding";
export const CLOUD_TENANT_MCP_SETTINGS_PATH = "/__cloud/auth/mcp-settings";
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
  invitation_hash: string | null;
  owner_bootstrap_hash: string | null;
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

interface ResolvedOidcSessionRow extends OidcSessionRow {
  session_token_hash: string;
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
  const url = new URL(request.url);
  const tenantSelector = url.searchParams.get("tenant");
  if (!tenantSelector || tenantSelector.length > 128)
    return json({ error: "Tenant required" }, 400);
  const tenant = options.db ? await getCloudTenantBySlug(options.db, tenantSelector) : null;
  if (!tenant || tenant.kind !== "customer" || !tenant.isActive) {
    return json({ error: "OIDC login unavailable" }, 404);
  }
  return startLoginForTenant(request, options, origin, nowMs, tenant.id, null, null, false);
}

async function startLoginForTenant(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number,
  tenantId: string,
  invitationHash: string | null,
  ownerBootstrapHash: string | null,
  returnAuthorizationUrl: boolean
): Promise<Response> {
  const db = options.db;
  if (!db || !options.credentialEncryptionKey)
    return json({ error: "OIDC login unavailable" }, 503);
  const tenant = await getCloudTenantById(db, tenantId);
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
            code_verifier_encrypted, created_at_ms, expires_at_ms, invitation_hash,
            owner_bootstrap_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        nowMs + CLOUD_TENANT_OIDC_STATE_TTL_MS,
        invitationHash,
        ownerBootstrapHash
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
    const response = returnAuthorizationUrl
      ? json({ authorizationUrl: authorizationUrl.toString() })
      : new Response(null, {
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
    let identity: Awaited<ReturnType<typeof getActiveCloudTenantOidcIdentity>>;
    if (consumed.invitation_hash) {
      const invitation = await getPendingCloudTenantMembershipInvitation(
        db,
        consumed.invitation_hash,
        nowMs
      );
      if (
        !invitation ||
        invitation.tenantId !== consumed.tenant_id ||
        invitation.issuer !== consumed.issuer
      ) {
        throw new Error("Invitation is unavailable");
      }
      const accepted = await acceptCloudTenantMembershipInvitation(db, {
        codeHash: consumed.invitation_hash,
        invitation,
        issuer: consumed.issuer,
        subject: payload.sub,
        nowMs,
      });
      if (!accepted) throw new Error("Invitation is unavailable");
      identity = {
        id: accepted.identityId,
        tenantId: invitation.tenantId,
        issuer: invitation.issuer,
        subject: payload.sub,
        membershipId: accepted.membershipId,
        principalId: accepted.principalId,
        role: invitation.role,
        createdAt: new Date(nowMs).toISOString(),
      };
    } else if (consumed.owner_bootstrap_hash) {
      const claim = await getPendingCloudTenantOidcOwnerClaim(db, {
        tenantId: consumed.tenant_id,
        codeHash: consumed.owner_bootstrap_hash,
        nowMs,
      });
      if (!claim || claim.issuer !== consumed.issuer) {
        throw new Error("First-owner claim is unavailable");
      }
      const accepted = await acceptCloudTenantOidcOwnerClaim(db, {
        tenantId: consumed.tenant_id,
        codeHash: consumed.owner_bootstrap_hash,
        claim,
        issuer: consumed.issuer,
        subject: payload.sub,
        nowMs,
      });
      if (!accepted) throw new Error("First-owner claim is unavailable");
      identity = {
        id: accepted.identityId,
        tenantId: consumed.tenant_id,
        issuer: consumed.issuer,
        subject: payload.sub,
        membershipId: accepted.membershipId,
        principalId: accepted.principalId,
        role: "owner",
        createdAt: new Date(nowMs).toISOString(),
      };
    } else {
      identity = await getActiveCloudTenantOidcIdentity(db, {
        tenantId: consumed.tenant_id,
        issuer: consumed.issuer,
        subject: payload.sub,
      });
    }
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
        Location: new URL(CLOUD_CUSTOMER_PORTAL_PATH, origin).toString(),
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

async function logoutSession(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  if (request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }

  const expiredCookie = cookie(CLOUD_TENANT_OIDC_SESSION_COOKIE, "", {
    path: SESSION_COOKIE_PATH,
    maxAge: 0,
    secure: secureCookie(origin),
    sameSite: "Lax",
  });
  const response = (result: Response) => withSetCookie(result, expiredCookie);
  if (!options.db) return response(json({ error: "Session service unavailable" }, 503));

  const token = getCookie(request, CLOUD_TENANT_OIDC_SESSION_COOKIE);
  if (token && TOKEN_PATTERN.test(token)) {
    try {
      const result = await options.db
        .prepare(
          `UPDATE cloud_tenant_oidc_sessions SET revoked_at_ms = ?
            WHERE token_hash = ? AND revoked_at_ms IS NULL`
        )
        .bind(nowMs, await sha256(token))
        .run();
      if (!result.success) return response(json({ error: "Session service unavailable" }, 503));
    } catch {
      return response(json({ error: "Session service unavailable" }, 503));
    }
  }
  return response(json({ loggedOut: true }));
}

async function resolveSession(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  nowMs: number
): Promise<ResolvedOidcSessionRow | null> {
  if (!options.db) return null;
  const token = getCookie(request, CLOUD_TENANT_OIDC_SESSION_COOKIE);
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const tokenHash = await sha256(token);
  return options.db
    .prepare<ResolvedOidcSessionRow>(
      `SELECT session.tenant_id, tenant.name AS tenant_name, tenant.slug AS tenant_slug,
              membership.id AS membership_id, membership.principal_id, membership.role,
              identity.id AS identity_id, identity.issuer, identity.subject,
              session.expires_at_ms, session.token_hash AS session_token_hash
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
}

async function requireMembershipManager(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  nowMs: number
): Promise<ResolvedOidcSessionRow | null> {
  const session = await resolveSession(request, options, nowMs);
  if (!session || (session.role !== "owner" && session.role !== "admin")) return null;
  return session;
}

async function checkMembershipPortalRateLimit(
  db: CloudDb,
  session: OidcSessionRow,
  action: "list" | "update",
  nowMs: number
): Promise<boolean> {
  const result = await consumeCloudRateLimit(db, {
    tenantId: CLOUD_PLATFORM_TENANT_ID,
    bucketKey: `customer-membership:${action}:${session.tenant_id}:${session.membership_id}`,
    limit: action === "list" ? 120 : 30,
    windowMs: 60_000,
    nowMs,
  });
  return result.allowed;
}

async function customerBusinessProfilePortal(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  const db = options.db;
  if (!db) return json({ error: "Business profile service unavailable" }, 503);
  if (request.method !== "GET" && request.method !== "PUT") {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
  }
  if (request.method === "PUT" && request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  const session = await requireMembershipManager(request, options, nowMs);
  if (!session) return json({ error: "Owner or admin session required" }, 403);
  const limit = await consumeCloudRateLimit(db, {
    tenantId: CLOUD_PLATFORM_TENANT_ID,
    bucketKey: `customer-business-profile-portal:${session.tenant_id}:${session.membership_id}`,
    limit: request.method === "GET" ? 120 : 30,
    windowMs: 60_000,
    nowMs,
  });
  if (!limit.allowed) return json({ error: "Business profile rate limit exceeded" }, 429);
  if (request.method === "GET") {
    const profile = await getCloudCustomerBusinessProfile(db, session.tenant_id);
    return profile ? json(profile) : json({ error: "Business profile unavailable" }, 503);
  }
  if (
    request.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    return json({ error: "JSON body required" }, 415);
  }
  let body: unknown;
  try {
    body = await readJsonBounded(new Response(request.body), 24 * 1024);
  } catch {
    return json({ error: "Invalid business profile body" }, 400);
  }
  const profile = validateCloudCustomerBusinessProfile(body);
  if (!profile) return json({ error: "Invalid business profile" }, 400);
  const updatedAt = new Date(nowMs).toISOString();
  const result = await updateCloudCustomerBusinessProfile(db, {
    tenantId: session.tenant_id,
    membershipId: session.membership_id,
    profile,
    updatedAt,
    audit: {
      id: crypto.randomUUID(),
      tenantId: session.tenant_id,
      timestamp: updatedAt,
      action: "customer.business_profile.portal.update",
      actor: `membership:${session.membership_id}`,
      target: "tenant-business-profile",
      resourceType: "customer-business-profile",
      status: "success",
      requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
      metadata: { serviceCount: profile.services.length },
    },
  });
  return result ? json(result) : json({ error: "Owner or admin session required" }, 403);
}

async function customerProviderConnectionsPortal(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  const session = await requireMembershipManager(request, options, nowMs);
  if (!session) return json({ error: "Owner or admin session required" }, 403);
  if (request.method !== "GET" && request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  const response = await handleCloudCustomerProviderPortalRequest(
    request,
    {
      db: options.db,
      credentialEncryptionKey: options.credentialEncryptionKey,
      now: () => new Date(nowMs),
    },
    {
      tenantId: session.tenant_id,
      principalId: session.principal_id,
      role: session.role,
    }
  );
  return response ?? json({ error: "Not found" }, 404);
}

async function customerMcpServersPortal(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  const session = await requireMembershipManager(request, options, nowMs);
  if (!session) return json({ error: "Owner or admin session required" }, 403);
  if (request.method !== "GET" && request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  const response = await handleCloudTenantMcpPortalRequest(
    request,
    {
      db: options.db,
      credentialEncryptionKey: options.credentialEncryptionKey,
      now: () => new Date(nowMs),
    },
    {
      tenantId: session.tenant_id,
      principalId: session.principal_id,
      membershipId: session.membership_id,
      role: session.role,
      sessionTokenHash: session.session_token_hash,
    }
  );
  return response ?? json({ error: "Not found" }, 404);
}

async function customerOnboardingReadinessPortal(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  nowMs: number
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (new URL(request.url).search !== "") {
    return json({ error: "Query parameters are not supported" }, 400);
  }
  if (!options.db) return json({ error: "Customer onboarding status is unavailable" }, 503);
  const session = await requireMembershipManager(request, options, nowMs);
  if (!session) return json({ error: "Owner or admin session required" }, 403);
  try {
    const limit = await consumeCloudRateLimit(options.db, {
      tenantId: CLOUD_PLATFORM_TENANT_ID,
      bucketKey: `customer-onboarding-portal:${session.tenant_id}:${session.membership_id}`,
      limit: 60,
      windowMs: 60_000,
      nowMs,
    });
    if (!limit.allowed) return json({ error: "Customer onboarding rate limit exceeded" }, 429);
    const readiness = await getCloudCustomerOnboardingReadiness(options.db, session.tenant_id);
    return readiness
      ? json(readiness)
      : json({ error: "Customer onboarding status is unavailable" }, 503);
  } catch {
    return json({ error: "Customer onboarding status is unavailable" }, 503);
  }
}

async function customerMcpSettingsPortal(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (new URL(request.url).search !== "") {
    return json({ error: "Query parameters are not supported" }, 400);
  }
  if (request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  if (!options.db) return json({ error: "MCP settings are unavailable" }, 503);
  const session = await requireMembershipManager(request, options, nowMs);
  if (!session) return json({ error: "Owner or admin session required" }, 403);
  const limit = await consumeCloudRateLimit(options.db, {
    tenantId: CLOUD_PLATFORM_TENANT_ID,
    bucketKey: `customer-mcp-settings-portal:${session.tenant_id}:${session.membership_id}`,
    limit: 30,
    windowMs: 60_000,
    nowMs,
  });
  if (!limit.allowed) return json({ error: "MCP settings rate limit exceeded" }, 429);
  if (
    request.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    return json({ error: "JSON body required" }, 415);
  }
  const body = await readCloudCustomerSettingsBody(request, 5_000);
  if (body instanceof Response) return body;
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as Record<string, unknown>).mcpEnabled !== "boolean"
  ) {
    return json({ error: "Expected only an mcpEnabled boolean" }, 400);
  }
  const mcpEnabled = (body as { mcpEnabled: boolean }).mcpEnabled;
  const timestamp = new Date(nowMs).toISOString();
  try {
    const settings = await updateCloudTenantSettings(options.db, {
      tenantId: session.tenant_id,
      membershipId: session.membership_id,
      authorization: {
        type: "oidc_session",
        sessionTokenHash: session.session_token_hash,
      },
      mcpEnabled,
      updatedAt: timestamp,
      audit: {
        id: crypto.randomUUID(),
        tenantId: session.tenant_id,
        timestamp,
        action: "customer.settings.mcp_portal.update",
        actor: `membership:${session.membership_id}`,
        target: "tenant-mcp-opt-in",
        resourceType: "customer-setting",
        status: "success",
        requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
        metadata: { mcpEnabled },
      },
    });
    return settings
      ? json({ mcpEnabled: settings.mcpEnabled })
      : json({ error: "Owner or admin session required" }, 403);
  } catch {
    return json({ error: "MCP settings could not be updated" }, 503);
  }
}

async function listMemberships(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  nowMs: number
): Promise<Response> {
  if (!options.db) return json({ error: "Membership service unavailable" }, 503);
  const session = await requireMembershipManager(request, options, nowMs);
  if (!session) return json({ error: "Owner or admin session required" }, 403);
  if (!(await checkMembershipPortalRateLimit(options.db, session, "list", nowMs))) {
    return json({ error: "Membership read rate limit exceeded" }, 429);
  }
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (key !== "limit" && key !== "cursor") return json({ error: "Invalid query parameter" }, 400);
  }
  const limitValues = url.searchParams.getAll("limit");
  const cursorValues = url.searchParams.getAll("cursor");
  if (limitValues.length > 1 || cursorValues.length > 1) {
    return json({ error: "Invalid query parameter" }, 400);
  }
  let limit = 50;
  if (limitValues.length === 1) {
    const value = limitValues[0] ?? "";
    if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) {
      return json({ error: "Invalid page limit" }, 400);
    }
    limit = Number(value);
  }
  const cursor = cursorValues[0];
  try {
    return json(await listCloudTenantPortalMembers(options.db, session.tenant_id, limit, cursor));
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return json({ error: "Invalid membership cursor" }, 400);
    }
    throw error;
  }
}

async function updateMembership(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number,
  membershipId: string
): Promise<Response> {
  const db = options.db;
  if (!db) return json({ error: "Membership service unavailable" }, 503);
  if (request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  const session = await requireMembershipManager(request, options, nowMs);
  if (!session) return json({ error: "Owner or admin session required" }, 403);
  if (!(await checkMembershipPortalRateLimit(db, session, "update", nowMs))) {
    return json({ error: "Membership update rate limit exceeded" }, 429);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(membershipId))
    return json({ error: "Membership not found" }, 404);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "JSON body required" }, 415);
  }
  let body: unknown;
  try {
    body = await readJsonBounded(new Response(request.body), 2048);
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  if (
    !isRecord(body) ||
    Object.keys(body).some(
      (key) => key !== "role" && key !== "isActive" && key !== "expectedUpdatedAt"
    ) ||
    (body.role === undefined && body.isActive === undefined) ||
    typeof body.expectedUpdatedAt !== "string" ||
    body.expectedUpdatedAt.length > 64 ||
    !Number.isFinite(Date.parse(body.expectedUpdatedAt)) ||
    new Date(body.expectedUpdatedAt).toISOString() !== body.expectedUpdatedAt
  ) {
    return json({ error: "Expected a valid expectedUpdatedAt and role and/or isActive" }, 400);
  }
  if (
    body.role !== undefined &&
    body.role !== "admin" &&
    body.role !== "member" &&
    body.role !== "viewer"
  ) {
    return json({ error: "Invalid customer role" }, 400);
  }
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    return json({ error: "isActive must be a boolean" }, 400);
  }
  const current = await getCloudCustomerMembership(db, session.tenant_id, membershipId);
  if (!current) return json({ error: "Membership not found" }, 404);
  if (current.updatedAt !== body.expectedUpdatedAt) {
    return json({ error: "Membership changed; reload and retry" }, 409);
  }
  if (session.role === "admin" && current.role === "owner") {
    return json({ error: "Admins cannot modify owner memberships" }, 403);
  }
  const nextRole = (body.role as CloudCustomerRole | undefined) ?? current.role;
  const nextActive = (body.isActive as boolean | undefined) ?? current.isActive;
  const timestamp = new Date(Math.max(nowMs, Date.parse(current.updatedAt) + 1)).toISOString();
  const requestId = request.headers.get("cf-ray") ?? request.headers.get("x-request-id");
  const changedFields: string[] = [];
  if (current.role !== nextRole) changedFields.push("role");
  if (current.isActive !== nextActive) changedFields.push("isActive");
  let updated;
  try {
    updated = await updateCloudCustomerMembership(db, {
      tenantId: session.tenant_id,
      membershipId,
      role: nextRole,
      isActive: nextActive,
      expectedUpdatedAt: body.expectedUpdatedAt,
      actorMembershipId: session.membership_id,
      audit: {
        id: crypto.randomUUID(),
        tenantId: session.tenant_id,
        timestamp,
        action: "customer.membership.portal.update",
        actor: session.membership_id,
        target: membershipId,
        resourceType: "customer-membership",
        status: "success",
        requestId: requestId && requestId.length <= 512 ? requestId : null,
        metadata: { role: nextRole, isActive: nextActive, changedFields },
      },
      now: timestamp,
    });
  } catch (error) {
    if (error instanceof CloudMembershipConflictError) {
      return json({ error: "Membership changed; reload and retry" }, 409);
    }
    if (error instanceof CloudLastActiveOwnerError) {
      return json({ error: "At least one active owner must remain" }, 409);
    }
    throw error;
  }
  if (!updated) return json({ error: "Membership not found" }, 404);
  return json({
    id: updated.id,
    role: updated.role,
    isActive: updated.isActive,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  });
}

async function checkPortalApiKeyRateLimit(
  db: CloudDb,
  session: OidcSessionRow,
  action: "list" | "write",
  nowMs: number
): Promise<boolean> {
  const result = await consumeCloudRateLimit(db, {
    tenantId: CLOUD_PLATFORM_TENANT_ID,
    bucketKey: `customer-api-key:${action}:${session.tenant_id}:${session.membership_id}`,
    limit: action === "list" ? 60 : 20,
    windowMs: 60_000,
    nowMs,
  });
  return result.allowed;
}

async function listPortalApiKeys(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  nowMs: number
): Promise<Response> {
  const db = options.db;
  if (!db) return json({ error: "API key service unavailable" }, 503);
  const session = await requireMembershipManager(request, options, nowMs);
  if (!session) return json({ error: "Owner or admin session required" }, 403);
  if (!(await checkPortalApiKeyRateLimit(db, session, "list", nowMs))) {
    return json({ error: "API key read rate limit exceeded" }, 429);
  }
  const rows = await db
    .prepare<{
      id: string;
      created_at: string;
      expires_at: string | null;
      revoked_at: string | null;
    }>(
      `SELECT id, created_at, expires_at, revoked_at
         FROM cloud_customer_api_keys
        WHERE tenant_id = ? AND membership_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 100`
    )
    .bind(session.tenant_id, session.membership_id)
    .all();
  if (!rows.success) return json({ error: "API key service unavailable" }, 503);
  return json({
    keys: rows.results.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    })),
  });
}

async function createPortalApiKey(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  const db = options.db;
  if (!db) return json({ error: "API key service unavailable" }, 503);
  if (request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  const session = await requireMembershipManager(request, options, nowMs);
  if (!session) return json({ error: "Owner or admin session required" }, 403);
  if (!(await checkPortalApiKeyRateLimit(db, session, "write", nowMs))) {
    return json({ error: "API key write rate limit exceeded" }, 429);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "JSON body required" }, 415);
  }
  let body: unknown;
  try {
    body = await readJsonBounded(new Response(request.body), 2048);
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => key !== "expiresAt") ||
    (body.expiresAt !== undefined && body.expiresAt !== null && typeof body.expiresAt !== "string")
  ) {
    return json({ error: "Invalid API key request" }, 400);
  }
  const timestamp = new Date(nowMs).toISOString();
  const expiresAt = body.expiresAt as string | null | undefined;
  const requestId = request.headers.get("cf-ray") ?? request.headers.get("x-request-id");
  try {
    const key = await issueCloudCustomerApiKey(db, {
      tenantId: session.tenant_id,
      membershipId: session.membership_id,
      expiresAt,
      now: timestamp,
      audit: {
        id: crypto.randomUUID(),
        tenantId: session.tenant_id,
        timestamp,
        action: "customer.api_key.portal.create",
        actor: session.membership_id,
        target: "self",
        resourceType: "customer-api-key",
        status: "success",
        requestId: requestId && requestId.length <= 512 ? requestId : null,
        metadata: { expiresAt: expiresAt ?? null },
      },
    });
    return json(
      { key: { id: key.id, createdAt: key.createdAt, expiresAt: key.expiresAt, token: key.token } },
      201
    );
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return json({ error: "Invalid API key expiry" }, 400);
    }
    throw error;
  }
}

async function revokePortalApiKey(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number,
  apiKeyId: string
): Promise<Response> {
  const db = options.db;
  if (!db) return json({ error: "API key service unavailable" }, 503);
  if (request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  const session = await requireMembershipManager(request, options, nowMs);
  if (!session) return json({ error: "Owner or admin session required" }, 403);
  if (!(await checkPortalApiKeyRateLimit(db, session, "write", nowMs))) {
    return json({ error: "API key write rate limit exceeded" }, 429);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(apiKeyId)) return json({ error: "API key not found" }, 404);
  const timestamp = new Date(nowMs).toISOString();
  const requestId = request.headers.get("cf-ray") ?? request.headers.get("x-request-id");
  const revoked = await revokeCloudCustomerApiKey(db, {
    tenantId: session.tenant_id,
    apiKeyId,
    membershipId: session.membership_id,
    now: timestamp,
    audit: {
      id: crypto.randomUUID(),
      tenantId: session.tenant_id,
      timestamp,
      action: "customer.api_key.portal.revoke",
      actor: session.membership_id,
      target: apiKeyId,
      resourceType: "customer-api-key",
      status: "success",
      requestId: requestId && requestId.length <= 512 ? requestId : null,
      metadata: {},
    },
  });
  return revoked
    ? json({ id: apiKeyId, revokedAt: timestamp })
    : json({ error: "API key not found" }, 404);
}

async function createMembershipInvitation(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  const db = options.db;
  if (!db) return json({ error: "Invitation service unavailable" }, 503);
  if (request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "JSON body required" }, 415);
  }
  let body: unknown;
  try {
    body = await readJsonBounded(new Response(request.body), 2048);
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    (body.role !== "admin" && body.role !== "member" && body.role !== "viewer")
  ) {
    return json({ error: "Invalid membership role" }, 400);
  }
  const session = await resolveSession(request, options, nowMs);
  if (!session || (session.role !== "owner" && session.role !== "admin")) {
    return json({ error: "Owner or admin session required" }, 403);
  }
  const limit = await consumeCloudRateLimit(db, {
    tenantId: CLOUD_PLATFORM_TENANT_ID,
    bucketKey: `customer-membership-invite:${session.tenant_id}:${session.membership_id}`,
    limit: 20,
    windowMs: 60 * 60 * 1000,
    nowMs,
  });
  if (!limit.allowed) return json({ error: "Invitation rate limit exceeded" }, 429);

  const code = randomToken();
  const codeHash = await sha256(code);
  const invitationId = crypto.randomUUID();
  const expiresAtMs = nowMs + CLOUD_TENANT_MEMBERSHIP_INVITATION_TTL_MS;
  const created = await createCloudTenantMembershipInvitation(db, {
    id: invitationId,
    codeHash,
    tenantId: session.tenant_id,
    issuer: session.issuer,
    issuerMembershipId: session.membership_id,
    role: body.role,
    nowMs,
    expiresAtMs,
  });
  if (!created) return json({ error: "Invitation could not be created" }, 409);
  return json(
    {
      code,
      role: body.role,
      expiresAt: new Date(expiresAtMs).toISOString(),
      redeemPath: CLOUD_TENANT_MEMBERSHIP_INVITATION_REDEEM_PATH,
    },
    201
  );
}

async function redeemMembershipInvitation(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  const db = options.db;
  if (!db) return json({ error: "Invitation service unavailable" }, 503);
  if (request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "JSON body required" }, 415);
  }
  let body: unknown;
  try {
    body = await readJsonBounded(new Response(request.body), 2048);
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.code !== "string" ||
    !TOKEN_PATTERN.test(body.code)
  ) {
    return json({ error: "Invalid invitation code" }, 400);
  }
  const limit = await consumeCloudRateLimit(db, {
    tenantId: CLOUD_PLATFORM_TENANT_ID,
    bucketKey: `customer-oidc-invite-redeem:${cloudflareClientIpBucket(request) ?? "unknown"}`,
    limit: 20,
    windowMs: 60_000,
    nowMs,
  });
  if (!limit.allowed) return json({ error: "Invitation redemption rate limit exceeded" }, 429);
  const codeHash = await sha256(body.code);
  const invitation = await getPendingCloudTenantMembershipInvitation(db, codeHash, nowMs);
  if (!invitation) return json({ error: "Invitation is invalid or expired" }, 400);
  return startLoginForTenant(
    request,
    options,
    origin,
    nowMs,
    invitation.tenantId,
    codeHash,
    null,
    true
  );
}

async function redeemFirstOwnerClaim(
  request: Request,
  options: CloudTenantOidcAuthOptions,
  origin: URL,
  nowMs: number
): Promise<Response> {
  const db = options.db;
  if (!db) return json({ error: "First-owner claim service unavailable" }, 503);
  if (request.headers.get("origin") !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "JSON body required" }, 415);
  }
  let body: unknown;
  try {
    body = await readJsonBounded(new Response(request.body), 2048);
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.code !== "string" ||
    !TOKEN_PATTERN.test(body.code)
  ) {
    return json({ error: "Invalid first-owner claim" }, 400);
  }
  const limit = await consumeCloudRateLimit(db, {
    tenantId: CLOUD_PLATFORM_TENANT_ID,
    bucketKey: `customer-oidc-owner-claim:${cloudflareClientIpBucket(request) ?? "unknown"}`,
    limit: 10,
    windowMs: 60_000,
    nowMs,
  });
  if (!limit.allowed) return json({ error: "First-owner claim rate limit exceeded" }, 429);
  const codeHash = await hashCloudTenantOidcOwnerClaim(body.code);
  const claim = await getPendingCloudTenantOidcOwnerClaimByHash(db, codeHash, nowMs);
  if (!claim) return json({ error: "First-owner claim is invalid or expired" }, 400);
  return startLoginForTenant(request, options, origin, nowMs, claim.tenantId, null, codeHash, true);
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
  const isLogout = pathname === CLOUD_TENANT_OIDC_LOGOUT_PATH;
  const isMembers = pathname === CLOUD_TENANT_MEMBERS_PATH;
  const isMemberItem = pathname.startsWith(`${CLOUD_TENANT_MEMBERS_PATH}/`);
  const isApiKeyCollection = pathname === CLOUD_TENANT_API_KEYS_PATH;
  const isApiKeyItem = pathname.startsWith(`${CLOUD_TENANT_API_KEYS_PATH}/`);
  const isBusinessProfile = pathname === CLOUD_TENANT_BUSINESS_PROFILE_PATH;
  const isProviderConnections =
    pathname === CLOUD_TENANT_PROVIDER_CONNECTIONS_PATH ||
    pathname.startsWith(`${CLOUD_TENANT_PROVIDER_CONNECTIONS_PATH}/`);
  const isMcpServers =
    pathname === CLOUD_TENANT_MCP_SERVERS_PATH ||
    pathname.startsWith(`${CLOUD_TENANT_MCP_SERVERS_PATH}/`);
  const isOnboarding = pathname === CLOUD_TENANT_ONBOARDING_PATH;
  const isMcpSettings = pathname === CLOUD_TENANT_MCP_SETTINGS_PATH;
  const isCreateInvitation = pathname === CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH;
  const isRedeemInvitation = pathname === CLOUD_TENANT_MEMBERSHIP_INVITATION_REDEEM_PATH;
  const isRedeemOwnerClaim = pathname === CLOUD_TENANT_OIDC_OWNER_CLAIM_REDEEM_PATH;
  if (
    !isLogin &&
    !isCallback &&
    !isSession &&
    !isLogout &&
    !isMembers &&
    !isMemberItem &&
    !isApiKeyCollection &&
    !isApiKeyItem &&
    !isBusinessProfile &&
    !isProviderConnections &&
    !isMcpServers &&
    !isOnboarding &&
    !isMcpSettings &&
    !isCreateInvitation &&
    !isRedeemInvitation &&
    !isRedeemOwnerClaim
  ) {
    return null;
  }
  const expectedMethod =
    isApiKeyCollection || isApiKeyItem || isBusinessProfile || isProviderConnections
      ? ""
      : isCreateInvitation || isRedeemInvitation || isRedeemOwnerClaim || isLogout
        ? "POST"
        : isMemberItem
          ? "PATCH"
          : "GET";
  const allowedMethods = isApiKeyCollection
    ? ["GET", "POST"]
    : isApiKeyItem
      ? ["DELETE"]
      : isBusinessProfile
        ? ["GET", "PUT"]
        : isProviderConnections
          ? ["GET", "POST", "PATCH", "DELETE"]
          : isMcpServers
            ? ["GET", "POST", "PUT", "DELETE"]
            : isOnboarding
              ? ["GET"]
              : isMcpSettings
                ? ["PUT"]
                : [expectedMethod];
  if (!allowedMethods.includes(request.method)) {
    return json({ error: "Method not allowed" }, 405, { Allow: allowedMethods.join(", ") });
  }
  const origin = expectedOrigin(request, options);
  if (!origin)
    return json({ error: "OIDC origin is unavailable" }, options.publicOrigin ? 403 : 503);
  const suppliedOrigin = request.headers.get("origin");
  if (suppliedOrigin !== null && suppliedOrigin !== origin.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  const nowMs = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return json({ error: "Service unavailable" }, 503);
  if (isBusinessProfile) return customerBusinessProfilePortal(request, options, origin, nowMs);
  if (isProviderConnections)
    return customerProviderConnectionsPortal(request, options, origin, nowMs);
  if (isMcpServers) return customerMcpServersPortal(request, options, origin, nowMs);
  if (isOnboarding) return customerOnboardingReadinessPortal(request, options, nowMs);
  if (isMcpSettings) return customerMcpSettingsPortal(request, options, origin, nowMs);
  if (isLogin) {
    return startLogin(request, options, origin, nowMs);
  }
  if (isCallback) return callback(request, options, origin, nowMs);
  if (isCreateInvitation) return createMembershipInvitation(request, options, origin, nowMs);
  if (isApiKeyCollection) {
    return request.method === "POST"
      ? createPortalApiKey(request, options, origin, nowMs)
      : listPortalApiKeys(request, options, nowMs);
  }
  if (isApiKeyItem) {
    return revokePortalApiKey(
      request,
      options,
      origin,
      nowMs,
      pathname.slice(`${CLOUD_TENANT_API_KEYS_PATH}/`.length)
    );
  }
  if (isRedeemInvitation) return redeemMembershipInvitation(request, options, origin, nowMs);
  if (isRedeemOwnerClaim) return redeemFirstOwnerClaim(request, options, origin, nowMs);
  if (isLogout) return logoutSession(request, options, origin, nowMs);
  if (isMembers) return listMemberships(request, options, nowMs);
  if (isMemberItem) {
    return updateMembership(
      request,
      options,
      origin,
      nowMs,
      pathname.slice(`${CLOUD_TENANT_MEMBERS_PATH}/`.length)
    );
  }
  return introspectSession(request, options, origin, nowMs);
}

/** Bounded scheduled cleanup for expired authorization state and revoked sessions. */
export async function cleanupExpiredCloudTenantOidcAuthArtifacts(
  db: CloudDb,
  nowMs = Date.now(),
  batchSize = 500
): Promise<number> {
  const limit = Math.max(1, Math.min(1000, Math.floor(batchSize)));
  const [states, sessions, invitations] = await Promise.all([
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
    cleanupExpiredCloudTenantMembershipInvitations(db, nowMs, limit),
  ]);
  return Number(states.meta?.changes ?? 0) + Number(sessions.meta?.changes ?? 0) + invitations;
}
