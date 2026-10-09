import { prepareCloudComplianceAuditInsert } from "./complianceAudit";
import { encryptCloudCredential, CloudCredentialEncryptionError } from "./credentialEncryption";
import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import type { CloudDb } from "./db";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";
import {
  getCloudProviderConnectionById,
  getCloudProviderConnections,
  prepareCloudProviderConnectionDelete,
  prepareCloudProviderConnectionInsert,
  prepareCloudProviderConnectionUpdate,
  type CloudProviderConnection,
  type CloudProviderConnectionInput,
} from "./providers";

export const CLOUD_CUSTOMER_PROVIDER_CONNECTIONS_PATH = "/__cloud/v1/customer/provider-connections";
export const CLOUD_CUSTOMER_PROVIDER_PORTAL_CONNECTIONS_PATH = "/__cloud/auth/provider-connections";
const MAX_BODY_BYTES = 16 * 1024;
const BODY_READ_TIMEOUT_MS = 5_000;
const AUTH_RATE_LIMIT = { limit: 600, windowMs: 60_000 };
const AUTH_FALLBACK_RATE_LIMIT = { limit: 20, windowMs: 60_000 };
const CUSTOMER_RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const SUPPORTED_PROVIDER = "openai";
const SUPPORTED_MODEL = "gpt-4o-mini-2024-07-18";

export interface CloudCustomerProviderApiOptions {
  db?: CloudDb;
  credentialEncryptionKey?: string;
  now?: () => Date;
  failedKeyRateLimit?: { limit: number; windowMs: number };
  failedKeyFallbackRateLimit?: { limit: number; windowMs: number };
  tenantRateLimit?: { limit: number; windowMs: number };
  bodyReadTimeoutMs?: number;
}

export interface CloudCustomerProviderPortalIdentity {
  tenantId: string;
  principalId: string;
  role: "owner" | "admin";
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function safeConnection(connection: CloudProviderConnection) {
  return {
    id: connection.id,
    provider: connection.provider,
    authType: connection.authType,
    name: connection.name,
    priority: connection.priority,
    isActive: connection.isActive,
    defaultModel: connection.defaultModel,
    credentialOwnership: connection.credentialOwnership,
    executionLocation: connection.executionLocation,
    hasCredentials: Boolean(connection.apiKey),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function isCustomerManagedSupportedConnection(
  connection: CloudProviderConnection | null
): connection is CloudProviderConnection {
  return (
    connection?.provider === SUPPORTED_PROVIDER &&
    connection.credentialOwnership === "customer_managed" &&
    connection.executionLocation === "third_party"
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

async function readBody(
  request: Request,
  timeoutMs: number
): Promise<{ kind: "ok"; body: Record<string, unknown> } | { kind: "invalid" | "timeout" }> {
  const contentType = request.headers.get("content-type")?.toLowerCase().split(";", 1)[0].trim();
  if (contentType !== "application/json") return { kind: "invalid" };
  const length = request.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
    return { kind: "invalid" };
  }
  if (!request.body) return { kind: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  let cancellationStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelReader = () => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    void reader.cancel().catch(() => undefined);
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      cancelReader();
      reject(new Error("Request body timed out"));
    }, timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        cancelReader();
        return { kind: "invalid" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? { kind: "ok", body: value as Record<string, unknown> }
      : { kind: "invalid" };
  } catch {
    return timedOut ? { kind: "timeout" } : { kind: "invalid" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!cancellationStarted) reader.releaseLock();
  }
}

function validateBody(
  body: Record<string, unknown>,
  mode: "create" | "patch"
): Record<string, unknown> | null {
  const allowed = new Set(
    mode === "create"
      ? ["id", "provider", "apiKey", "name", "priority", "isActive"]
      : ["apiKey", "name", "priority", "isActive"]
  );
  if (Object.keys(body).some((field) => !allowed.has(field))) return null;
  if (mode === "create" && body.provider !== SUPPORTED_PROVIDER) return null;
  if (mode === "create" && !validId(body.id)) return null;
  if (mode === "create" && typeof body.apiKey !== "string") return null;
  if (
    "apiKey" in body &&
    body.apiKey !== null &&
    (typeof body.apiKey !== "string" ||
      body.apiKey.length < 1 ||
      body.apiKey.length > 8192 ||
      body.apiKey.startsWith("enc:v1:") ||
      body.apiKey.startsWith("enc:v2:"))
  )
    return null;
  if (
    "name" in body &&
    body.name !== null &&
    (typeof body.name !== "string" || body.name.length > 200)
  )
    return null;
  if (
    "priority" in body &&
    (typeof body.priority !== "number" ||
      !Number.isInteger(body.priority) ||
      body.priority < 0 ||
      body.priority > 100_000)
  )
    return null;
  if ("isActive" in body && typeof body.isActive !== "boolean") return null;
  if (mode === "patch" && Object.keys(body).length === 0) return null;
  return body;
}

async function encryptApiKey(
  value: unknown,
  options: CloudCustomerProviderApiOptions,
  tenantId: string,
  connectionId: string
): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null) return null;
  try {
    return await encryptCloudCredential(value as string, options.credentialEncryptionKey, {
      tenantId,
      connectionId,
      field: "apiKey",
    });
  } catch (error) {
    if (error instanceof CloudCredentialEncryptionError) {
      throw new Error("Cloud credential encryption is unavailable");
    }
    throw error;
  }
}

function auditStatement(
  db: CloudDb,
  identity: { tenantId: string; principalId: string },
  request: Request,
  action: string,
  connectionId: string,
  timestamp: string,
  metadata: Record<string, unknown>
) {
  return prepareCloudComplianceAuditInsert(
    db,
    {
      id: crypto.randomUUID(),
      tenantId: identity.tenantId,
      timestamp,
      action,
      actor: identity.principalId,
      target: connectionId,
      resourceType: "cloud-provider-connection",
      status: "success",
      requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
      metadata,
    },
    { requirePreviousStatementChange: true }
  ).statement;
}

function isDuplicateConnectionId(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:\s*provider_connections\.tenant_id,\s*provider_connections\.id\b/i.test(
      error.message
    )
  );
}

function mutationChanged(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const meta = (result as { meta?: unknown }).meta;
  if (meta === null || typeof meta !== "object") return false;
  return Number((meta as { changes?: unknown }).changes ?? 0) > 0;
}

/** Shared operations core. Trusted identity is supplied only by the session portal wrapper below. */
async function handleCloudCustomerProviderRequestCore(
  request: Request,
  options: CloudCustomerProviderApiOptions,
  trustedIdentity?: CloudCustomerProviderPortalIdentity
): Promise<Response | null> {
  const url = new URL(request.url);
  const routePath = trustedIdentity
    ? CLOUD_CUSTOMER_PROVIDER_PORTAL_CONNECTIONS_PATH
    : CLOUD_CUSTOMER_PROVIDER_CONNECTIONS_PATH;
  if (url.pathname !== routePath && !url.pathname.startsWith(`${routePath}/`)) return null;
  if (!options.db) return json({ error: "Cloud database is not configured" }, 503);
  const routeSuffix = url.pathname.slice(routePath.length);
  let connectionId: string | undefined;
  if (routeSuffix) {
    try {
      connectionId = decodeURIComponent(routeSuffix.slice(1));
    } catch {
      return json({ error: "Not found" }, 404);
    }
    if (
      !routeSuffix.startsWith("/") ||
      routeSuffix.slice(1).includes("/") ||
      !validId(connectionId)
    ) {
      return json({ error: "Not found" }, 404);
    }
  }
  if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method)) {
    return json({ error: "Method not allowed" }, 405);
  }
  if ([...url.searchParams.keys()].length > 0)
    return json({ error: "Unsupported query parameters" }, 400);

  const now = options.now ?? (() => new Date());
  try {
    const ipBucket = cloudflareClientIpBucket(request);
    const authLimit = await consumeCloudRateLimit(options.db, {
      tenantId: "tenant_shiryu_admin",
      bucketKey: `customer-provider-auth:${ipBucket ?? "fallback"}`,
      ...(ipBucket
        ? (options.failedKeyRateLimit ?? AUTH_RATE_LIMIT)
        : (options.failedKeyFallbackRateLimit ?? AUTH_FALLBACK_RATE_LIMIT)),
      nowMs: now().getTime(),
    });
    if (!authLimit.allowed) return json({ error: "Authentication rate limit exceeded" }, 429);
  } catch {
    return json({ error: "Authentication rate limit is unavailable" }, 503);
  }
  let identity = trustedIdentity;
  if (!identity) {
    const match = /^Bearer (orc_live_[A-Za-z0-9_-]{32,64})$/.exec(
      request.headers.get("authorization") ?? ""
    );
    if (!match) return json({ error: "Unauthorized" }, 401);
    try {
      identity = await authenticateCloudCustomerApiKey(options.db, match[1], now().toISOString());
    } catch {
      return json({ error: "Customer authentication is unavailable" }, 503);
    }
  }
  if (!identity) return json({ error: "Unauthorized" }, 401);
  if (identity.role !== "owner" && identity.role !== "admin") {
    return json({ error: "Owner or admin membership is required" }, 403);
  }
  try {
    const limit = await consumeCloudRateLimit(options.db, {
      tenantId: identity.tenantId,
      bucketKey: "customer-provider-connections",
      ...(options.tenantRateLimit ?? CUSTOMER_RATE_LIMIT),
      nowMs: now().getTime(),
    });
    if (!limit.allowed) return json({ error: "Provider connection rate limit exceeded" }, 429);

    if (request.method === "GET") {
      if (connectionId) {
        const connection = await getCloudProviderConnectionById(
          options.db,
          identity.tenantId,
          connectionId
        );
        return isCustomerManagedSupportedConnection(connection)
          ? json(safeConnection(connection))
          : json({ error: "Not found" }, 404);
      }
      const connections = await getCloudProviderConnections(options.db, identity.tenantId, {
        provider: SUPPORTED_PROVIDER,
      });
      return json({
        connections: connections.filter(isCustomerManagedSupportedConnection).map(safeConnection),
      });
    }

    if (request.method === "POST") {
      if (connectionId) return json({ error: "Not found" }, 404);
      const parsed = await readBody(request, options.bodyReadTimeoutMs ?? BODY_READ_TIMEOUT_MS);
      if (parsed.kind === "timeout") return json({ error: "Request body timed out" }, 408);
      if (parsed.kind === "invalid") return json({ error: "Invalid JSON body" }, 400);
      const raw = parsed.body;
      const body = validateBody(raw, "create");
      if (!body) return json({ error: "Invalid provider connection" }, 400);
      const timestamp = now().toISOString();
      const id = body.id as string;
      if (await getCloudProviderConnectionById(options.db, identity.tenantId, id)) {
        return json({ error: "Provider connection already exists" }, 409);
      }
      const apiKey = await encryptApiKey(body.apiKey, options, identity.tenantId, id);
      const input: CloudProviderConnectionInput = {
        id,
        tenantId: identity.tenantId,
        provider: SUPPORTED_PROVIDER,
        authType: "api_key",
        apiKey: apiKey ?? null,
        name: (body.name as string | null | undefined) ?? null,
        priority: (body.priority as number | undefined) ?? 0,
        isActive: (body.isActive as boolean | undefined) ?? true,
        defaultModel: SUPPORTED_MODEL,
        credentialOwnership: "customer_managed",
        executionLocation: "third_party",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        await options.db.batch([
          prepareCloudProviderConnectionInsert(options.db, input),
          auditStatement(
            options.db,
            identity,
            request,
            "customer.provider_connection.create",
            id,
            timestamp,
            { provider: SUPPORTED_PROVIDER, hasCredentials: true }
          ),
        ]);
      } catch (error) {
        if (isDuplicateConnectionId(error)) {
          return json({ error: "Provider connection already exists" }, 409);
        }
        throw error;
      }
      const created = await getCloudProviderConnectionById(options.db, identity.tenantId, id);
      return created
        ? json(safeConnection(created), 201)
        : json({ error: "Provider connection is unavailable" }, 503);
    }

    if (!connectionId) return json({ error: "Provider connection ID is required" }, 400);
    const existing = await getCloudProviderConnectionById(
      options.db,
      identity.tenantId,
      connectionId
    );
    if (!isCustomerManagedSupportedConnection(existing)) return json({ error: "Not found" }, 404);
    const timestamp = now().toISOString();

    if (request.method === "PATCH") {
      const parsed = await readBody(request, options.bodyReadTimeoutMs ?? BODY_READ_TIMEOUT_MS);
      if (parsed.kind === "timeout") return json({ error: "Request body timed out" }, 408);
      if (parsed.kind === "invalid") return json({ error: "Invalid JSON body" }, 400);
      const raw = parsed.body;
      const body = validateBody(raw, "patch");
      if (!body) return json({ error: "Invalid provider connection" }, 400);
      const apiKey = await encryptApiKey(body.apiKey, options, identity.tenantId, connectionId);
      const merged: CloudProviderConnectionInput = {
        ...existing,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(body.name !== undefined ? { name: body.name as string | null } : {}),
        ...(body.priority !== undefined ? { priority: body.priority as number } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive as boolean } : {}),
        id: connectionId,
        tenantId: identity.tenantId,
        updatedAt: timestamp,
      };
      const results = await options.db.batch([
        prepareCloudProviderConnectionUpdate(options.db, identity.tenantId, connectionId, merged, {
          provider: SUPPORTED_PROVIDER,
          credentialOwnership: "customer_managed",
          executionLocation: "third_party",
        }),
        auditStatement(
          options.db,
          identity,
          request,
          "customer.provider_connection.update",
          connectionId,
          timestamp,
          { provider: SUPPORTED_PROVIDER, credentialsUpdated: body.apiKey !== undefined }
        ),
      ]);
      if (!mutationChanged(results[0])) return json({ error: "Not found" }, 404);
      const updated = await getCloudProviderConnectionById(
        options.db,
        identity.tenantId,
        connectionId
      );
      return updated ? json(safeConnection(updated)) : json({ error: "Not found" }, 404);
    }

    const results = await options.db.batch([
      prepareCloudProviderConnectionDelete(options.db, identity.tenantId, connectionId, {
        provider: SUPPORTED_PROVIDER,
        credentialOwnership: "customer_managed",
        executionLocation: "third_party",
      }),
      auditStatement(
        options.db,
        identity,
        request,
        "customer.provider_connection.delete",
        connectionId,
        timestamp,
        { provider: SUPPORTED_PROVIDER }
      ),
    ]);
    if (!mutationChanged(results[0])) return json({ error: "Not found" }, 404);
    return json({ deleted: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Cloud credential encryption is unavailable") {
      return json({ error: "Cloud credential encryption is unavailable" }, 503);
    }
    return json({ error: "Customer provider connection request could not be completed" }, 503);
  }
}

/** Customer public API path; identity is always derived from its bearer API key. */
export function handleCloudCustomerProviderRequest(
  request: Request,
  options: CloudCustomerProviderApiOptions
): Promise<Response | null> {
  return handleCloudCustomerProviderRequestCore(request, options);
}

/**
 * Internal OIDC portal path. Call only after the OIDC session and owner/admin role are validated.
 * The public customer path never accepts this trusted identity argument.
 */
export function handleCloudCustomerProviderPortalRequest(
  request: Request,
  options: CloudCustomerProviderApiOptions,
  identity: CloudCustomerProviderPortalIdentity
): Promise<Response | null> {
  return handleCloudCustomerProviderRequestCore(request, options, identity);
}
