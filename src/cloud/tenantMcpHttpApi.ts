import type { CloudDb } from "./db";
import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";
import {
  createCloudTenantMcpServer,
  deleteCloudTenantMcpServer,
  getCloudTenantMcpServer,
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
  now?: () => Date;
  failedKeyRateLimit?: { limit: number; windowMs: number };
  failedKeyFallbackRateLimit?: { limit: number; windowMs: number };
  tenantRateLimit?: { limit: number; windowMs: number };
  bodyReadTimeoutMs?: number;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function parseRoute(pathname: string): { isCollection: boolean; id?: string } | null {
  if (pathname === CLOUD_CUSTOMER_MCP_SERVERS_PATH) return { isCollection: true };
  const prefix = `${CLOUD_CUSTOMER_MCP_SERVERS_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
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

/** Customer MCP registry configuration only; this handler performs no outbound requests. */
export async function handleCloudTenantMcpRequest(
  request: Request,
  options: CloudTenantMcpHttpApiOptions
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = parseRoute(url.pathname);
  if (!route) return null;
  if (url.search !== "") return json({ error: "Query parameters are not supported" }, 400);
  if (!options.db) return json({ error: "Cloud database is not configured" }, 503);
  const allowedMethods = route.isCollection ? ["GET", "POST"] : ["GET", "PUT", "DELETE"];
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
      apiKeyId: identity.apiKeyId,
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
          transport: "sse" | "streamable_http";
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
        transport: "sse" | "streamable_http";
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
