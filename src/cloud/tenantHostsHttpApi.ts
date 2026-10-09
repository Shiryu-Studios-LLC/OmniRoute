import { prepareCloudComplianceAuditInsert } from "./complianceAudit";
import type { CloudDb } from "./db";
import { getCloudCustomerBusinessProfile } from "./customerBusinessProfile";
import { getCloudTenantById } from "./tenants";
import {
  getAdminVerifiedCustomerHost,
  listAdminVerifiedCustomerHosts,
  normalizeCustomerHostname,
  prepareAdminVerifiedCustomerHostInsert,
  prepareRemoveAdminVerifiedCustomerHost,
} from "./tenantHosts";
import { CLOUD_PLATFORM_TENANT_ID } from "./tenants";

export const CLOUD_TENANT_HOSTS_PATH = "/__cloud/v1/tenant-hosts";

interface TenantHostApiOptions {
  db?: CloudDb;
  adminToken?: string;
  now?: () => Date;
}

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
    // Platform admins register domains only after confirming ownership through
    // their existing out-of-band verification process. No DNS claim is implied.
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
