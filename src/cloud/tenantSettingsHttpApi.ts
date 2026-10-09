import type { CloudDb } from "./db";
import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import type {
  GatewayCoordinatorStub,
  GatewayDurableObjectNamespace,
} from "./connectorGatewayDurableObject";
import { listCloudGatewayDeviceIds } from "./gatewayDevices";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";
import { getCloudTenantSettings, updateCloudTenantSettings } from "./tenantSettings";

export const CLOUD_CUSTOMER_SETTINGS_PATH = "/__cloud/v1/customer/settings";
const MAX_BODY_BYTES = 16 * 1024;
const BODY_READ_TIMEOUT_MS = 5_000;
const CUSTOMER_SETTINGS_AUTH_LIMIT = { limit: 600, windowMs: 60_000 };
const CUSTOMER_SETTINGS_AUTH_FALLBACK_LIMIT = { limit: 100, windowMs: 60_000 };

export interface CloudCustomerSettingsApiOptions {
  db?: CloudDb;
  sessions?: GatewayDurableObjectNamespace<GatewayCoordinatorStub>;
  now?: () => Date;
  /** Test overrides for the bounded public request guards. */
  bodyReadTimeoutMs?: number;
  failedKeyRateLimit?: { limit: number; windowMs: number };
  failedKeyFallbackRateLimit?: { limit: number; windowMs: number };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function readCloudCustomerSettingsBody(
  request: Request,
  timeoutMs: number
): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return json({ error: "Expected application/json" }, 415);
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: "Request body is too large" }, 413);
  }
  if (!request.body) return json({ error: "Invalid JSON body" }, 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let cancellationStarted = false;
  const cancelReader = () => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    void reader
      .cancel()
      .catch(() => undefined)
      .finally(() => {
        try {
          reader.releaseLock();
        } catch {
          // The stream may already have released the lock during cancellation.
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
        cancelReader();
        return json({ error: "Request body is too large" }, 413);
      }
      chunks.push(value);
    }
  } catch {
    cancelReader();
    return json({ error: "Request body could not be read" }, 408);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!cancellationStarted) reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
}

export async function invalidateCloudTenantDeviceSessions(
  db: CloudDb,
  sessions: GatewayDurableObjectNamespace<GatewayCoordinatorStub> | undefined,
  tenantId: string,
  timestamp: string
): Promise<void> {
  const deviceIds = await listCloudGatewayDeviceIds(db, tenantId);
  if (deviceIds.length === 0) return;
  if (!sessions) throw new Error("Gateway sessions are unavailable");
  await Promise.all(
    deviceIds.map((deviceId) =>
      sessions.get(sessions.idFromName(deviceId)).revokeSession(deviceId, timestamp)
    )
  );
}

/** Customer-facing opt-in settings are scoped solely from the authenticated API key. */
export async function handleCloudCustomerSettingsRequest(
  request: Request,
  options: CloudCustomerSettingsApiOptions
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== CLOUD_CUSTOMER_SETTINGS_PATH) return null;
  if (request.method !== "GET" && request.method !== "PUT") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!options.db) return json({ error: "Cloud database is not configured" }, 503);

  const clientIpBucket = cloudflareClientIpBucket(request);
  try {
    const authLimit = await consumeCloudRateLimit(options.db, {
      tenantId: "tenant_shiryu_admin",
      bucketKey: `customer-settings-auth:${clientIpBucket ?? "fallback"}`,
      ...(clientIpBucket
        ? (options.failedKeyRateLimit ?? CUSTOMER_SETTINGS_AUTH_LIMIT)
        : (options.failedKeyFallbackRateLimit ?? CUSTOMER_SETTINGS_AUTH_FALLBACK_LIMIT)),
      nowMs: (options.now ?? (() => new Date()))().getTime(),
    });
    if (!authLimit.allowed) return json({ error: "Authentication rate limit exceeded" }, 429);
  } catch {
    return json({ error: "Authentication rate limit is unavailable" }, 503);
  }
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (orc_live_[A-Za-z0-9_-]{1,96})$/.exec(authorization);
  if (!match) return json({ error: "Unauthorized" }, 401);
  const now = options.now ?? (() => new Date());
  const timestamp = now().toISOString();
  let identity;
  try {
    identity = await authenticateCloudCustomerApiKey(options.db, match[1], timestamp);
  } catch {
    return json({ error: "Customer authentication is unavailable" }, 503);
  }
  if (!identity) return json({ error: "Unauthorized" }, 401);

  try {
    const rateLimit = await consumeCloudRateLimit(options.db, {
      tenantId: identity.tenantId,
      bucketKey: "customer-settings",
      limit: 60,
      windowMs: 60_000,
      nowMs: now().getTime(),
    });
    if (!rateLimit.allowed) return json({ error: "Customer settings rate limit exceeded" }, 429);

    if (request.method === "GET") {
      const settings = await getCloudTenantSettings(options.db, identity.tenantId);
      return settings ? json(settings) : json({ error: "Customer settings are unavailable" }, 503);
    }

    if (identity.role !== "owner" && identity.role !== "admin") {
      return json({ error: "Owner or admin membership is required" }, 403);
    }
    const body = await readCloudCustomerSettingsBody(
      request,
      options.bodyReadTimeoutMs ?? BODY_READ_TIMEOUT_MS
    );
    if (body instanceof Response) return body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !("localAiEnabled" in body) ||
      !("mcpEnabled" in body) ||
      typeof body.localAiEnabled !== "boolean" ||
      typeof body.mcpEnabled !== "boolean"
    ) {
      return json({ error: "Expected localAiEnabled and mcpEnabled booleans" }, 400);
    }

    const currentSettings = await getCloudTenantSettings(options.db, identity.tenantId);
    if (!currentSettings) return json({ error: "Customer settings are unavailable" }, 503);
    const timestamp = now().toISOString();
    if (body.localAiEnabled && !currentSettings.localAiEnabled) {
      await invalidateCloudTenantDeviceSessions(
        options.db,
        options.sessions,
        identity.tenantId,
        timestamp
      );
    }
    const settings = await updateCloudTenantSettings(options.db, {
      tenantId: identity.tenantId,
      membershipId: identity.membershipId,
      authorization: { type: "api_key", apiKeyId: identity.apiKeyId },
      localAiEnabled: body.localAiEnabled,
      mcpEnabled: body.mcpEnabled,
      updatedAt: timestamp,
      audit: {
        id: crypto.randomUUID(),
        tenantId: identity.tenantId,
        timestamp,
        action: "customer.settings.update",
        actor: `api-key:${identity.apiKeyId}`,
        target: "tenant-settings",
        resourceType: "customer-settings",
        status: "success",
        requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
        metadata: {
          localAiEnabled: body.localAiEnabled,
          mcpEnabled: body.mcpEnabled,
        },
      },
    });
    if (!body.localAiEnabled) {
      await invalidateCloudTenantDeviceSessions(
        options.db,
        options.sessions,
        identity.tenantId,
        timestamp
      );
    }
    return settings
      ? json(settings)
      : json({ error: "Owner or admin membership is required" }, 403);
  } catch {
    return json({ error: "Customer settings could not be updated" }, 503);
  }
}
