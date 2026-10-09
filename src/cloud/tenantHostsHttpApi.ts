import { prepareCloudComplianceAuditInsert } from "./complianceAudit";
import type { CloudDb } from "./db";
import { consumeCloudRateLimit } from "./rateLimit";
import {
  resolveCustomerHostTxtWithCloudflare,
  type CustomerHostTxtResolver,
} from "./tenantHostDns";
import { getCloudCustomerBusinessProfile } from "./customerBusinessProfile";
import { getCloudTenantById } from "./tenants";
import {
  getAdminVerifiedCustomerHost,
  getCustomerHostVerificationChallenge,
  listAdminVerifiedCustomerHosts,
  normalizeCustomerHostname,
  prepareAdminVerifiedCustomerHostInsert,
  prepareCustomerHostVerificationAttemptUpdate,
  prepareCustomerHostVerificationChallengeDelete,
  prepareCustomerHostVerificationChallengeInsert,
  prepareDnsVerifiedCustomerHostInsert,
  prepareRemoveAdminVerifiedCustomerHost,
  type CloudCustomerHostPortalAuthorization,
} from "./tenantHosts";
import { CLOUD_PLATFORM_TENANT_ID } from "./tenants";

export const CLOUD_TENANT_HOSTS_PATH = "/__cloud/v1/tenant-hosts";
export const CLOUD_CUSTOMER_FRONT_DESK_HOSTS_PATH = "/__cloud/auth/front-desk/hosts";

interface TenantHostApiOptions {
  db?: CloudDb;
  adminToken?: string;
  now?: () => Date;
  resolveTxt?: CustomerHostTxtResolver;
}

export interface CustomerHostPortalIdentity {
  tenantId: string;
  membershipId: string;
  sessionTokenHash: string;
  role: "owner" | "admin" | "member" | "viewer";
}

interface CustomerHostPortalOptions {
  db?: CloudDb;
  now?: () => Date;
  resolveTxt?: CustomerHostTxtResolver;
}

const HOST_CHALLENGE_TTL_MS = 30 * 60_000;
const HOST_CHALLENGE_MAX_ATTEMPTS = 5;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function authorized(request: Request, token: string): boolean {
  const supplied = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${token}`;
  let difference = supplied.length ^ expected.length;
  for (let index = 0; index < Math.max(supplied.length, expected.length); index += 1) {
    difference |= (supplied.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function readRegistration(
  request: Request
): Promise<{ tenantId: string; hostname: string } | null> {
  if (
    request.headers.get("content-type")?.toLowerCase().split(";", 1)[0].trim() !==
    "application/json"
  ) {
    return null;
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > 2048) return null;
  try {
    const reader = request.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void reader.cancel().catch(() => undefined);
    };
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Request body timed out")), 5_000);
    });
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        size += value.byteLength;
        if (size > 2048) {
          cancel();
          return null;
        }
        chunks.push(value);
      }
    } catch {
      cancel();
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!cancelled) reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "hostname,tenantId" ||
      typeof value.hostname !== "string" ||
      typeof value.tenantId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.tenantId) ||
      !normalizeCustomerHostname(value.hostname)
    ) {
      return null;
    }
    return { tenantId: value.tenantId, hostname: value.hostname };
  } catch {
    return null;
  }
}

async function readVerificationBody(
  request: Request,
  includeChallengeId: boolean
): Promise<{ hostname: string; tenantId: string; challengeId?: string } | null> {
  if (
    request.headers.get("content-type")?.toLowerCase().split(";", 1)[0].trim() !==
    "application/json"
  ) {
    return null;
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > 2048) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Request body timed out")), 5_000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    cancel();
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!cancelled) reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    const expectedKeys = includeChallengeId ? "challengeId,hostname,tenantId" : "hostname,tenantId";
    if (
      Object.keys(body).sort().join(",") !== expectedKeys ||
      typeof body.hostname !== "string" ||
      typeof body.tenantId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.tenantId) ||
      !normalizeCustomerHostname(body.hostname) ||
      (includeChallengeId &&
        (typeof body.challengeId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.challengeId)))
    ) {
      return null;
    }
    return {
      hostname: body.hostname,
      tenantId: body.tenantId,
      ...(includeChallengeId ? { challengeId: body.challengeId as string } : {}),
    };
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeChallengeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function customerHostPortalAudit(
  db: CloudDb,
  request: Request,
  identity: CustomerHostPortalIdentity,
  input: {
    action: "customer.host.challenge.issue" | "customer.host.verify";
    hostname: string;
    timestamp: string;
  }
) {
  return prepareCloudComplianceAuditInsert(
    db,
    {
      id: crypto.randomUUID(),
      tenantId: identity.tenantId,
      timestamp: input.timestamp,
      action: input.action,
      actor: `membership:${identity.membershipId}`,
      target: input.hostname,
      resourceType: "customer-host",
      status: "success",
      requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
      metadata: { verificationMethod: "dns_txt_challenge" },
    },
    { requirePreviousStatementChange: true }
  ).statement;
}

async function readPortalHostnameBody(
  request: Request,
  includeChallengeId: boolean
): Promise<{ hostname: string; challengeId?: string } | null> {
  if (
    request.headers.get("content-type")?.toLowerCase().split(";", 1)[0].trim() !==
    "application/json"
  )
    return null;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > 2048) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Request body timed out")), 5_000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    cancel();
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!cancelled) reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    if (
      Object.keys(body).sort().join(",") !==
        (includeChallengeId ? "challengeId,hostname" : "hostname") ||
      typeof body.hostname !== "string" ||
      !normalizeCustomerHostname(body.hostname) ||
      (includeChallengeId &&
        (typeof body.challengeId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.challengeId)))
    )
      return null;
    return {
      hostname: body.hostname,
      ...(includeChallengeId ? { challengeId: body.challengeId as string } : {}),
    };
  } catch {
    return null;
  }
}

/** Called only after the OIDC portal has resolved a current owner/admin session. */
export async function handleCloudCustomerHostPortalRequest(
  request: Request,
  options: CustomerHostPortalOptions,
  identity: CustomerHostPortalIdentity
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== CLOUD_CUSTOMER_FRONT_DESK_HOSTS_PATH &&
    !url.pathname.startsWith(`${CLOUD_CUSTOMER_FRONT_DESK_HOSTS_PATH}/`)
  )
    return null;
  if (url.search !== "") return json({ error: "Query parameters are not supported" }, 400);
  if (identity.role !== "owner" && identity.role !== "admin") {
    return json({ error: "Owner or admin membership is required" }, 403);
  }
  if (!options.db) return json({ error: "Host verification is unavailable" }, 503);
  const db = options.db;
  const route = url.pathname.slice(CLOUD_CUSTOMER_FRONT_DESK_HOSTS_PATH.length);
  const now = options.now ?? (() => new Date());
  const current = now();
  const authorization: CloudCustomerHostPortalAuthorization = {
    tenantId: identity.tenantId,
    membershipId: identity.membershipId,
    sessionTokenHash: identity.sessionTokenHash,
    nowMs: current.getTime(),
  };
  const limit = await consumeCloudRateLimit(db, {
    tenantId: CLOUD_PLATFORM_TENANT_ID,
    bucketKey: `customer-host-portal:${identity.tenantId}:${identity.membershipId}`,
    limit: 20,
    windowMs: 60_000,
    nowMs: current.getTime(),
  });
  if (!limit.allowed) return json({ error: "Host verification rate limit exceeded" }, 429);

  if (route === "" && request.method === "GET") {
    if (url.pathname !== CLOUD_CUSTOMER_FRONT_DESK_HOSTS_PATH)
      return json({ error: "Not found" }, 404);
    return json({ hosts: await listAdminVerifiedCustomerHosts(db, identity.tenantId) });
  }
  if (route === "/challenge" && request.method === "POST") {
    const input = await readPortalHostnameBody(request, false);
    if (!input) return json({ error: "Invalid host verification request" }, 400);
    const hostname = normalizeCustomerHostname(input.hostname)!;
    const createdAt = now();
    const createdAtMs = createdAt.getTime();
    authorization.nowMs = createdAtMs;
    const expiresAtMs = createdAtMs + HOST_CHALLENGE_TTL_MS;
    const token = makeChallengeToken();
    const challengeId = crypto.randomUUID();
    try {
      const results = await db.batch([
        prepareCustomerHostVerificationChallengeInsert(
          db,
          {
            hostname,
            tenantId: identity.tenantId,
            challengeId,
            tokenHash: await sha256Hex(token),
            createdAtMs,
            expiresAtMs,
          },
          authorization,
          true
        ),
        customerHostPortalAudit(db, request, identity, {
          action: "customer.host.challenge.issue",
          hostname,
          timestamp: createdAt.toISOString(),
        }),
      ]);
      if (!results[0]?.success || results[0].meta?.changes !== 1) {
        return json({ error: "Host challenge could not be issued" }, 409);
      }
      const challenge = await getCustomerHostVerificationChallenge(db, hostname);
      if (
        !challenge ||
        challenge.tenantId !== identity.tenantId ||
        challenge.challengeId !== challengeId
      ) {
        return json({ error: "Host challenge could not be confirmed" }, 503);
      }
      return json(
        {
          hostname,
          challengeId: challenge.challengeId,
          recordName: `_omniroute-challenge.${hostname}`,
          recordType: "TXT",
          recordValue: token,
          expiresAt: new Date(challenge.expiresAtMs).toISOString(),
        },
        201
      );
    } catch {
      return json({ error: "Host challenge could not be issued" }, 503);
    }
  }
  if (route === "/verify" && request.method === "POST") {
    const input = await readPortalHostnameBody(request, true);
    if (!input?.challengeId) return json({ error: "Invalid host verification request" }, 400);
    const hostname = normalizeCustomerHostname(input.hostname)!;
    const challenge = await getCustomerHostVerificationChallenge(db, hostname);
    const verificationNow = now();
    const verificationNowMs = verificationNow.getTime();
    if (
      !challenge ||
      challenge.tenantId !== identity.tenantId ||
      challenge.challengeId !== input.challengeId
    ) {
      return json({ error: "Host challenge not found" }, 404);
    }
    if (
      challenge.expiresAtMs <= verificationNowMs ||
      challenge.attempts >= HOST_CHALLENGE_MAX_ATTEMPTS
    ) {
      return json({ error: "Host challenge expired" }, 410);
    }
    const txtRecords = await (options.resolveTxt ?? resolveCustomerHostTxtWithCloudflare)(
      `_omniroute-challenge.${hostname}`
    );
    if (!txtRecords) return json({ error: "DNS verification is temporarily unavailable" }, 503);
    const matches = await Promise.all(txtRecords.map(sha256Hex));
    if (!matches.includes(challenge.tokenHash)) {
      const attemptedAtMs = now().getTime();
      authorization.nowMs = attemptedAtMs;
      const attempt = await prepareCustomerHostVerificationAttemptUpdate(
        db,
        {
          hostname,
          tenantId: identity.tenantId,
          challengeId: challenge.challengeId,
          nowMs: attemptedAtMs,
        },
        authorization
      ).run();
      if (!attempt.success) return json({ error: "DNS verification could not be recorded" }, 503);
      if (Number(attempt.meta?.changes ?? 0) !== 1) {
        return json({ error: "Host challenge is no longer available" }, 403);
      }
      return json({ error: "DNS challenge record was not found" }, 422);
    }
    try {
      const committedAt = now();
      authorization.nowMs = committedAt.getTime();
      const results = await db.batch([
        prepareDnsVerifiedCustomerHostInsert(
          db,
          {
            hostname,
            tenantId: identity.tenantId,
            challengeId: challenge.challengeId,
            tokenHash: challenge.tokenHash,
            verifiedAt: committedAt.toISOString(),
            verifiedBy: `membership:${identity.membershipId}`,
            nowMs: committedAt.getTime(),
          },
          authorization
        ),
        prepareCustomerHostVerificationChallengeDelete(
          db,
          {
            hostname,
            tenantId: identity.tenantId,
            challengeId: challenge.challengeId,
            tokenHash: challenge.tokenHash,
            nowMs: committedAt.getTime(),
          },
          authorization
        ),
        customerHostPortalAudit(db, request, identity, {
          action: "customer.host.verify",
          hostname,
          timestamp: committedAt.toISOString(),
        }),
      ]);
      if (results.length !== 3 || results.some((result) => !result.success)) {
        return json({ error: "Host verification could not be committed" }, 503);
      }
      if (results[0].meta?.changes !== 1 || results[1].meta?.changes !== 1) {
        return json({ error: "Host verification is no longer available" }, 403);
      }
      const host = await getAdminVerifiedCustomerHost(db, hostname);
      if (!host || host.tenantId !== identity.tenantId)
        return json({ error: "Verified host could not be loaded" }, 503);
      return json({ host }, 201);
    } catch {
      return json({ error: "Host verification could not be committed" }, 503);
    }
  }
  return json({ error: "Not found" }, 404);
}

function auditHostVerification(
  db: CloudDb,
  request: Request,
  input: {
    action: "customer.host.challenge.issue" | "customer.host.verify";
    hostname: string;
    tenantId: string;
    timestamp: string;
    verificationMethod: "dns_txt_challenge";
  }
) {
  return prepareCloudComplianceAuditInsert(
    db,
    {
      id: crypto.randomUUID(),
      tenantId: CLOUD_PLATFORM_TENANT_ID,
      timestamp: input.timestamp,
      action: input.action,
      actor: "cloud-admin",
      target: input.hostname,
      resourceType: "customer-host",
      status: "success",
      requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
      metadata: { tenantId: input.tenantId, verificationMethod: input.verificationMethod },
    },
    { requirePreviousStatementChange: true }
  ).statement;
}

function requestHostname(request: Request): string | null {
  const raw = new URL(request.url).searchParams.get("hostname");
  if (!raw || raw.length > 260) return null;
  // Host headers may include a port. Parse as an authority, then match only the
  // resulting hostname; no suffix or wildcard matching is ever performed.
  try {
    const parsed = new URL(`http://${raw}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return normalizeCustomerHostname(parsed.hostname);
  } catch {
    return null;
  }
}

export async function handleCloudTenantHostsRequest(
  request: Request,
  options: TenantHostApiOptions
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== CLOUD_TENANT_HOSTS_PATH &&
    !url.pathname.startsWith(`${CLOUD_TENANT_HOSTS_PATH}/`)
  ) {
    return null;
  }
  if (!options.db) return json({ error: "Cloud database is not configured" }, 503);
  const db = options.db;
  const now = options.now ?? (() => new Date());
  const route = url.pathname.slice(CLOUD_TENANT_HOSTS_PATH.length);

  if (route === "/resolve") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (
      [...url.searchParams.keys()].some((key) => key !== "hostname") ||
      url.searchParams.getAll("hostname").length !== 1
    ) {
      return json({ error: "A single hostname is required" }, 400);
    }
    const hostname = requestHostname(request);
    if (!hostname) return json({ error: "Invalid hostname" }, 400);
    const registration = await getAdminVerifiedCustomerHost(db, hostname);
    if (!registration) return json({ error: "Host not found" }, 404);
    const tenant = await getCloudTenantById(db, registration.tenantId);
    const businessProfile = await getCloudCustomerBusinessProfile(db, registration.tenantId);
    if (!tenant || !tenant.isActive || tenant.kind !== "customer" || !businessProfile) {
      return json({ error: "Host not found" }, 404);
    }
    return json({
      hostname: registration.hostname,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      businessProfile,
    });
  }

  if (!options.adminToken || !authorized(request, options.adminToken)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (route === "/challenge" && request.method === "POST") {
    if (url.searchParams.size !== 0) return json({ error: "Unexpected query parameters" }, 400);
    const input = await readVerificationBody(request, false);
    if (!input) return json({ error: "Invalid host verification request" }, 400);
    const timestamp = now();
    const createdAtMs = timestamp.getTime();
    const expiresAtMs = createdAtMs + HOST_CHALLENGE_TTL_MS;
    const token = makeChallengeToken();
    const challengeId = crypto.randomUUID();
    try {
      const results = await db.batch([
        prepareCustomerHostVerificationChallengeInsert(db, {
          ...input,
          challengeId,
          tokenHash: await sha256Hex(token),
          createdAtMs,
          expiresAtMs,
        }),
        auditHostVerification(db, request, {
          action: "customer.host.challenge.issue",
          hostname: normalizeCustomerHostname(input.hostname)!,
          tenantId: input.tenantId,
          timestamp: timestamp.toISOString(),
          verificationMethod: "dns_txt_challenge",
        }),
      ]);
      const result = results[0];
      const changes = result?.meta?.changes;
      if (!result?.success || changes !== 1) {
        return json({ error: "Host challenge could not be issued" }, 409);
      }
      const challenge = await getCustomerHostVerificationChallenge(
        db,
        normalizeCustomerHostname(input.hostname)!
      );
      if (
        !challenge ||
        challenge.tenantId !== input.tenantId ||
        challenge.challengeId !== challengeId
      ) {
        return json({ error: "Host challenge could not be confirmed" }, 503);
      }
      return json(
        {
          hostname: challenge.hostname,
          tenantId: challenge.tenantId,
          challengeId: challenge.challengeId,
          recordName: `_omniroute-challenge.${challenge.hostname}`,
          recordType: "TXT",
          recordValue: token,
          expiresAt: new Date(challenge.expiresAtMs).toISOString(),
        },
        201
      );
    } catch {
      return json({ error: "Host challenge could not be issued" }, 503);
    }
  }
  if (route === "/verify" && request.method === "POST") {
    if (url.searchParams.size !== 0) return json({ error: "Unexpected query parameters" }, 400);
    const input = await readVerificationBody(request, true);
    if (!input?.challengeId) return json({ error: "Invalid host verification request" }, 400);
    const hostname = normalizeCustomerHostname(input.hostname)!;
    const challenge = await getCustomerHostVerificationChallenge(db, hostname);
    const verificationNowMs = now().getTime();
    if (
      !challenge ||
      challenge.tenantId !== input.tenantId ||
      challenge.challengeId !== input.challengeId
    ) {
      return json({ error: "Host challenge not found" }, 404);
    }
    if (
      challenge.expiresAtMs <= verificationNowMs ||
      challenge.attempts >= HOST_CHALLENGE_MAX_ATTEMPTS
    ) {
      return json({ error: "Host challenge expired" }, 410);
    }
    const recordName = `_omniroute-challenge.${hostname}`;
    const txtRecords = await (options.resolveTxt ?? resolveCustomerHostTxtWithCloudflare)(
      recordName
    );
    if (!txtRecords) return json({ error: "DNS verification is temporarily unavailable" }, 503);
    const matches = await Promise.all(txtRecords.map(sha256Hex));
    if (!matches.includes(challenge.tokenHash)) {
      const attempt = await prepareCustomerHostVerificationAttemptUpdate(db, {
        hostname,
        tenantId: input.tenantId,
        challengeId: challenge.challengeId,
        nowMs: verificationNowMs,
      }).run();
      if (!attempt.success) return json({ error: "DNS verification could not be recorded" }, 503);
      return json({ error: "DNS challenge record was not found" }, 422);
    }
    const timestamp = now();
    try {
      const results = await db.batch([
        prepareDnsVerifiedCustomerHostInsert(db, {
          hostname,
          tenantId: input.tenantId,
          challengeId: challenge.challengeId,
          tokenHash: challenge.tokenHash,
          verifiedAt: timestamp.toISOString(),
          nowMs: timestamp.getTime(),
        }),
        prepareCustomerHostVerificationChallengeDelete(db, {
          hostname,
          tenantId: input.tenantId,
          challengeId: challenge.challengeId,
          tokenHash: challenge.tokenHash,
          nowMs: timestamp.getTime(),
        }),
        auditHostVerification(db, request, {
          action: "customer.host.verify",
          hostname,
          tenantId: input.tenantId,
          timestamp: timestamp.toISOString(),
          verificationMethod: "dns_txt_challenge",
        }),
      ]);
      if (results.length !== 3 || results.some((result) => !result.success)) {
        return json({ error: "Host verification could not be committed" }, 503);
      }
      if (results[0].meta?.changes !== 1 || results[1].meta?.changes !== 1) {
        return json({ error: "Host verification could not be confirmed" }, 409);
      }
      const host = await getAdminVerifiedCustomerHost(db, hostname);
      if (!host) return json({ error: "Verified host could not be loaded" }, 503);
      return json({ host }, 201);
    } catch {
      return json({ error: "Host verification could not be committed" }, 503);
    }
  }
  if (route === "" && request.method === "GET") {
    if (
      [...url.searchParams.keys()].some((key) => key !== "tenantId") ||
      url.searchParams.getAll("tenantId").length !== 1
    ) {
      return json({ error: "A single tenantId is required" }, 400);
    }
    const tenantId = url.searchParams.get("tenantId") ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) return json({ error: "Invalid tenantId" }, 400);
    return json({ hosts: await listAdminVerifiedCustomerHosts(db, tenantId) });
  }
  if (route === "" && request.method === "POST") {
    // Direct registration is a platform-admin break-glass path. Routine customer
    // onboarding should use the DNS challenge and verification routes above.
    const registration = await readRegistration(request);
    if (!registration) return json({ error: "Invalid tenant host registration" }, 400);
    const timestamp = now().toISOString();
    try {
      const hostInsert = prepareAdminVerifiedCustomerHostInsert(db, {
        ...registration,
        verifiedAt: timestamp,
        verifiedBy: "cloud-admin",
      });
      const results = await db.batch([
        hostInsert,
        prepareCloudComplianceAuditInsert(
          db,
          {
            id: crypto.randomUUID(),
            tenantId: CLOUD_PLATFORM_TENANT_ID,
            timestamp,
            action: "customer.host.register",
            actor: "cloud-admin",
            target: normalizeCustomerHostname(registration.hostname),
            resourceType: "customer-host",
            status: "success",
            requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
            metadata: { tenantId: registration.tenantId, verificationMethod: "out_of_band" },
          },
          { requirePreviousStatementChange: true }
        ).statement,
      ]);
      const insertChanges =
        typeof results[0] === "object" && results[0] !== null && "meta" in results[0]
          ? Number((results[0] as { meta?: { changes?: unknown } }).meta?.changes)
          : Number.NaN;
      if (insertChanges !== 1) return json({ error: "Customer tenant is unavailable" }, 404);
      const host = await getAdminVerifiedCustomerHost(db, registration.hostname);
      if (!host) return json({ error: "Host registration could not be confirmed" }, 503);
      return json({ host }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      return json(
        {
          error:
            message.includes("unique") || message.includes("constraint")
              ? "Host is already registered"
              : "Host registration failed",
        },
        message.includes("unique") || message.includes("constraint") ? 409 : 503
      );
    }
  }
  const removeMatch = /^\/([^/]+)$/.exec(route);
  if (removeMatch && request.method === "DELETE") {
    let hostname: string;
    try {
      hostname = decodeURIComponent(removeMatch[1]);
    } catch {
      return json({ error: "Invalid hostname" }, 400);
    }
    if (
      [...url.searchParams.keys()].some((key) => key !== "tenantId") ||
      url.searchParams.getAll("tenantId").length !== 1
    ) {
      return json({ error: "A single tenantId is required" }, 400);
    }
    const tenantId = url.searchParams.get("tenantId") ?? "";
    if (!normalizeCustomerHostname(hostname) || !/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) {
      return json({ error: "Invalid host registration" }, 400);
    }
    const timestamp = now().toISOString();
    const results = await db.batch([
      prepareRemoveAdminVerifiedCustomerHost(db, hostname, tenantId),
      prepareCloudComplianceAuditInsert(
        db,
        {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp,
          action: "customer.host.remove",
          actor: "cloud-admin",
          target: hostname,
          resourceType: "customer-host",
          status: "success",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { tenantId },
        },
        { requirePreviousStatementChange: true }
      ).statement,
    ]);
    const changes =
      typeof results[0] === "object" && results[0] !== null && "meta" in results[0]
        ? Number((results[0] as { meta?: { changes?: unknown } }).meta?.changes)
        : Number.NaN;
    return changes === 1 ? json({ removed: true }) : json({ error: "Host not found" }, 404);
  }
  return json({ error: "Not found" }, 404);
}
