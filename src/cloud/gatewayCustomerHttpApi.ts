import { appendCloudComplianceAudit } from "./complianceAudit";
import { createConnectorGateway } from "./connectorGateway";
import type {
  GatewayCoordinatorStub,
  GatewayDurableObjectNamespace,
} from "./connectorGatewayDurableObject";
import { coordinatorFromNamespace } from "./gatewayHttpApi";
import type { CloudDb } from "./db";
import { D1GatewayDeviceDirectory } from "./gatewayDevices";
import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";
import { appendCloudUsageRecord } from "./usage";
import { CLOUD_PLATFORM_TENANT_ID } from "./tenants";
import {
  claimGatewayIdempotency,
  completeGatewayIdempotency,
  markGatewayIdempotencyPreflight,
  releaseGatewayIdempotencyClaim,
} from "./gatewayIdempotency";

const PATH = "/__gateway/v1/customer/invoke";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CAPABILITY = /^[A-Za-z0-9_:.\/-]{1,128}$/;
// Per tenant, allow at most 30 local capability starts in a rolling minute.
const DEFAULT_INVOKE_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
const DEFAULT_FAILED_KEY_RATE_LIMIT = { limit: 600, windowMs: 60_000 };
const DEFAULT_FAILED_KEY_FALLBACK_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

export interface GatewayCustomerHttpApiOptions {
  db?: CloudDb;
  sessions?: GatewayDurableObjectNamespace<GatewayCoordinatorStub>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  rateLimit?: { limit: number; windowMs: number };
  failedKeyRateLimit?: { limit: number; windowMs: number };
  failedKeyFallbackRateLimit?: { limit: number; windowMs: number };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function requestIdFrom(request: Request): string | null {
  const value = request.headers.get("cf-ray") ?? request.headers.get("x-request-id");
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer (orc_live_[A-Za-z0-9_-]{32,64})$/.exec(value);
  return match?.[1] ?? null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  const advertisedLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_BODY_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resultSize(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return null;
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Customer-authenticated local capability invocation. Tenant scope comes only from the D1 key. */
export async function handleGatewayCustomerRequest(
  request: Request,
  options: GatewayCustomerHttpApiOptions
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== PATH) return json({ error: "Not found" }, 404);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (url.search || !options.db || !options.sessions) {
    return json(
      { error: url.search ? "Unsupported request metadata" : "Gateway is not configured" },
      url.search ? 400 : 503
    );
  }
  const token = bearerToken(request);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const clientIpBucket = cloudflareClientIpBucket(request);
  if (clientIpBucket) {
    // Worker-ingress IP limiting happens before the D1 key lookup, so a
    // stream of distinct invalid keys cannot bypass the same source bucket.
    const rateLimit = await consumeCloudRateLimit(options.db, {
      tenantId: CLOUD_PLATFORM_TENANT_ID,
      bucketKey: `customer-key-auth:${clientIpBucket}`,
      ...(options.failedKeyRateLimit ?? DEFAULT_FAILED_KEY_RATE_LIMIT),
      nowMs: options.now?.(),
    });
    if (!rateLimit.allowed) return json({ error: "Authentication rate limit exceeded" }, 429);
  }
  const identity = await authenticateCloudCustomerApiKey(
    options.db,
    token,
    new Date(options.now?.() ?? Date.now()).toISOString()
  );
  if (!identity) {
    if (clientIpBucket) return json({ error: "Unauthorized" }, 401);
    // Trust the Cloudflare-managed visitor IP only on Worker ingress carrying
    // edge metadata. Non-Worker callers use the presented key as a bounded,
    // stable fallback identity; both bucket labels are SHA-256 hashed in D1.
    const rateLimit = await consumeCloudRateLimit(options.db, {
      tenantId: CLOUD_PLATFORM_TENANT_ID,
      bucketKey: `customer-key-auth:${token}`,
      ...(options.failedKeyFallbackRateLimit ?? DEFAULT_FAILED_KEY_FALLBACK_RATE_LIMIT),
      nowMs: options.now?.(),
    });
    return rateLimit.allowed
      ? json({ error: "Unauthorized" }, 401)
      : json({ error: "Authentication rate limit exceeded" }, 429);
  }
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(idempotencyKey)) {
    return json({ error: "A valid Idempotency-Key header is required" }, 400);
  }

  const body = await readBody(request);
  if (!body) return json({ error: "Invalid or oversized JSON body" }, 400);
  const allowedFields = ["deviceId", "capability", "payload", "timeoutMs"];
  if (Object.keys(body).some((key) => !allowedFields.includes(key))) {
    return json({ error: "Unsupported invocation fields" }, 400);
  }
  if (
    typeof body.deviceId !== "string" ||
    !DEVICE_ID.test(body.deviceId) ||
    typeof body.capability !== "string" ||
    !CAPABILITY.test(body.capability) ||
    !("payload" in body)
  ) {
    return json({ error: "Invalid invocation request" }, 400);
  }
  const timeoutMs = body.timeoutMs === undefined ? 15_000 : body.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30_000
  ) {
    return json({ error: "timeoutMs must be between 100 and 30000" }, 400);
  }
  if (identity.role === "viewer") {
    try {
      await appendCloudComplianceAudit(options.db, {
        id: crypto.randomUUID(),
        tenantId: identity.tenantId,
        timestamp: new Date(options.now?.() ?? Date.now()).toISOString(),
        action: "gateway.customer.invoke",
        actor: identity.principalId,
        target: body.deviceId,
        resourceType: "gateway-capability",
        status: "denied",
        requestId: requestIdFrom(request),
        metadata: { apiKeyId: identity.apiKeyId, capability: body.capability, role: identity.role },
      });
    } catch {
      return json({ error: "Invocation audit is unavailable" }, 503);
    }
    return json({ error: "Customer role is not permitted to invoke local capabilities" }, 403);
  }
  const payloadBytes = resultSize(body.payload);
  if (payloadBytes === null || payloadBytes > MAX_BODY_BYTES) {
    return json({ error: "Invocation payload exceeds the size limit" }, 413);
  }

  const db = options.db;
  const nowMs = options.now?.() ?? Date.now();
  const timestamp = new Date(nowMs).toISOString();
  const requestId = requestIdFrom(request);
  const auditBase = {
    tenantId: identity.tenantId,
    actor: identity.principalId,
    target: body.deviceId,
    resourceType: "gateway-capability",
    requestId,
    metadata: { apiKeyId: identity.apiKeyId, capability: body.capability },
  };

  const proposedRequestId = crypto.randomUUID();
  const claimToken = crypto.randomUUID();
  let idempotency: Awaited<ReturnType<typeof claimGatewayIdempotency>>;
  try {
    idempotency = await claimGatewayIdempotency(db, {
      key: idempotencyKey,
      scope: {
        tenantId: identity.tenantId,
        principalId: identity.principalId,
        apiKeyId: identity.apiKeyId,
      },
      operation: {
        deviceId: body.deviceId,
        capability: body.capability,
        payload: body.payload,
      },
      requestId: proposedRequestId,
      claimToken,
      nowMs,
    });
  } catch {
    return json({ error: "Invocation idempotency storage is unavailable" }, 503);
  }
  if (idempotency.kind === "conflict") {
    return json({ error: "Idempotency-Key was already used for a different operation" }, 409);
  }
  if (idempotency.kind === "capacity") {
    return json({ error: "Invocation idempotency storage is full or invalid" }, 503);
  }
  if (idempotency.kind === "replay") {
    // A completed response can contain local device output. Re-check the
    // authoritative device record before returning it so revocation also
    // stops access through a previously completed idempotency key.
    const device = await new D1GatewayDeviceDirectory(db).getDevice(body.deviceId);
    if (!device || device.tenantId !== identity.tenantId)
      return json({ error: "Device not found" }, 404);
    if (device.revokedAt) return json({ error: "Device is unavailable" }, 503);
    return json(idempotency.response, idempotency.status);
  }
  if (idempotency.kind === "in_progress") {
    return json({ error: "Invocation with this Idempotency-Key is in progress" }, 409);
  }
  const claim = idempotency.claim;
  const releaseClaim = async () => {
    try {
      await releaseGatewayIdempotencyClaim(db, claim, claimToken, options.now?.() ?? Date.now());
    } catch {
      // The claim lease expires automatically if D1 cannot release it now.
    }
  };
  const cacheResponse = async (responseBody: unknown, status: number): Promise<Response> => {
    try {
      const completed = await completeGatewayIdempotency(
        db,
        claim,
        claimToken,
        responseBody,
        status,
        options.now?.() ?? Date.now()
      );
      if (completed.kind === "replay") return json(completed.response, completed.status);
    } catch {
      // Keep the operation pending. A later claimant can recover the same DO result by request ID.
    }
    return json({ error: "Invocation result is unavailable" }, 503);
  };

  if (!claim.rateLimitChecked) {
    let rateLimit: Awaited<ReturnType<typeof consumeCloudRateLimit>>;
    try {
      rateLimit = await consumeCloudRateLimit(db, {
        tenantId: identity.tenantId,
        bucketKey: "gateway-customer-invoke",
        limit: options.rateLimit?.limit ?? DEFAULT_INVOKE_RATE_LIMIT.limit,
        windowMs: options.rateLimit?.windowMs ?? DEFAULT_INVOKE_RATE_LIMIT.windowMs,
        nowMs,
      });
    } catch {
      await releaseClaim();
      return json({ error: "Invocation rate limit is unavailable" }, 503);
    }
    if (!rateLimit.allowed) {
      return cacheResponse({ error: "Customer invocation rate limit exceeded" }, 429);
    }
    try {
      if (!(await markGatewayIdempotencyPreflight(db, claim, claimToken, "rate_limit_checked"))) {
        await releaseClaim();
        return json({ error: "Invocation rate limit is unavailable" }, 503);
      }
    } catch {
      await releaseClaim();
      return json({ error: "Invocation rate limit is unavailable" }, 503);
    }
  }

  try {
    if (!claim.attemptAudited) {
      await appendCloudComplianceAudit(db, {
        id: crypto.randomUUID(),
        ...auditBase,
        timestamp,
        action: "gateway.customer.invoke",
        status: "attempted",
      });
      if (!(await markGatewayIdempotencyPreflight(db, claim, claimToken, "attempt_audited"))) {
        await releaseClaim();
        return json({ error: "Invocation audit is unavailable" }, 503);
      }
    }
  } catch {
    await releaseClaim();
    return json({ error: "Invocation audit is unavailable" }, 503);
  }

  const gateway = createConnectorGateway({
    directory: new D1GatewayDeviceDirectory(db),
    coordinator: coordinatorFromNamespace(options.sessions),
    now: options.now,
    wait: options.wait,
  });
  const invocationStartedAt = performance.now();
  let result: Awaited<ReturnType<typeof gateway.requestCapability>>;
  try {
    result = await gateway.requestCapability({
      tenantId: identity.tenantId,
      deviceId: body.deviceId,
      capability: body.capability,
      payload: body.payload,
      timeoutMs,
      requestId: claim.requestId,
      requestCreatedAt: claim.createdAt,
      requestExpiresAt: claim.expiresAt,
    });
  } catch {
    try {
      await appendCloudComplianceAudit(db, {
        id: crypto.randomUUID(),
        ...auditBase,
        timestamp: new Date(options.now?.() ?? Date.now()).toISOString(),
        action: "gateway.customer.invoke",
        status: "unavailable",
      });
    } catch {
      // The response remains generic; the attempted audit record is retained when D1 is available.
    }
    await releaseClaim();
    return json({ error: "Gateway invocation is unavailable" }, 503);
  }
  const responseResult = result.ok ? result : undefined;
  const responseBytes = responseResult ? resultSize(responseResult.result) : 0;
  const status = result.ok
    ? responseBytes !== null && responseBytes <= MAX_RESULT_BYTES
      ? "success"
      : "result_too_large"
    : result.reason;
  try {
    await appendCloudComplianceAudit(db, {
      id: crypto.randomUUID(),
      ...auditBase,
      timestamp: new Date(options.now?.() ?? Date.now()).toISOString(),
      action: "gateway.customer.invoke",
      status,
    });
  } catch {
    await releaseClaim();
    return json({ error: "Invocation result is unavailable" }, 503);
  }
  if (result.ok) {
    if (responseBytes === null || responseBytes > MAX_RESULT_BYTES) {
      return cacheResponse({ error: "Invocation result exceeds the size limit" }, 502);
    }
    const chatModelPrefix = "ollama:chat:";
    if (body.capability.startsWith(chatModelPrefix)) {
      const envelope = record(result.result);
      const outcome = record(envelope?.outcome);
      const localResult = outcome?.ok === true ? record(outcome.value) : null;
      if (localResult) {
        try {
          const existingUsage = await db
            .prepare("SELECT id FROM cloud_usage_history WHERE tenant_id = ? AND id = ? LIMIT 1")
            .bind(identity.tenantId, result.requestId)
            .first<{ id: string }>();
          if (!existingUsage) {
            await appendCloudUsageRecord(db, {
              id: result.requestId,
              tenantId: identity.tenantId,
              provider: "ollama",
              model: body.capability.slice(chatModelPrefix.length),
              apiKeyId: identity.apiKeyId,
              tokensInput: tokenCount(localResult.prompt_eval_count),
              tokensOutput: tokenCount(localResult.eval_count),
              serviceTier: "customer-managed",
              status: "success",
              success: true,
              latencyMs: Math.max(0, Math.round(performance.now() - invocationStartedAt)),
              endpoint: PATH,
              timestamp: new Date(options.now?.() ?? Date.now()).toISOString(),
            });
          }
        } catch {
          await releaseClaim();
          return json({ error: "Invocation usage accounting is unavailable" }, 503);
        }
      }
    }
    return cacheResponse({ requestId: result.requestId, result: result.result }, 200);
  }

  switch (result.reason) {
    case "tenant_mismatch":
      return cacheResponse({ error: "Device not found" }, 404);
    case "revoked":
    case "offline":
      return cacheResponse({ error: "Device is unavailable" }, 503);
    case "capability_unavailable":
      return cacheResponse({ error: "Capability is unavailable" }, 409);
    case "timeout":
      await releaseClaim();
      return json({ error: "Invocation timed out" }, 504);
    case "queue_full":
      return cacheResponse({ error: "Device request queue is full" }, 429);
  }
}
