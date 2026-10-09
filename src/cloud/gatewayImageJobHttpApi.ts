import { appendCloudComplianceAudit } from "./complianceAudit";
import type { CloudDb } from "./db";
import {
  CLOUD_IMAGE_CAPABILITY,
  CLOUD_IMAGE_MAX_ARTIFACT_BYTES,
  parseCloudImageJobParameters,
} from "../shared/imageJobContract";
import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import { getCloudTenantSettings } from "./tenantSettings";
import { D1GatewayDeviceDirectory } from "./gatewayDevices";
import { createConnectorGateway, type GatewayDeviceRequest } from "./connectorGateway";
import type {
  GatewayCoordinatorStub,
  GatewayDurableObjectNamespace,
} from "./connectorGatewayDurableObject";
import { coordinatorFromNamespace } from "./gatewayHttpApi";
import { consumeCloudRateLimit } from "./rateLimit";
import {
  attachCloudImageArtifact,
  cancelCloudImageJob,
  CLOUD_IMAGE_JOB_RETENTION_MS,
  CLOUD_IMAGE_JOB_TIMEOUT_MS,
  completeCloudImageJob,
  createCloudImageJob,
  expireCloudImageJobIfNeeded,
  failCloudImageJob,
  getCloudImageJob,
  getCloudImageJobByIdempotencyHash,
  markCloudImageJobRunning,
  releaseCloudImageArtifactUpload,
  reserveCloudImageArtifactUpload,
  type CloudImageJob,
  type CloudImageJobFailureCode,
  type GatewayImageArtifactBucket,
} from "./imageJobs";

const CUSTOMER_PATH = "/__gateway/v1/customer/image-jobs";
const DEVICE_PATH = "/__gateway/v1/device/image-jobs";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = CLOUD_IMAGE_MAX_ARTIFACT_BYTES;
const JOB_ID = /^[a-f0-9-]{36}$/i;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/;
const PROMPT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_FAILURE_CODES = new Set<CloudImageJobFailureCode>([
  "execution_failed",
  "capability_unavailable",
  "artifact_upload_failed",
  "cancelled",
  "expired",
]);
const START_LIMIT = { limit: 10, windowMs: 60_000 };
const DEVICE_ACTION_LIMIT = { limit: 120, windowMs: 60_000 };

export interface GatewayImageJobHttpApiOptions {
  db?: CloudDb;
  sessions?: GatewayDurableObjectNamespace<GatewayCoordinatorStub>;
  artifacts?: GatewayImageArtifactBucket;
  now?: () => number;
  startRateLimit?: { limit: number; windowMs: number };
  bodyReadTimeoutMs?: number;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function nowIso(options: GatewayImageJobHttpApiOptions): string {
  return new Date(options.now?.() ?? Date.now()).toISOString();
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer (orc_live_[A-Za-z0-9_-]{32,64})$/.exec(value);
  return match?.[1] ?? null;
}

function deviceSession(request: Request): { deviceId: string; token: string } | null {
  const deviceId = request.headers.get("x-device-id") ?? "";
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(auth);
  return DEVICE_ID.test(deviceId) && match ? { deviceId, token: match[1] } : null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(
  request: Request,
  timeoutMs = 10_000
): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  const advertised = Number(request.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_JSON_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      cancel();
      reject(new Error("request body timeout"));
    }, timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
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
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function identityOwnsJob(
  job: CloudImageJob,
  identity: { tenantId: string; principalId: string; apiKeyId: string }
): boolean {
  return (
    job.tenantId === identity.tenantId &&
    job.principalId === identity.principalId &&
    job.apiKeyId === identity.apiKeyId
  );
}

function publicJob(job: CloudImageJob) {
  return {
    jobId: job.jobId,
    status: job.state,
    imageAvailable: job.state === "succeeded",
    ...(job.state === "failed" && job.errorCode ? { error: job.errorCode } : {}),
  };
}

function imageTypeFromBytes(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

async function readArtifact(request: Request, timeoutMs = 30_000): Promise<Uint8Array | null> {
  const advertised = request.headers.get("content-length");
  if (
    advertised !== null &&
    (!/^\d+$/.test(advertised) || Number(advertised) < 1 || Number(advertised) > MAX_ARTIFACT_BYTES)
  ) {
    void request.body?.cancel("artifact body rejected").catch(() => undefined);
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancellationStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    void reader.cancel("artifact upload rejected").catch(() => undefined);
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      cancel();
      reject(new Error("artifact upload timeout"));
    }, timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARTIFACT_BYTES) {
        cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!cancellationStarted) reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (advertised !== null && Number(advertised) !== bytes.byteLength) return null;
  return bytes;
}

async function customerIdentity(
  request: Request,
  options: GatewayImageJobHttpApiOptions
): Promise<Awaited<ReturnType<typeof authenticateCloudCustomerApiKey>>> {
  const token = bearer(request);
  if (!token || !options.db) return null;
  return authenticateCloudCustomerApiKey(options.db, token, nowIso(options));
}

function pathParts(path: string, prefix: string): string[] | null {
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  return path.slice(prefix.length).split("/").filter(Boolean);
}

async function handleCustomer(
  request: Request,
  options: GatewayImageJobHttpApiOptions,
  parts: string[]
): Promise<Response> {
  if (!options.db || !options.sessions || !options.artifacts)
    return json({ error: "Image jobs are unavailable" }, 503);
  if (request.url.includes("?") || (request.headers.has("authorization") && !bearer(request))) {
    return json({ error: "Unsupported image-job request metadata" }, 400);
  }
  const identity = await customerIdentity(request, options);
  if (!identity) return json({ error: "Unauthorized" }, 401);
  if (identity.role === "viewer") return json({ error: "Customer role is not permitted" }, 403);
  let settings;
  try {
    settings = await getCloudTenantSettings(options.db, identity.tenantId);
  } catch {
    return json({ error: "Image jobs are unavailable" }, 503);
  }
  if (!settings?.localAiEnabled)
    return json({ error: "Local AI is disabled for this tenant" }, 403);
  const now = nowIso(options);

  if (parts.length === 0) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey))
      return json({ error: "A valid Idempotency-Key header is required" }, 400);
    const body = await readJson(request, options.bodyReadTimeoutMs);
    if (!body || typeof body.deviceId !== "string" || !DEVICE_ID.test(body.deviceId)) {
      return json({ error: "Invalid image-job request" }, 400);
    }
    const { deviceId, ...untrustedParameters } = body;
    const parameters = parseCloudImageJobParameters(untrustedParameters);
    if (!parameters) return json({ error: "Invalid image-job parameters" }, 400);

    const idempotencyHash = await sha256(JSON.stringify([identity.tenantId, idempotencyKey]));
    const fingerprintHash = await sha256(
      canonicalJson({
        tenantId: identity.tenantId,
        principalId: identity.principalId,
        apiKeyId: identity.apiKeyId,
        deviceId,
        capability: CLOUD_IMAGE_CAPABILITY,
        parameters,
      })
    );
    const existing = await getCloudImageJobByIdempotencyHash(options.db, idempotencyHash);
    if (existing) {
      if (!identityOwnsJob(existing, identity) || existing.fingerprintHash !== fingerprintHash) {
        return json({ error: "Idempotency-Key was already used for a different operation" }, 409);
      }
      return json(
        { jobId: existing.jobId, status: existing.state, expiresAt: existing.expiresAt },
        202
      );
    }

    const rate = await consumeCloudRateLimit(options.db, {
      tenantId: identity.tenantId,
      bucketKey: "gateway-customer-image-job-start",
      ...(options.startRateLimit ?? START_LIMIT),
      nowMs: options.now?.(),
    }).catch(() => null);
    if (!rate) return json({ error: "Image-job rate limit is unavailable" }, 503);
    if (!rate.allowed) return json({ error: "Image-job rate limit exceeded" }, 429);

    const coordinator = coordinatorFromNamespace(options.sessions);
    const gateway = createConnectorGateway({
      directory: new D1GatewayDeviceDirectory(options.db),
      coordinator,
      now: options.now,
    });
    const authorization = await gateway.authorizeCapability({
      tenantId: identity.tenantId,
      deviceId,
      capability: CLOUD_IMAGE_CAPABILITY,
    });
    if (!authorization.ok) {
      const status =
        authorization.reason === "tenant_mismatch"
          ? 404
          : authorization.reason === "capability_unavailable"
            ? 409
            : 503;
      return json(
        {
          error:
            authorization.reason === "capability_unavailable"
              ? "Image capability is unavailable"
              : "Device is unavailable",
        },
        status
      );
    }

    const jobId = crypto.randomUUID();
    const timestampMs = options.now?.() ?? Date.now();
    const createdAt = new Date(timestampMs).toISOString();
    const expiresAt = new Date(timestampMs + CLOUD_IMAGE_JOB_TIMEOUT_MS).toISOString();
    const retentionExpiresAt = new Date(timestampMs + CLOUD_IMAGE_JOB_RETENTION_MS).toISOString();
    const objectKey = `private-image-jobs/${crypto.randomUUID()}`;
    let created;
    try {
      created = await createCloudImageJob(options.db, {
        jobId,
        tenantId: identity.tenantId,
        principalId: identity.principalId,
        apiKeyId: identity.apiKeyId,
        deviceId,
        sessionId: authorization.target.sessionId,
        idempotencyHash,
        fingerprintHash,
        objectKey,
        createdAt,
        expiresAt,
        retentionExpiresAt,
      });
    } catch {
      return json({ error: "Image-job capacity is unavailable" }, 429);
    }
    if (!created.job) return json({ error: "Image-job capacity is unavailable" }, 429);
    if (!created.created) {
      if (
        !identityOwnsJob(created.job, identity) ||
        created.job.fingerprintHash !== fingerprintHash
      ) {
        return json({ error: "Idempotency-Key was already used for a different operation" }, 409);
      }
      return json(
        { jobId: created.job.jobId, status: created.job.state, expiresAt: created.job.expiresAt },
        202
      );
    }

    try {
      await appendCloudComplianceAudit(options.db, {
        id: crypto.randomUUID(),
        tenantId: identity.tenantId,
        timestamp: createdAt,
        action: "gateway.customer.image_job",
        actor: identity.principalId,
        target: deviceId,
        resourceType: "gateway-image-job",
        status: "attempted",
        metadata: { apiKeyId: identity.apiKeyId, jobId },
      });
    } catch {
      await failCloudImageJob(options.db, {
        jobId,
        sessionId: authorization.target.sessionId,
        code: "execution_failed",
        now: nowIso(options),
      });
      return json({ error: "Image-job audit is unavailable" }, 503);
    }

    const payload = JSON.stringify(parameters);
    const queued: GatewayDeviceRequest = {
      requestId: jobId,
      tenantId: identity.tenantId,
      sessionId: authorization.target.sessionId,
      capability: CLOUD_IMAGE_CAPABILITY,
      payload,
      createdAt,
      expiresAt,
      status: "pending",
    };
    try {
      if (!(await coordinator.enqueueRequest(deviceId, queued))) {
        await failCloudImageJob(options.db, {
          jobId,
          sessionId: authorization.target.sessionId,
          code: "capability_unavailable",
          now: nowIso(options),
        });
        return json({ error: "Device request queue is full" }, 429);
      }
    } catch {
      // The enqueue result can be uncertain. Keep the stable job/request ID so
      // a retry cannot dispatch a second image generation under this key.
    }
    return json({ jobId, status: "queued", expiresAt }, 202);
  }

  const jobId = parts[0];
  if (!JOB_ID.test(jobId) || parts.length > 2) return json({ error: "Not found" }, 404);
  const job = await getCloudImageJob(options.db, jobId);
  if (!job || !identityOwnsJob(job, identity)) return json({ error: "Image job not found" }, 404);
  const device = await new D1GatewayDeviceDirectory(options.db).getDevice(job.deviceId);
  if (!device || device.tenantId !== identity.tenantId || device.revokedAt) {
    await failCloudImageJob(options.db, {
      jobId,
      sessionId: job.sessionId,
      code: "cancelled",
      now,
    }).catch(() => false);
    return json({ error: "Image job not found" }, 404);
  }
  const current = await expireCloudImageJobIfNeeded(options.db, job, now);
  if (
    current.state === "expired" &&
    (job.state === "queued" || job.state === "running") &&
    job.artifactBytes !== null
  ) {
    await options.artifacts.delete(job.objectKey).catch(() => undefined);
  }

  if (parts.length === 2 && parts[1] === "image") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (current.state !== "succeeded" || current.retentionExpiresAt <= now)
      return json({ error: "Image result is unavailable" }, 404);
    const object = await options.artifacts.get(current.objectKey);
    if (!object?.body || !current.artifactContentType || !current.artifactBytes)
      return json({ error: "Image result is unavailable" }, 404);
    return new Response(object.body, {
      status: 200,
      headers: {
        "Content-Type": current.artifactContentType,
        "Content-Length": String(current.artifactBytes),
        "Content-Disposition": `inline; filename="generated-image.${current.artifactContentType === "image/png" ? "png" : current.artifactContentType === "image/jpeg" ? "jpg" : "webp"}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ETag: `"${current.artifactSha256}"`,
      },
    });
  }
  if (parts.length !== 1) return json({ error: "Not found" }, 404);
  if (request.method === "GET") {
    return json(publicJob(current));
  }
  if (request.method === "DELETE") {
    if (current.state !== "queued" && current.state !== "running") {
      return json({ error: "Image job is already terminal" }, 409);
    }
    const cancelled = await cancelCloudImageJob(options.db, jobId, identity, now);
    if (!cancelled || cancelled.state !== "cancelled")
      return json({ error: "Image job could not be cancelled" }, 409);
    await coordinatorFromNamespace(options.sessions)
      .deleteRequest(job.deviceId, job.requestId)
      .catch(() => undefined);
    if (cancelled.artifactBytes !== null)
      await options.artifacts.delete(cancelled.objectKey).catch(() => undefined);
    return json({ jobId, status: "cancelled", expiresAt: cancelled.expiresAt }, 202);
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleDevice(
  request: Request,
  options: GatewayImageJobHttpApiOptions,
  parts: string[]
): Promise<Response> {
  if (!options.db || !options.sessions || !options.artifacts)
    return json({ error: "Image jobs are unavailable" }, 503);
  if (parts.length !== 2 || !JOB_ID.test(parts[0])) return json({ error: "Not found" }, 404);
  const [requestId, action] = parts;
  const session = deviceSession(request);
  if (!session) return json({ error: "Unauthorized" }, 401);
  if (request.url.includes("?"))
    return json({ error: "Unsupported image-job request metadata" }, 400);
  const coordinator = coordinatorFromNamespace(options.sessions);
  const gateway = createConnectorGateway({
    directory: new D1GatewayDeviceDirectory(options.db),
    coordinator,
    now: options.now,
  });
  const authenticated = await gateway.authenticateSession(session.deviceId, session.token);
  if (!authenticated) return json({ error: "Device session is unavailable" }, 401);
  const job = await getCloudImageJob(options.db, requestId);
  if (
    !job ||
    job.requestId !== requestId ||
    job.deviceId !== session.deviceId ||
    job.tenantId !== authenticated.tenantId ||
    job.sessionId !== authenticated.sessionId
  ) {
    return json({ error: "Image job is unavailable" }, 404);
  }
  const now = nowIso(options);
  const limit = await consumeCloudRateLimit(options.db, {
    tenantId: job.tenantId,
    bucketKey: `gateway-device:image-job:${action}:${job.deviceId}`,
    ...DEVICE_ACTION_LIMIT,
    nowMs: options.now?.(),
  }).catch(() => null);
  if (!limit) return json({ error: "Image-job rate limit is unavailable" }, 503);
  if (!limit.allowed) return json({ error: "Image-job rate limit exceeded" }, 429);

  if (action === "control" && request.method === "GET") {
    const current = await expireCloudImageJobIfNeeded(options.db, job, now);
    if (current.state === "expired") {
      if (job.artifactBytes !== null)
        await options.artifacts.delete(job.objectKey).catch(() => undefined);
      return json({ status: "expired" });
    }
    if (current.state === "cancelled") return json({ status: "cancelled" });
    if (current.state === "queued") {
      await markCloudImageJobRunning(options.db, job.jobId, authenticated.sessionId, now);
    }
    const latest = await getCloudImageJob(options.db, job.jobId);
    return json({
      status:
        latest?.state === "expired"
          ? "expired"
          : latest?.state === "running"
            ? "running"
            : "cancelled",
    });
  }

  if (action === "artifact" && request.method === "PUT") {
    if (request.headers.has("content-encoding") || request.headers.has("content-range")) {
      return json({ error: "Unsupported artifact encoding" }, 400);
    }
    const current = await expireCloudImageJobIfNeeded(options.db, job, now);
    if (current.state !== "queued" && current.state !== "running")
      return json({ error: "Image job is no longer active" }, 409);
    const bytes = await readArtifact(request, options.bodyReadTimeoutMs ?? 30_000);
    if (!bytes || bytes.byteLength < 1)
      return json({ error: "Invalid or oversized image artifact" }, 413);
    const contentType = imageTypeFromBytes(bytes);
    if (
      !contentType ||
      request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== contentType
    ) {
      return json({ error: "Unsupported image artifact" }, 415);
    }
    const uploadToken = crypto.randomUUID();
    if (
      !(await reserveCloudImageArtifactUpload(options.db, {
        jobId: requestId,
        sessionId: authenticated.sessionId,
        uploadToken,
        now,
      }))
    ) {
      return json({ error: "Image artifact was already uploaded or job is unavailable" }, 409);
    }
    const digest = await sha256(bytes);
    try {
      await options.artifacts.put(job.objectKey, bytes, {
        httpMetadata: { contentType },
        customMetadata: { sha256: digest, jobId: requestId },
      });
      const attached = await attachCloudImageArtifact(options.db, {
        jobId: requestId,
        sessionId: authenticated.sessionId,
        uploadToken,
        contentType,
        bytes: bytes.byteLength,
        sha256: digest,
        now: nowIso(options),
      });
      if (!attached) {
        await options.artifacts.delete(job.objectKey).catch(() => undefined);
        await releaseCloudImageArtifactUpload(options.db, requestId, uploadToken).catch(
          () => undefined
        );
        return json({ error: "Image artifact was rejected" }, 409);
      }
    } catch {
      await options.artifacts.delete(job.objectKey).catch(() => undefined);
      await releaseCloudImageArtifactUpload(options.db, requestId, uploadToken).catch(
        () => undefined
      );
      return json({ error: "Image artifact could not be stored" }, 503);
    }
    return json({ accepted: true });
  }

  if (action === "complete" && request.method === "POST") {
    const body = await readJson(request, options.bodyReadTimeoutMs);
    if (
      !body ||
      Object.keys(body).length !== 1 ||
      typeof body.promptId !== "string" ||
      !PROMPT_ID.test(body.promptId)
    ) {
      return json({ error: "Invalid image-job completion" }, 400);
    }
    const completed = await completeCloudImageJob(options.db, {
      jobId: requestId,
      sessionId: authenticated.sessionId,
      promptId: body.promptId,
      now: nowIso(options),
    });
    if (!completed) return json({ error: "Image-job completion was rejected" }, 409);
    await coordinator.deleteRequest(job.deviceId, requestId).catch(() => undefined);
    return json({ accepted: true });
  }

  if (action === "fail" && request.method === "POST") {
    const body = await readJson(request, options.bodyReadTimeoutMs);
    if (
      !body ||
      Object.keys(body).length !== 1 ||
      typeof body.code !== "string" ||
      !SAFE_FAILURE_CODES.has(body.code as CloudImageJobFailureCode)
    ) {
      return json({ error: "Invalid image-job failure" }, 400);
    }
    const failed = await failCloudImageJob(options.db, {
      jobId: requestId,
      sessionId: authenticated.sessionId,
      code: body.code as CloudImageJobFailureCode,
      now: nowIso(options),
    });
    if (!failed) return json({ error: "Image-job failure was rejected" }, 409);
    await coordinator.deleteRequest(job.deviceId, requestId).catch(() => undefined);
    const failedJob = await getCloudImageJob(options.db, requestId);
    if (failedJob?.artifactBytes !== null && failedJob?.artifactBytes !== undefined) {
      await options.artifacts.delete(failedJob.objectKey).catch(() => undefined);
    }
    return json({ accepted: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

/** Handles the narrow customer and device image-job API surface. */
export async function handleGatewayImageJobRequest(
  request: Request,
  options: GatewayImageJobHttpApiOptions
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === CUSTOMER_PATH || url.pathname.startsWith(`${CUSTOMER_PATH}/`)) {
    const parts = pathParts(url.pathname, CUSTOMER_PATH);
    return parts ? handleCustomer(request, options, parts) : json({ error: "Not found" }, 404);
  }
  if (url.pathname === DEVICE_PATH || url.pathname.startsWith(`${DEVICE_PATH}/`)) {
    const parts = pathParts(url.pathname, DEVICE_PATH);
    return parts ? handleDevice(request, options, parts) : json({ error: "Not found" }, 404);
  }
  return null;
}
