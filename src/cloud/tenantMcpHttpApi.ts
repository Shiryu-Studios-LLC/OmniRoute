import type { CloudDb } from "./db";
import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import { createCloudMcpEgressTransport, type CloudMcpEgressBinding } from "./mcpEgressTransport";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";
import {
  createTenantRemoteMcpRuntime,
  TenantRemoteMcpError,
} from "../lib/mcp/tenantRemoteMcpRuntime";
import {
  createCloudTenantMcpServer,
  deleteCloudTenantMcpServer,
  getCloudTenantMcpServer,
  getCloudTenantMcpCredential,
  listCloudTenantMcpServers,
  validateCloudMcpServerInput,
  type CloudTenantMcpMutationContext,
  updateCloudTenantMcpServer,
} from "./tenantMcpServers";

export const CLOUD_CUSTOMER_MCP_SERVERS_PATH = "/__cloud/v1/customer/mcp-servers";
const MAX_BODY_BYTES = 16 * 1024;
const BODY_READ_TIMEOUT_MS = 5_000;
const AUTH_RATE_LIMIT = { limit: 600, windowMs: 60_000 };
const AUTH_FALLBACK_RATE_LIMIT = { limit: 100, windowMs: 60_000 };
const TENANT_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

export interface CloudTenantMcpHttpApiOptions {
  db?: CloudDb;
  credentialEncryptionKey?: string;
  egressBinding?: CloudMcpEgressBinding;
  egressProxyToken?: string;
  egressEnabled?: boolean;
  now?: () => Date;
  failedKeyRateLimit?: { limit: number; windowMs: number };
  failedKeyFallbackRateLimit?: { limit: number; windowMs: number };
  tenantRateLimit?: { limit: number; windowMs: number };
  bodyReadTimeoutMs?: number;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function parseRoute(pathname: string): {
  isCollection: boolean;
  id?: string;
  action?: "discover" | "invoke";
  toolName?: string;
} | null {
  if (pathname === CLOUD_CUSTOMER_MCP_SERVERS_PATH) return { isCollection: true };
  const prefix = `${CLOUD_CUSTOMER_MCP_SERVERS_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split("/");
  const id = segments[0] ?? "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  if (segments.length === 2 && segments[1] === "tools") {
    return { isCollection: false, id, action: "discover" };
  }
  if (
    segments.length === 3 &&
    segments[1] === "tools" &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(segments[2] ?? "")
  ) {
    return { isCollection: false, id, action: "invoke", toolName: segments[2] };
  }
  if (segments.length !== 1) return null;
  return { isCollection: false, id };
}

async function readJsonBody(request: Request, timeoutMs: number): Promise<unknown | Response> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return json({ error: "Expected application/json" }, 415);
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_BODY_BYTES
  ) {
    return json({ error: "Request body is too large" }, 413);
  }
  if (!request.body) return json({ error: "Invalid JSON body" }, 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let cancellationStarted = false;
  const cancel = () => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    void reader
      .cancel()
      .catch(() => undefined)
      .finally(() => {
        try {
          reader.releaseLock();
        } catch {
          /* Cancellation can release the lock first. */
        }
      });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Request body timed out")), timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        cancel();
        return json({ error: "Request body is too large" }, 413);
      }
      chunks.push(value);
    }
  } catch {
    cancel();
    return json({ error: "Request body could not be read" }, 408);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!cancellationStarted) reader.releaseLock();
  }
  try {
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
}

async function mcpIsEnabled(db: CloudDb, tenantId: string): Promise<boolean> {
  const row = await db
    .prepare<{ mcp_enabled: number }>(
      `SELECT settings.mcp_enabled
         FROM cloud_tenant_settings settings
         JOIN tenants tenant ON tenant.id = settings.tenant_id
        WHERE settings.tenant_id = ? AND tenant.kind = 'customer' AND tenant.is_active = 1
        LIMIT 1`
    )
    .bind(tenantId)
    .first();
  return row?.mcp_enabled === 1;
}

async function canActivateMcpServerUpdate(
  db: CloudDb,
  tenantId: string,
  serverId: string,
  input: Partial<{ transport: "streamable_http"; endpoint: string; isActive: boolean }>
): Promise<boolean> {
  if (input.isActive !== true) return true;
  const current = await getCloudTenantMcpServer(db, tenantId, serverId);
  if (!current) return true;
  let currentEndpointIsSupported = true;
  try {
    validateCloudMcpServerInput({
      name: current.name,
      transport: current.transport,
      endpoint: current.endpoint,
    });
  } catch {
    currentEndpointIsSupported = false;
  }
  const currentConfigIsSupported =
    current.transport === "streamable_http" && currentEndpointIsSupported;
  if (currentConfigIsSupported) return true;
  return input.transport === "streamable_http" && input.endpoint !== undefined;
}

function createTenantMcpRuntime(
  options: CloudTenantMcpHttpApiOptions,
  identity: NonNullable<Awaited<ReturnType<typeof authenticateCloudCustomerApiKey>>>
) {
  const db = options.db!;
  const transport = createCloudMcpEgressTransport({
    binding: options.egressBinding,
    proxyToken: options.egressProxyToken,
  });
  if (!transport) return null;
  return createTenantRemoteMcpRuntime({
    transport,
    authorization: {
      resolveTenant: async (principal) =>
        principal.subject === identity.principalId ? identity.tenantId : null,
      canAccessServer: async (principal, tenantId, _serverId) => {
        if (
          principal.subject !== identity.principalId ||
          tenantId !== identity.tenantId ||
          (identity.role !== "owner" && identity.role !== "admin") ||
          !(await mcpIsEnabled(db, tenantId))
        ) {
          return false;
        }
        // Keep existence checks in the tenant-qualified registry lookup so a
        // foreign or absent ID receives the same not-found response.
        return true;
      },
    },
    registry: {
      listByTenant: (tenantId) => listCloudTenantMcpServers(db, tenantId),
      getById: (tenantId, serverId) => getCloudTenantMcpServer(db, tenantId, serverId),
    },
    getCredential: (tenantId, serverId) =>
      getCloudTenantMcpCredential(db, tenantId, serverId, options.credentialEncryptionKey),
  });
}

/** Tenant MCP configuration and controlled-egress discovery/invocation routes. */
export async function handleCloudTenantMcpRequest(
  request: Request,
  options: CloudTenantMcpHttpApiOptions
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = parseRoute(url.pathname);
  if (!route) return null;
  if (url.search !== "") return json({ error: "Query parameters are not supported" }, 400);
  if (!options.db) return json({ error: "Cloud database is not configured" }, 503);
  const allowedMethods =
    route.action === "discover"
      ? ["GET"]
      : route.action === "invoke"
        ? ["POST"]
        : route.isCollection
          ? ["GET", "POST"]
          : ["GET", "PUT", "DELETE"];
  if (!allowedMethods.includes(request.method)) return json({ error: "Method not allowed" }, 405);

  const now = options.now ?? (() => new Date());
  const clientIpBucket = cloudflareClientIpBucket(request);
  try {
    const authLimit = await consumeCloudRateLimit(options.db, {
      tenantId: "tenant_shiryu_admin",
      bucketKey: `customer-mcp-auth:${clientIpBucket ?? "fallback"}`,
      ...(clientIpBucket
        ? (options.failedKeyRateLimit ?? AUTH_RATE_LIMIT)
        : (options.failedKeyFallbackRateLimit ?? AUTH_FALLBACK_RATE_LIMIT)),
      nowMs: now().getTime(),
    });
    if (!authLimit.allowed) return json({ error: "Authentication rate limit exceeded" }, 429);
  } catch {
    return json({ error: "Authentication rate limit is unavailable" }, 503);
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (orc_live_[A-Za-z0-9_-]{1,96})$/.exec(authorization);
  if (!match) return json({ error: "Unauthorized" }, 401);
  const timestamp = now().toISOString();
  let identity;
  try {
    identity = await authenticateCloudCustomerApiKey(options.db, match[1], timestamp);
  } catch {
    return json({ error: "Customer authentication is unavailable" }, 503);
  }
  if (!identity) return json({ error: "Unauthorized" }, 401);
  if (identity.role !== "owner" && identity.role !== "admin") {
    return json({ error: "Owner or admin membership is required" }, 403);
  }

  try {
    const tenantLimit = await consumeCloudRateLimit(options.db, {
      tenantId: identity.tenantId,
      bucketKey: "customer-mcp-servers",
      ...(options.tenantRateLimit ?? TENANT_RATE_LIMIT),
      nowMs: now().getTime(),
    });
    if (!tenantLimit.allowed) return json({ error: "Customer MCP rate limit exceeded" }, 429);
  } catch {
    return json({ error: "Customer MCP rate limit is unavailable" }, 503);
  }

  try {
    if (!(await mcpIsEnabled(options.db, identity.tenantId))) {
      return json({ error: "MCP is not enabled for this tenant" }, 403);
    }
    if (route.action) {
      const remoteMcp = createTenantMcpRuntime(options, identity);
      if (!options.egressEnabled || !remoteMcp) {
        return json({ error: "Controlled MCP egress is not enabled" }, 503);
      }
      const principal = { subject: identity.principalId };
      if (route.action === "discover") {
        const discovery = await remoteMcp.discoverTools(principal, route.id!);
        return json({ discovery });
      }
      const body = await readJsonBody(request, options.bodyReadTimeoutMs ?? BODY_READ_TIMEOUT_MS);
      if (body instanceof Response) return body;
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "arguments") ||
        ((body as Record<string, unknown>).arguments !== undefined &&
          (typeof (body as Record<string, unknown>).arguments !== "object" ||
            (body as Record<string, unknown>).arguments === null ||
            Array.isArray((body as Record<string, unknown>).arguments)))
      ) {
        return json({ error: "Tool arguments must be a JSON object" }, 400);
      }
      const result = await remoteMcp.invokeTool(
        principal,
        route.id!,
        route.toolName!,
        ((body as Record<string, unknown>).arguments as Record<string, unknown> | undefined) ?? {}
      );
      return json({ result });
    }
    if (request.method === "GET") {
      if (route.isCollection) {
        return json({ servers: await listCloudTenantMcpServers(options.db, identity.tenantId) });
      }
      const server = await getCloudTenantMcpServer(options.db, identity.tenantId, route.id!);
      return server ? json({ server }) : json({ error: "MCP server not found" }, 404);
    }

    const actor = {
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      membershipId: identity.membershipId,
      authorization: { type: "api_key", apiKeyId: identity.apiKeyId },
    };
    if (request.method === "DELETE") {
      const deleted = await deleteCloudTenantMcpServer(options.db, route.id!, {
        actor,
        now: timestamp,
        audit: { id: crypto.randomUUID(), action: "cloud.mcp_server.delete" },
      });
      return deleted ? json({ deleted: true }) : json({ error: "MCP server not found" }, 404);
    }

    const body = await readJsonBody(request, options.bodyReadTimeoutMs ?? BODY_READ_TIMEOUT_MS);
    if (body instanceof Response) return body;
    let input;
    try {
      input = validateCloudMcpServerInput(body, request.method === "PUT");
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Invalid MCP server configuration" },
        400
      );
    }
    if (
      request.method === "PUT" &&
      !(await canActivateMcpServerUpdate(
        options.db,
        identity.tenantId,
        route.id!,
        input as Partial<{
          transport: "streamable_http";
          endpoint: string;
          isActive: boolean;
        }>
      ))
    ) {
      return json(
        {
          error:
            "Activating a legacy MCP server requires Streamable HTTP and an HTTPS port 443 endpoint",
        },
        400
      );
    }
    const context: CloudTenantMcpMutationContext = {
      actor,
      now: timestamp,
      audit: { id: crypto.randomUUID(), action: "cloud.mcp_server.create" },
    };
    if (request.method === "POST") {
      const server = await createCloudTenantMcpServer(
        options.db,
        input as ReturnType<typeof validateCloudMcpServerInput> & {
          name: string;
          transport: "streamable_http";
          endpoint: string;
        },
        context,
        options.credentialEncryptionKey
      );
      return server
        ? json({ server }, 201)
        : json({ error: "MCP server could not be created" }, 403);
    }

    const server = await updateCloudTenantMcpServer(
      options.db,
      route.id!,
      input as Partial<{
        name: string;
        transport: "streamable_http";
        endpoint: string;
        isActive: boolean;
        credential: string | null;
      }>,
      { ...context, audit: { ...context.audit, action: "cloud.mcp_server.update" } },
      options.credentialEncryptionKey
    );
    return server ? json({ server }) : json({ error: "MCP server not found" }, 404);
  } catch (error) {
    if (error instanceof TenantRemoteMcpError) {
      const status =
        error.code === "UNAUTHENTICATED"
          ? 401
          : error.code === "TENANT_FORBIDDEN"
            ? 403
            : error.code === "MCP_SERVER_NOT_FOUND"
              ? 404
              : error.code === "MCP_SERVER_INACTIVE"
                ? 409
                : 502;
      return json({ error: "MCP server request could not be completed", code: error.code }, status);
    }
    return json({ error: "Customer MCP configuration could not be completed" }, 503);
  }
}

/** Owner/admin OIDC portal surface. Call only after the OIDC session is resolved and origin checked. */
export async function handleCloudTenantMcpPortalRequest(
  request: Request,
  options: CloudTenantMcpHttpApiOptions,
  identity: {
    tenantId: string;
    principalId: string;
    membershipId: string;
    role: "owner" | "admin" | "member" | "viewer";
    sessionTokenHash: string;
  }
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = parseRoute(
    url.pathname.replace(/^\/__cloud\/auth\/mcp-servers/, CLOUD_CUSTOMER_MCP_SERVERS_PATH)
  );
  if (!route) return null;
  if (url.search !== "") return json({ error: "Query parameters are not supported" }, 400);
  if (!options.db) return json({ error: "Cloud database is not configured" }, 503);
  if (request.method !== "GET" && request.headers.get("origin") !== url.origin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  if (identity.role !== "owner" && identity.role !== "admin") {
    return json({ error: "Owner or admin membership is required" }, 403);
  }
  const allowedMethods = route.action
    ? route.action === "discover"
      ? ["GET"]
      : ["POST"]
    : route.isCollection
      ? ["GET", "POST"]
      : ["GET", "PUT", "DELETE"];
  if (!allowedMethods.includes(request.method)) return json({ error: "Method not allowed" }, 405);
  if (route.action) return json({ error: "Controlled MCP egress is not enabled" }, 503);

  const now = options.now ?? (() => new Date());
  const timestamp = now().toISOString();
  try {
    const limit = await consumeCloudRateLimit(options.db, {
      tenantId: identity.tenantId,
      bucketKey: `customer-mcp-portal:${identity.membershipId}`,
      limit: 60,
      windowMs: 60_000,
      nowMs: now().getTime(),
    });
    if (!limit.allowed) return json({ error: "Customer MCP rate limit exceeded" }, 429);
    if (!(await mcpIsEnabled(options.db, identity.tenantId))) {
      return json({ error: "MCP is not enabled for this tenant" }, 403);
    }
    const actor: CloudTenantMcpMutationContext["actor"] = {
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      membershipId: identity.membershipId,
      authorization: { type: "oidc_session", sessionTokenHash: identity.sessionTokenHash },
    };
    if (request.method === "GET") {
      if (route.isCollection) {
        return json({ servers: await listCloudTenantMcpServers(options.db, identity.tenantId) });
      }
      const server = await getCloudTenantMcpServer(options.db, identity.tenantId, route.id!);
      return server ? json({ server }) : json({ error: "MCP server not found" }, 404);
    }
    if (request.method === "DELETE") {
      const deleted = await deleteCloudTenantMcpServer(options.db, route.id!, {
        actor,
        now: timestamp,
        audit: { id: crypto.randomUUID(), action: "cloud.mcp_server.delete" },
      });
      return deleted ? json({ deleted: true }) : json({ error: "MCP server not found" }, 404);
    }
    const body = await readJsonBody(request, options.bodyReadTimeoutMs ?? BODY_READ_TIMEOUT_MS);
    if (body instanceof Response) return body;
    let input;
    try {
      input = validateCloudMcpServerInput(body, request.method === "PUT");
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Invalid MCP server configuration" },
        400
      );
    }
    if (
      request.method === "PUT" &&
      !(await canActivateMcpServerUpdate(
        options.db,
        identity.tenantId,
        route.id!,
        input as Partial<{
          transport: "streamable_http";
          endpoint: string;
          isActive: boolean;
        }>
      ))
    ) {
      return json(
        {
          error:
            "Activating a legacy MCP server requires Streamable HTTP and an HTTPS port 443 endpoint",
        },
        400
      );
    }
    const context: CloudTenantMcpMutationContext = {
      actor,
      now: timestamp,
      audit: {
        id: crypto.randomUUID(),
        action: `cloud.mcp_server.${request.method.toLowerCase()}`,
      },
    };
    if (request.method === "POST") {
      const server = await createCloudTenantMcpServer(
        options.db,
        input as ReturnType<typeof validateCloudMcpServerInput> & {
          name: string;
          transport: "streamable_http";
          endpoint: string;
        },
        context,
        options.credentialEncryptionKey
      );
      return server
        ? json({ server }, 201)
        : json({ error: "MCP server could not be created" }, 403);
    }
    const server = await updateCloudTenantMcpServer(
      options.db,
      route.id!,
      input as Partial<{
        name: string;
        transport: "streamable_http";
        endpoint: string;
        isActive: boolean;
        credential: string | null;
      }>,
      { ...context, audit: { ...context.audit, action: "cloud.mcp_server.update" } },
      options.credentialEncryptionKey
    );
    return server ? json({ server }) : json({ error: "MCP server not found" }, 404);
  } catch {
    return json({ error: "Customer MCP configuration could not be completed" }, 503);
  }
}
