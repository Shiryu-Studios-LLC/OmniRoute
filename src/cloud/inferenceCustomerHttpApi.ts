import { appendCloudComplianceAudit } from "./complianceAudit";
import { decryptCloudCredential, isCloudCredentialEnvelope } from "./credentialEncryption";
import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import type { CloudDb } from "./db";
import {
  claimCloudInferenceIdempotency,
  completeCloudInferenceIdempotency,
  markCloudInferenceOutcomeUnavailable,
} from "./inferenceIdempotency";
import {
  getCloudInferenceEntitlement,
  reserveCloudInferenceTokens,
  settleCloudInferenceReservation,
} from "./inferencePolicy";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";
import { getCloudProviderConnections } from "./providers";
import { appendCloudUsageRecord } from "./usage";
import { CLOUD_PLATFORM_TENANT_ID } from "./tenants";

export const CLOUD_INFERENCE_CHAT_PATH = "/v1/chat/completions";
export const CLOUD_INFERENCE_PROVIDER = "openai";
export const CLOUD_INFERENCE_MODEL = "gpt-4o-mini-2024-07-18";
export const CLOUD_INFERENCE_COUNT_URL = "https://api.openai.com/v1/responses/input_tokens";
export const CLOUD_INFERENCE_RESPONSE_URL = "https://api.openai.com/v1/responses";
export const CLOUD_INFERENCE_MAX_REQUEST_BYTES = 32 * 1024;
export const CLOUD_INFERENCE_MAX_COUNT_RESPONSE_BYTES = 4 * 1024;
export const CLOUD_INFERENCE_MAX_RESPONSE_BYTES = 128 * 1024;
export const CLOUD_INFERENCE_MAX_OUTPUT_TOKENS = 2048;
export const CLOUD_INFERENCE_DEFAULT_OUTPUT_TOKENS = 512;
export const CLOUD_INFERENCE_REQUEST_BODY_TIMEOUT_MS = 5_000;
export const CLOUD_INFERENCE_COUNT_TIMEOUT_MS = 10_000;
export const CLOUD_INFERENCE_GENERATION_TIMEOUT_MS = 30_000;

const DEFAULT_CUSTOMER_RATE_LIMIT = { limit: 20, windowMs: 60_000 };
const DEFAULT_FAILED_KEY_RATE_LIMIT = { limit: 600, windowMs: 60_000 };
const DEFAULT_FAILED_KEY_FALLBACK_RATE_LIMIT = { limit: 10, windowMs: 60_000 };
const ALLOWED_BODY_FIELDS = new Set(["model", "messages", "max_completion_tokens"]);
const encoder = new TextEncoder();

export interface CloudInferenceCustomerHttpApiOptions {
  db?: CloudDb;
  credentialEncryptionKey?: string;
  requestHashSecret?: string;
  now?: () => number;
  fetcher?: typeof fetch;
  requestBodyTimeoutMs?: number;
  countTimeoutMs?: number;
  generationTimeoutMs?: number;
  rateLimit?: { limit: number; windowMs: number };
  failedKeyRateLimit?: { limit: number; windowMs: number };
  failedKeyFallbackRateLimit?: { limit: number; windowMs: number };
}

interface CustomerRequest {
  model: string;
  message: string;
  maxOutputTokens?: number;
}

interface CountResponse {
  object: "response.input_tokens";
  input_tokens: number;
}

interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface ProviderResponse {
  id: string;
  model: string;
  status: string;
  created_at?: number;
  output: unknown[];
  usage: ProviderUsage;
  incomplete_details?: { reason?: string } | null;
}

function json(body: unknown, status = 200, requestId?: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (requestId) headers.set("X-Request-ID", requestId);
  return Response.json(body, { status, headers });
}

function storedResponse(body: string, status: number, requestId: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Request-ID": requestId,
    },
  });
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer (orc_live_[A-Za-z0-9_-]{32,64})$/.exec(
    request.headers.get("authorization") ?? ""
  );
  return match?.[1] ?? null;
}

type BoundedJsonResult =
  { kind: "ok"; body: Record<string, unknown> } | { kind: "invalid" } | { kind: "timeout" };

async function readBoundedJson(
  request: Request,
  maxBytes: number,
  timeoutMs: number
): Promise<BoundedJsonResult> {
  const contentType = request.headers.get("content-type")?.toLowerCase().split(";", 1)[0].trim();
  if (contentType !== "application/json") return { kind: "invalid" };
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    return { kind: "invalid" };
  }
  if (!request.body) return { kind: "invalid" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel("request body timeout").catch(() => undefined);
      reject(new Error("request body timeout"));
    }, timeoutMs);
  });

  try {
    const parsed = await Promise.race([
      (async (): Promise<Record<string, unknown> | null> => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            void reader.cancel("request body too large").catch(() => undefined);
            return null;
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
          return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      })(),
      timeout,
    ]);
    return parsed === null ? { kind: "invalid" } : { kind: "ok", body: parsed };
  } catch {
    return timedOut ? { kind: "timeout" } : { kind: "invalid" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseCustomerRequest(body: Record<string, unknown>): CustomerRequest | null {
  if (Object.keys(body).some((key) => !ALLOWED_BODY_FIELDS.has(key))) return null;
  if (body.model !== CLOUD_INFERENCE_MODEL) return null;
  if (!Array.isArray(body.messages) || body.messages.length !== 1) return null;
  const message = body.messages[0];
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    Object.keys(message).some((key) => key !== "role" && key !== "content") ||
    (message as Record<string, unknown>).role !== "user" ||
    typeof (message as Record<string, unknown>).content !== "string"
  ) {
    return null;
  }
  const content = (message as Record<string, unknown>).content as string;
  if (encoder.encode(content).byteLength > CLOUD_INFERENCE_MAX_REQUEST_BYTES / 2) return null;
  if (body.max_completion_tokens !== undefined) {
    if (
      !Number.isSafeInteger(body.max_completion_tokens) ||
      (body.max_completion_tokens as number) < 1 ||
      (body.max_completion_tokens as number) > CLOUD_INFERENCE_MAX_OUTPUT_TOKENS
    ) {
      return null;
    }
  }
  return {
    model: CLOUD_INFERENCE_MODEL,
    message: content,
    ...(body.max_completion_tokens === undefined
      ? {}
      : { maxOutputTokens: body.max_completion_tokens as number }),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
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
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

interface TimedResponseBody {
  response: Response;
  body: string | null;
}

async function fetchTimedBody(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number
): Promise<TimedResponseBody> {
  const controller = new AbortController();
  let response: Response | undefined;
  let rejectTimeout: ((error: Error) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort("upstream timeout");
    if (response?.body) void response.body.cancel().catch(() => undefined);
    rejectTimeout?.(new Error("upstream timeout"));
  }, timeoutMs);
  try {
    return await Promise.race([
      (async () => {
        response = await fetcher(url, {
          ...init,
          signal: controller.signal,
          redirect: "error",
        });
        const body = await readBoundedResponse(response, maxBytes);
        return { response, body };
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseCountResponse(value: unknown): CountResponse | null {
  const body = record(value);
  if (body?.object !== "response.input_tokens" || !isTokenCount(body.input_tokens)) return null;
  return { object: "response.input_tokens", input_tokens: body.input_tokens };
}

function parseProviderResponse(value: unknown): ProviderResponse | null {
  const body = record(value);
  const usage = record(body?.usage);
  if (
    typeof body?.id !== "string" ||
    body.id.length < 1 ||
    body.id.length > 256 ||
    body.model !== CLOUD_INFERENCE_MODEL ||
    (body.status !== "completed" && body.status !== "incomplete") ||
    !Array.isArray(body.output) ||
    !usage ||
    !isTokenCount(usage.input_tokens) ||
    !isTokenCount(usage.output_tokens) ||
    !isTokenCount(usage.total_tokens) ||
    usage.total_tokens !== usage.input_tokens + usage.output_tokens
  ) {
    return null;
  }
  return {
    id: body.id,
    model: body.model,
    status: body.status,
    created_at: isTokenCount(body.created_at) ? body.created_at : undefined,
    output: body.output,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
    },
    incomplete_details: record(body.incomplete_details) as { reason?: string } | null,
  };
}

function assistantText(output: unknown[]): string | null {
  const parts: string[] = [];
  for (const item of output) {
    const message = record(item);
    if (
      message?.type !== "message" ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    for (const partValue of message.content) {
      const part = record(partValue);
      if (part?.type === "output_text" && typeof part.text === "string") parts.push(part.text);
      else if (part?.type === "refusal" && typeof part.refusal === "string")
        parts.push(part.refusal);
    }
  }
  return parts.length ? parts.join("") : null;
}

function chatCompletion(response: ProviderResponse, content: string, requestId: string) {
  const finishReason =
    response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
      ? "length"
      : "stop";
  return {
    id: `chatcmpl_${requestId.replace(/-/g, "")}`,
    object: "chat.completion",
    created: response.created_at ?? Math.floor(Date.now() / 1000),
    model: CLOUD_INFERENCE_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.total_tokens,
    },
  };
}

function requestPayload(request: CustomerRequest) {
  return {
    model: CLOUD_INFERENCE_MODEL,
    input: request.message,
  };
}

function requestHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function errorResponse(message: string, status: number, requestId?: string): Response {
  return json({ error: { message, type: "cloud_inference_error" } }, status, requestId);
}

function safeJsonString(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return null;
    const size = encoder.encode(serialized).byteLength;
    return size <= CLOUD_INFERENCE_MAX_RESPONSE_BYTES ? serialized : null;
  } catch {
    return null;
  }
}

/** Customer-authenticated, fixed-endpoint, non-streaming OpenAI chat compatibility route. */
export async function handleCloudInferenceCustomerRequest(
  request: Request,
  options: CloudInferenceCustomerHttpApiOptions
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== CLOUD_INFERENCE_CHAT_PATH) return errorResponse("Not found", 404);
  if (!options.db) return errorResponse("Cloud inference is unavailable", 503);

  const nowMs = options.now?.() ?? Date.now();
  const clientIpBucket = cloudflareClientIpBucket(request);
  try {
    if (clientIpBucket) {
      const authLimit = await consumeCloudRateLimit(options.db, {
        tenantId: CLOUD_PLATFORM_TENANT_ID,
        bucketKey: `inference-key-auth:${clientIpBucket}`,
        ...(options.failedKeyRateLimit ?? DEFAULT_FAILED_KEY_RATE_LIMIT),
        nowMs,
      });
      if (!authLimit.allowed) return errorResponse("Authentication rate limit exceeded", 429);
    }
  } catch {
    return errorResponse("Cloud inference is unavailable", 503);
  }

  if (request.method !== "POST") return errorResponse("Method not allowed", 405);
  if (url.search) return errorResponse("Unsupported request metadata", 400);

  const token = bearerToken(request);
  if (!token) return errorResponse("Unauthorized", 401);

  let identity: Awaited<ReturnType<typeof authenticateCloudCustomerApiKey>>;
  try {
    identity = await authenticateCloudCustomerApiKey(
      options.db,
      token,
      new Date(nowMs).toISOString()
    );
  } catch {
    return errorResponse("Cloud inference is unavailable", 503);
  }
  if (!identity) {
    if (clientIpBucket) return errorResponse("Unauthorized", 401);
    try {
      const authLimit = await consumeCloudRateLimit(options.db, {
        tenantId: CLOUD_PLATFORM_TENANT_ID,
        bucketKey: `inference-key-auth:${token}`,
        ...(options.failedKeyFallbackRateLimit ?? DEFAULT_FAILED_KEY_FALLBACK_RATE_LIMIT),
        nowMs,
      });
      return authLimit.allowed
        ? errorResponse("Unauthorized", 401)
        : errorResponse("Authentication rate limit exceeded", 429);
    } catch {
      return errorResponse("Cloud inference is unavailable", 503);
    }
  }

  if (identity.role === "viewer") return errorResponse("Customer role cannot run inference", 403);

  try {
    const rate = await consumeCloudRateLimit(options.db, {
      tenantId: identity.tenantId,
      bucketKey: "cloud-inference-chat-completions",
      ...(options.rateLimit ?? DEFAULT_CUSTOMER_RATE_LIMIT),
      nowMs,
    });
    if (!rate.allowed) return errorResponse("Cloud inference rate limit exceeded", 429);
  } catch {
    return errorResponse("Cloud inference rate limit is unavailable", 503);
  }

  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(idempotencyKey)) {
    return errorResponse("A valid Idempotency-Key header is required", 400);
  }
  const parsedBody = await readBoundedJson(
    request,
    CLOUD_INFERENCE_MAX_REQUEST_BYTES,
    options.requestBodyTimeoutMs ?? CLOUD_INFERENCE_REQUEST_BODY_TIMEOUT_MS
  );
  if (parsedBody.kind === "timeout") return errorResponse("Request body timed out", 408);
  if (parsedBody.kind !== "ok") return errorResponse("Invalid or oversized JSON body", 400);
  const customerRequest = parseCustomerRequest(parsedBody.body);
  if (!customerRequest) {
    return errorResponse("Only one plain-text user message for the pinned model is supported", 400);
  }

  if (!options.requestHashSecret || options.requestHashSecret === options.credentialEncryptionKey) {
    return errorResponse("Cloud inference idempotency is unavailable", 503);
  }

  const requestFingerprint = {
    model: customerRequest.model,
    messages: [{ role: "user", content: customerRequest.message }],
    max_completion_tokens: customerRequest.maxOutputTokens ?? null,
  };
  let claimResult;
  try {
    claimResult = await claimCloudInferenceIdempotency(options.db, {
      key: idempotencyKey,
      scope: {
        tenantId: identity.tenantId,
        principalId: identity.principalId,
        apiKeyId: identity.apiKeyId,
      },
      request: requestFingerprint,
      requestHashSecret: options.requestHashSecret,
      nowMs,
    });
  } catch {
    return errorResponse("Cloud inference idempotency is unavailable", 503);
  }
  if (claimResult.kind === "conflict") {
    return errorResponse("Idempotency-Key was already used for a different operation", 409);
  }
  if (claimResult.kind === "capacity") {
    return errorResponse("Cloud inference idempotency capacity is unavailable", 503);
  }
  if (claimResult.kind === "in_progress") {
    return errorResponse(
      "Inference with this Idempotency-Key is in progress",
      409,
      claimResult.requestId
    );
  }
  if (claimResult.kind === "outcome_unavailable") {
    return errorResponse(
      "The prior inference outcome is unavailable; this key cannot be retried",
      503,
      claimResult.requestId
    );
  }
  if (claimResult.kind === "replay") {
    return storedResponse(claimResult.body, claimResult.status, claimResult.requestId);
  }
  const claim = claimResult.claim;

  const cache = async (body: unknown, status: number): Promise<Response> => {
    const serialized = safeJsonString(body);
    if (serialized === null) {
      await markCloudInferenceOutcomeUnavailable(options.db!, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference result is unavailable", 503, claim.requestId);
    }
    try {
      const stored = await completeCloudInferenceIdempotency(
        options.db!,
        claim,
        { status, body: serialized },
        options.now?.() ?? Date.now()
      );
      if (stored.kind === "completed") return storedResponse(serialized, status, claim.requestId);
    } catch {
      // The claim is converted to an unavailable tombstone below.
    }
    await markCloudInferenceOutcomeUnavailable(options.db!, claim, options.now?.() ?? Date.now());
    return errorResponse("Inference result is unavailable", 503, claim.requestId);
  };

  const audit = async (status: string, metadata: Record<string, unknown> = {}) => {
    await appendCloudComplianceAudit(options.db!, {
      id: crypto.randomUUID(),
      tenantId: identity.tenantId,
      timestamp: new Date(options.now?.() ?? Date.now()).toISOString(),
      action: "cloud.inference.chat.completions",
      actor: identity.principalId,
      target: customerRequest.model,
      resourceType: "cloud-inference",
      status,
      requestId: claim.requestId,
      metadata: { apiKeyId: identity.apiKeyId, ...metadata },
    });
  };

  let entitlement;
  try {
    entitlement = await getCloudInferenceEntitlement(
      options.db,
      identity.tenantId,
      CLOUD_INFERENCE_PROVIDER,
      CLOUD_INFERENCE_MODEL
    );
  } catch {
    return cache(
      { error: { message: "Inference policy is unavailable", type: "cloud_inference_error" } },
      503
    );
  }
  if (!entitlement?.enabled) {
    try {
      await audit("denied", { reason: "entitlement_disabled" });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference audit is unavailable", 503, claim.requestId);
    }
    return cache(
      {
        error: {
          message: "Inference is not enabled for this model",
          type: "cloud_inference_error",
        },
      },
      403
    );
  }

  const maxOutputTokens =
    customerRequest.maxOutputTokens ??
    Math.min(CLOUD_INFERENCE_DEFAULT_OUTPUT_TOKENS, entitlement.maxOutputTokens);
  if (maxOutputTokens < 1 || maxOutputTokens > entitlement.maxOutputTokens) {
    try {
      await audit("denied", { reason: "output_cap_exceeded" });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference audit is unavailable", 503, claim.requestId);
    }
    return cache(
      {
        error: {
          message: "Requested output exceeds the tenant model limit",
          type: "cloud_inference_error",
        },
      },
      403
    );
  }

  let apiKey: string | null = null;
  let connectionId: string | null = null;
  try {
    const connections = await getCloudProviderConnections(options.db, identity.tenantId, {
      provider: CLOUD_INFERENCE_PROVIDER,
      isActive: true,
    });
    for (const connection of connections) {
      if (!connection.apiKey || !isCloudCredentialEnvelope(connection.apiKey)) continue;
      apiKey = await decryptCloudCredential(connection.apiKey, options.credentialEncryptionKey, {
        tenantId: identity.tenantId,
        connectionId: connection.id,
        field: "apiKey",
      });
      connectionId = connection.id;
      break;
    }
  } catch {
    apiKey = null;
  }
  if (!apiKey || !connectionId) {
    try {
      await audit("unavailable", { reason: "provider_credential_unavailable" });
    } catch {
      // The response remains generic and contains no credential details.
    }
    return cache(
      { error: { message: "Provider credentials are unavailable", type: "cloud_inference_error" } },
      503
    );
  }

  const fetcher = options.fetcher ?? fetch;
  const countPayload = requestPayload(customerRequest);
  let countResult: CountResponse | null = null;
  try {
    const result = await fetchTimedBody(
      fetcher,
      CLOUD_INFERENCE_COUNT_URL,
      {
        method: "POST",
        headers: requestHeaders(apiKey),
        body: JSON.stringify(countPayload),
      },
      options.countTimeoutMs ?? CLOUD_INFERENCE_COUNT_TIMEOUT_MS,
      CLOUD_INFERENCE_MAX_COUNT_RESPONSE_BYTES
    );
    const countJson = result.body === null ? null : safeParseJson(result.body);
    countResult = result.response.ok ? parseCountResponse(countJson) : null;
  } catch {
    await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
    try {
      await audit("count_outcome_unavailable", { endpoint: "/v1/responses/input_tokens" });
    } catch {
      // The idempotency tombstone remains the authoritative outcome marker.
    }
    return errorResponse("Input token count could not be confirmed", 504, claim.requestId);
  }
  if (!countResult) {
    await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
    try {
      await audit("count_outcome_unavailable", { endpoint: "/v1/responses/input_tokens" });
    } catch {
      // The idempotency tombstone remains the authoritative outcome marker.
    }
    return errorResponse("Input token count could not be confirmed", 502, claim.requestId);
  }

  const inputTokens = countResult.input_tokens;
  if (inputTokens > entitlement.maxInputTokens) {
    try {
      await audit("denied", { reason: "input_cap_exceeded", inputTokens });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference audit is unavailable", 503, claim.requestId);
    }
    return cache(
      { error: { message: "Input exceeds the tenant model limit", type: "cloud_inference_error" } },
      413
    );
  }

  let reservation;
  try {
    reservation = await reserveCloudInferenceTokens(options.db, {
      tenantId: identity.tenantId,
      reservationId: claim.requestId,
      provider: CLOUD_INFERENCE_PROVIDER,
      model: CLOUD_INFERENCE_MODEL,
      inputTokens,
      maxOutputTokens,
      now: new Date(options.now?.() ?? Date.now()),
    });
  } catch {
    await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
    return errorResponse("Token budget reservation is unavailable", 503, claim.requestId);
  }
  if (reservation.kind === "denied" || reservation.kind === "conflict") {
    try {
      await audit("denied", {
        reason: "token_budget_or_policy_denied",
        inputTokens,
        maxOutputTokens,
      });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference audit is unavailable", 503, claim.requestId);
    }
    return cache(
      {
        error: {
          message: "Tenant token budget or model policy denied this request",
          type: "cloud_inference_error",
        },
      },
      429
    );
  }

  let providerResult: ProviderResponse | null = null;
  let content: string | null = null;
  const startedAt = performance.now();
  try {
    const result = await fetchTimedBody(
      fetcher,
      CLOUD_INFERENCE_RESPONSE_URL,
      {
        method: "POST",
        headers: requestHeaders(apiKey),
        body: JSON.stringify({
          ...countPayload,
          max_output_tokens: maxOutputTokens,
          store: false,
        }),
      },
      options.generationTimeoutMs ?? CLOUD_INFERENCE_GENERATION_TIMEOUT_MS,
      CLOUD_INFERENCE_MAX_RESPONSE_BYTES
    );
    const providerJson = result.body === null ? null : safeParseJson(result.body);
    providerResult = result.response.ok ? parseProviderResponse(providerJson) : null;
    content = providerResult ? assistantText(providerResult.output) : null;
  } catch {
    await settleCloudInferenceReservation(options.db, {
      tenantId: identity.tenantId,
      reservationId: claim.requestId,
      actualInputTokens: inputTokens,
      actualOutputTokens: maxOutputTokens,
      now: new Date(options.now?.() ?? Date.now()),
    });
    await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
    try {
      await audit("generation_outcome_unavailable", {
        inputTokens,
        outputTokensReserved: maxOutputTokens,
        connectionId,
      });
    } catch {
      // The reservation and idempotency tombstone retain the conservative outcome.
    }
    return errorResponse(
      "Inference outcome is unavailable and will not be retried",
      504,
      claim.requestId
    );
  }

  if (
    !providerResult ||
    content === null ||
    providerResult.usage.input_tokens > inputTokens ||
    providerResult.usage.output_tokens > maxOutputTokens
  ) {
    await settleCloudInferenceReservation(options.db, {
      tenantId: identity.tenantId,
      reservationId: claim.requestId,
      actualInputTokens: inputTokens,
      actualOutputTokens: maxOutputTokens,
      now: new Date(options.now?.() ?? Date.now()),
    });
    await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
    try {
      await audit("generation_outcome_unavailable", {
        inputTokens,
        outputTokensReserved: maxOutputTokens,
        connectionId,
      });
    } catch {
      // The reservation and idempotency tombstone retain the conservative outcome.
    }
    return errorResponse("Inference result could not be safely confirmed", 502, claim.requestId);
  }

  const settled = await settleCloudInferenceReservation(options.db, {
    tenantId: identity.tenantId,
    reservationId: claim.requestId,
    actualInputTokens: providerResult.usage.input_tokens,
    actualOutputTokens: providerResult.usage.output_tokens,
    now: new Date(options.now?.() ?? Date.now()),
  });
  if (settled.kind !== "updated" && settled.kind !== "replay") {
    await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
    return errorResponse("Token accounting could not be safely confirmed", 503, claim.requestId);
  }

  const completion = chatCompletion(providerResult, content, claim.requestId);
  const completionJson = safeJsonString(completion);
  if (completionJson === null) {
    await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
    return errorResponse("Inference result exceeds the response limit", 502, claim.requestId);
  }

  try {
    await appendCloudUsageRecord(options.db, {
      id: claim.requestId,
      tenantId: identity.tenantId,
      provider: CLOUD_INFERENCE_PROVIDER,
      model: CLOUD_INFERENCE_MODEL,
      connectionId,
      apiKeyId: identity.apiKeyId,
      tokensInput: providerResult.usage.input_tokens,
      tokensOutput: providerResult.usage.output_tokens,
      serviceTier: "customer-managed",
      status: "success",
      success: true,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      endpoint: CLOUD_INFERENCE_CHAT_PATH,
      timestamp: new Date(options.now?.() ?? Date.now()).toISOString(),
    });
    await audit("success", {
      inputTokens: providerResult.usage.input_tokens,
      outputTokens: providerResult.usage.output_tokens,
      connectionId,
    });
  } catch {
    await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
    return errorResponse("Inference accounting is unavailable", 503, claim.requestId);
  }

  return cache(completion, 200);
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
