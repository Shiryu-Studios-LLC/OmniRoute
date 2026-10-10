import { appendCloudComplianceAudit } from "./complianceAudit";
import {
  decryptCloudCredential,
  isCloudCredentialEnvelope,
  type CloudCredentialEncryptionKey,
} from "./credentialEncryption";
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
import {
  isCloudAnthropicMessagesModel,
  isCloudOpenAiResponsesModel,
  isCloudOpenAiResponsesModelResult,
  type CloudAnthropicMessagesModel,
  type CloudOpenAiResponsesModel,
} from "./providerExecution";
import { getCloudProviderConnections } from "./providers";
import { appendCloudUsageRecord } from "./usage";
import { CLOUD_PLATFORM_TENANT_ID } from "./tenants";

export const CLOUD_INFERENCE_CHAT_PATH = "/v1/chat/completions";
export const CLOUD_INFERENCE_CHAT_API_PATH = "/api/v1/chat/completions";
export const CLOUD_INFERENCE_PROVIDER = "openai";
export const CLOUD_INFERENCE_MODEL = "gpt-4o-mini-2024-07-18";
export const CLOUD_INFERENCE_COUNT_URL = "https://api.openai.com/v1/responses/input_tokens";
export const CLOUD_INFERENCE_RESPONSE_URL = "https://api.openai.com/v1/responses";
export const CLOUD_ANTHROPIC_PROVIDER = "anthropic";
export const CLOUD_ANTHROPIC_COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens";
export const CLOUD_ANTHROPIC_RESPONSE_URL = "https://api.anthropic.com/v1/messages";
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
const ALLOWED_BODY_FIELDS = new Set(["model", "messages", "max_completion_tokens", "stream"]);
const CLOUD_COMBO_MODEL_PREFIX = "combo:";
const CLOUD_COMBO_MAX_TARGETS = 10;
// These statuses reject the requested model before response generation. Throttles,
// timeouts, redirects, server errors, and malformed successes can have unknown outcomes.
const CLOUD_COMBO_RETRYABLE_REJECTIONS: Readonly<Record<string, ReadonlySet<number>>> = {
  openai: new Set([400, 401, 403, 404, 422]),
  anthropic: new Set([400, 401, 403, 404]),
};
const encoder = new TextEncoder();

export interface CloudInferenceCustomerHttpApiOptions {
  db?: CloudDb;
  credentialEncryptionKey?: CloudCredentialEncryptionKey;
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
  comboName?: string;
  message: string;
  stream: boolean;
  maxOutputTokens?: number;
}

interface CloudInferenceTarget {
  provider: typeof CLOUD_INFERENCE_PROVIDER | typeof CLOUD_ANTHROPIC_PROVIDER;
  model: CloudOpenAiResponsesModel | CloudAnthropicMessagesModel;
  entitlement: NonNullable<Awaited<ReturnType<typeof getCloudInferenceEntitlement>>>;
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

function storedResponse(body: string, status: number, requestId: string, stream = false): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type":
        stream && body.startsWith("data:")
          ? "text/event-stream; charset=utf-8"
          : "application/json; charset=utf-8",
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
  if (typeof body.model !== "string") return null;
  const comboName = body.model.startsWith(CLOUD_COMBO_MODEL_PREFIX)
    ? body.model.slice(CLOUD_COMBO_MODEL_PREFIX.length)
    : null;
  if (
    !parseCloudInferenceModel(body.model) &&
    (comboName === null || !/^[\w./\-[\] ]{1,100}$/.test(comboName.trim()))
  )
    return null;
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
  if (body.stream !== undefined && typeof body.stream !== "boolean") return null;
  return {
    model: body.model,
    ...(comboName === null ? {} : { comboName: comboName.trim() }),
    message: content,
    stream: body.stream === true,
    ...(body.max_completion_tokens === undefined
      ? {}
      : { maxOutputTokens: body.max_completion_tokens as number }),
  };
}

type CloudTargetResolution =
  | { kind: "ok"; targets: CloudInferenceTarget[]; strategy: "priority" | null }
  | { kind: "not_found" }
  | { kind: "unsupported" }
  | { kind: "unavailable" }
  | { kind: "not_entitled" };

type CloudInferenceProvider = typeof CLOUD_INFERENCE_PROVIDER | typeof CLOUD_ANTHROPIC_PROVIDER;
type CloudInferenceModel = CloudOpenAiResponsesModel | CloudAnthropicMessagesModel;

function parseCloudInferenceModel(
  value: unknown
): { provider: CloudInferenceProvider; model: CloudInferenceModel } | null {
  if (typeof value === "string") {
    const anthropicPrefix = `${CLOUD_ANTHROPIC_PROVIDER}/`;
    if (value.startsWith(anthropicPrefix)) {
      const model = value.slice(anthropicPrefix.length);
      return isCloudAnthropicMessagesModel(model)
        ? { provider: CLOUD_ANTHROPIC_PROVIDER, model }
        : null;
    }
    const openAiPrefix = `${CLOUD_INFERENCE_PROVIDER}/`;
    const model = value.startsWith(openAiPrefix) ? value.slice(openAiPrefix.length) : value;
    return isCloudOpenAiResponsesModel(model)
      ? { provider: CLOUD_INFERENCE_PROVIDER, model }
      : null;
  }
  const target = record(value);
  if (!target || Object.keys(target).length !== 3 || target.kind !== "model") return null;
  if (target.provider === CLOUD_INFERENCE_PROVIDER && isCloudOpenAiResponsesModel(target.model))
    return { provider: CLOUD_INFERENCE_PROVIDER, model: target.model };
  if (target.provider === CLOUD_ANTHROPIC_PROVIDER && isCloudAnthropicMessagesModel(target.model)) {
    return { provider: CLOUD_ANTHROPIC_PROVIDER, model: target.model };
  }
  return null;
}

/**
 * Cloud inference supports only priority combos of direct, allowlisted OpenAI
 * Responses and Anthropic Messages targets. Anthropic streaming, nested combos,
 * other strategies/providers, and config semantics remain unsupported.
 */
async function resolveCloudInferenceTargets(
  db: CloudDb,
  tenantId: string,
  request: CustomerRequest
): Promise<CloudTargetResolution> {
  let models: Array<{ provider: CloudInferenceProvider; model: CloudInferenceModel }>;
  let strategy: "priority" | null = null;
  if (!request.comboName) {
    const target = parseCloudInferenceModel(request.model);
    if (!target) return { kind: "unsupported" };
    models = [target];
  } else {
    let row: Record<string, unknown> | null;
    try {
      row = await db
        .prepare<Record<string, unknown>>(
          "SELECT data_json, is_active FROM cloud_tenant_combos WHERE tenant_id = ? AND name = ? AND is_active = 1"
        )
        .bind(tenantId, request.comboName)
        .first();
    } catch {
      return { kind: "unavailable" };
    }
    if (!row) return { kind: "not_found" };
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(row.data_json));
      const candidate = record(parsed);
      if (!candidate) return { kind: "unsupported" };
      data = candidate;
    } catch {
      return { kind: "unsupported" };
    }
    const allowedDataFields = new Set([
      "name",
      "description",
      "config",
      "models",
      "strategy",
      "isActive",
    ]);
    if (
      Object.keys(data).some((key) => !allowedDataFields.has(key)) ||
      data.name !== request.comboName ||
      (data.description !== undefined &&
        (typeof data.description !== "string" || data.description.length > 2000)) ||
      data.strategy !== "priority" ||
      (data.isActive !== undefined &&
        (typeof data.isActive !== "boolean" || data.isActive !== (Number(row.is_active) === 1)))
    ) {
      return { kind: "unsupported" };
    }
    if (
      data.config !== undefined &&
      (!record(data.config) || Object.keys(data.config as Record<string, unknown>).length > 0)
    ) {
      return { kind: "unsupported" };
    }
    if (
      !Array.isArray(data.models) ||
      data.models.length < 1 ||
      data.models.length > CLOUD_COMBO_MAX_TARGETS
    ) {
      return { kind: "unsupported" };
    }
    models = [];
    const seen = new Set<string>();
    for (const item of data.models) {
      const target = parseCloudInferenceModel(item);
      const targetKey = target ? `${target.provider}/${target.model}` : "";
      if (!target || seen.has(targetKey)) return { kind: "unsupported" };
      seen.add(targetKey);
      models.push(target);
    }
    strategy = "priority";
  }

  const targets: CloudInferenceTarget[] = [];
  try {
    for (const target of models) {
      const entitlement = await getCloudInferenceEntitlement(
        db,
        tenantId,
        target.provider,
        target.model
      );
      if (!entitlement?.enabled) return { kind: "not_entitled" };
      targets.push({ ...target, entitlement });
    }
  } catch {
    return { kind: "unavailable" };
  }
  return { kind: "ok", targets, strategy };
}

function attemptReservationId(requestId: string, index: number, combo: boolean): string {
  return combo ? `${requestId}_attempt_${index + 1}` : requestId;
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
          redirect: "manual",
        });
        if (response.status >= 300 && response.status <= 399) {
          await response.body?.cancel().catch(() => undefined);
          return { response, body: null };
        }
        if (response.status >= 400 && response.status < 500) {
          await response.body?.cancel().catch(() => undefined);
          return { response, body: null };
        }
        const body = await readBoundedResponse(response, maxBytes);
        return { response, body };
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTimedStreamHeaders(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{
  response: Response;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}> {
  const controller = new AbortController();
  let rejectTimeout: ((error: Error) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort("upstream timeout");
    rejectTimeout?.(new Error("upstream timeout"));
  }, timeoutMs);
  try {
    const response = await Promise.race([
      fetcher(url, { ...init, signal: controller.signal, redirect: "manual" }),
      timeout,
    ]);
    return { response, controller, timer };
  } catch (error) {
    clearTimeout(timer);
    controller.abort("upstream unavailable");
    throw error;
  }
}

function parseCountResponse(value: unknown): CountResponse | null {
  const body = record(value);
  if (body?.object !== "response.input_tokens" || !isTokenCount(body.input_tokens)) return null;
  return { object: "response.input_tokens", input_tokens: body.input_tokens };
}

function parseAnthropicCountResponse(value: unknown): CountResponse | null {
  const body = record(value);
  if (!isTokenCount(body?.input_tokens)) return null;
  return { object: "response.input_tokens", input_tokens: body.input_tokens };
}

function parseProviderResponse(value: unknown, expectedModel: string): ProviderResponse | null {
  const body = record(value);
  const usage = record(body?.usage);
  if (
    typeof body?.id !== "string" ||
    body.id.length < 1 ||
    body.id.length > 256 ||
    !isCloudOpenAiResponsesModelResult(expectedModel, body.model) ||
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

function parseAnthropicProviderResponse(
  value: unknown,
  expectedModel: string
): ProviderResponse | null {
  const body = record(value);
  const usage = record(body?.usage);
  if (
    typeof body?.id !== "string" ||
    body.id.length < 1 ||
    body.id.length > 256 ||
    body.type !== "message" ||
    body.role !== "assistant" ||
    body.model !== expectedModel ||
    !Array.isArray(body.content) ||
    !usage ||
    !isTokenCount(usage.input_tokens) ||
    !isTokenCount(usage.output_tokens) ||
    (body.stop_reason !== "end_turn" && body.stop_reason !== "max_tokens")
  ) {
    return null;
  }
  const content: Array<{ type: "output_text"; text: string }> = [];
  for (const value of body.content) {
    const block = record(value);
    if (block?.type !== "text" || typeof block.text !== "string") return null;
    content.push({ type: "output_text", text: block.text });
  }
  if (content.length === 0) return null;
  const totalTokens = usage.input_tokens + usage.output_tokens;
  if (!Number.isSafeInteger(totalTokens)) return null;
  return {
    id: body.id,
    model: expectedModel,
    status: body.stop_reason === "max_tokens" ? "incomplete" : "completed",
    output: [{ type: "message", role: "assistant", content }],
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: totalTokens,
    },
    incomplete_details: body.stop_reason === "max_tokens" ? { reason: "max_output_tokens" } : null,
  };
}

function parseCloudProviderResponse(
  provider: CloudInferenceProvider,
  value: unknown,
  expectedModel: string
): ProviderResponse | null {
  if (provider === CLOUD_ANTHROPIC_PROVIDER)
    return parseAnthropicProviderResponse(value, expectedModel);
  return parseProviderResponse(value, expectedModel);
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

function chatCompletion(
  response: ProviderResponse,
  content: string,
  requestId: string,
  model: string
) {
  const finishReason =
    response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
      ? "length"
      : "stop";
  return {
    id: `chatcmpl_${requestId.replace(/-/g, "")}`,
    object: "chat.completion",
    created: response.created_at ?? Math.floor(Date.now() / 1000),
    model,
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

function requestPayload(
  request: CustomerRequest,
  provider: CloudInferenceProvider,
  targetModel: CloudInferenceModel
): Record<string, unknown> & { model: string } {
  return provider === CLOUD_ANTHROPIC_PROVIDER
    ? { model: targetModel, messages: [{ role: "user", content: request.message }] }
    : { model: targetModel, input: request.message };
}

function providerEndpoint(
  provider: CloudInferenceProvider,
  operation: "count" | "generate"
): string {
  if (provider === CLOUD_ANTHROPIC_PROVIDER) {
    return operation === "count" ? CLOUD_ANTHROPIC_COUNT_URL : CLOUD_ANTHROPIC_RESPONSE_URL;
  }
  return operation === "count" ? CLOUD_INFERENCE_COUNT_URL : CLOUD_INFERENCE_RESPONSE_URL;
}

function requestHeaders(provider: CloudInferenceProvider, apiKey: string): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (provider === CLOUD_ANTHROPIC_PROVIDER) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function generationPayload(
  provider: CloudInferenceProvider,
  countPayload: Record<string, unknown> & { model: string },
  maxOutputTokens: number
): Record<string, unknown> {
  if (provider === CLOUD_ANTHROPIC_PROVIDER) {
    return { ...countPayload, max_tokens: maxOutputTokens };
  }
  return { ...countPayload, max_output_tokens: maxOutputTokens, store: false };
}

function sseData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function chatChunk(
  requestId: string,
  created: number,
  delta: Record<string, unknown>,
  model: string,
  finishReason: string | null = null
): string {
  return sseData({
    id: `chatcmpl_${requestId.replace(/-/g, "")}`,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

function streamErrorBody(message: string): string {
  return sseData({ error: { message, type: "cloud_inference_error" } });
}

interface CloudStreamInput {
  options: CloudInferenceCustomerHttpApiOptions;
  claim: { tenantId: string; requestId: string } & Parameters<
    typeof markCloudInferenceOutcomeUnavailable
  >[1];
  reservationId: string;
  tenantId: string;
  apiKeyId: string;
  connectionId: string;
  inputTokens: number;
  maxOutputTokens: number;
  response: Response;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  countPayload: ReturnType<typeof requestPayload>;
  outputModel: string;
  comboStrategy: "priority" | null;
  audit: (status: string, metadata?: Record<string, unknown>) => Promise<void>;
  startedAt: number;
}

/** Stream only the pinned Responses endpoint; persist the bounded SSE transcript for exact replay. */
async function streamCloudInference(input: CloudStreamInput): Promise<Response> {
  const { options, claim, response, controller, timer } = input;
  const db = options.db!;
  const nowMs = () => options.now?.() ?? Date.now();
  const failedResponse = (message: string, status: number) =>
    errorResponse(message, status, claim.requestId);
  const settleConservatively = async () => {
    await settleCloudInferenceReservation(db, {
      tenantId: input.tenantId,
      reservationId: input.reservationId,
      actualInputTokens: input.inputTokens,
      actualOutputTokens: input.maxOutputTokens,
      now: new Date(nowMs()),
    });
  };
  if ((response.status >= 300 && response.status <= 399) || !response.ok || !response.body) {
    clearTimeout(timer);
    await response.body?.cancel().catch(() => undefined);
    try {
      await settleConservatively();
    } catch {
      // The idempotency tombstone below prevents uncertain redispatch.
    }
    await markCloudInferenceOutcomeUnavailable(db, claim, nowMs());
    try {
      await input.audit("generation_outcome_unavailable", {
        model: input.countPayload.model,
        inputTokens: input.inputTokens,
        outputTokensReserved: input.maxOutputTokens,
        connectionId: input.connectionId,
      });
    } catch {
      // Keep the public failure generic.
    }
    return failedResponse("Inference result could not be safely confirmed", 502);
  }

  const reader = response.body.getReader();
  let handleConsumerCancel: (() => Promise<void>) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      const outputEncoder = new TextEncoder();
      let transcript = "";
      let transcriptBytes = 0;
      let rawBytes = 0;
      let buffer = "";
      let outputText = "";
      let pendingDelta = "";
      let providerResult: ProviderResponse | null = null;
      let cancelled = false;
      let finalized = false;
      let failureTask: Promise<void> | null = null;
      handleConsumerCancel = async () => {
        cancelled = true;
        await fail("Inference stream was cancelled", false);
      };
      const created = Math.floor(nowMs() / 1000);

      const emit = (chunk: string): boolean => {
        const bytes = outputEncoder.encode(chunk);
        if (transcriptBytes + bytes.byteLength > CLOUD_INFERENCE_MAX_RESPONSE_BYTES) return false;
        transcriptBytes += bytes.byteLength;
        transcript += chunk;
        if (!cancelled) streamController.enqueue(bytes);
        return true;
      };
      const fail = (message: string, exposeError: boolean): Promise<void> => {
        if (failureTask) return failureTask;
        failureTask = (async () => {
          if (finalized) return;
          finalized = true;
          clearTimeout(timer);
          controller.abort("stream failed");
          await reader.cancel().catch(() => undefined);
          try {
            await settleConservatively();
          } catch {
            // The tombstone below is the retry safety boundary.
          }
          try {
            await markCloudInferenceOutcomeUnavailable(db, claim, nowMs());
          } catch {
            // The existing claim still prevents dispatch; expiry also fails closed if D1 recovers.
          }
          try {
            await input.audit("generation_outcome_unavailable", {
              inputTokens: input.inputTokens,
              outputTokensReserved: input.maxOutputTokens,
              connectionId: input.connectionId,
            });
          } catch {
            // Keep provider details and accounting errors out of the stream.
          }
          if (exposeError && !cancelled) {
            try {
              streamController.enqueue(outputEncoder.encode(streamErrorBody(message)));
              streamController.close();
            } catch {
              // Consumer may have disconnected while the error was being written.
            }
          }
        })();
        return failureTask;
      };
      const processFrame = (frame: string): boolean => {
        const parsed = parseSseFrame(frame);
        if (!parsed || parsed.data === "[DONE]") return true;
        let payload: unknown;
        try {
          payload = JSON.parse(parsed.data) as unknown;
        } catch {
          return false;
        }
        const body = record(payload);
        const event = body?.type ?? parsed.event;
        if (event === "response.output_text.delta" || event === "response.refusal.delta") {
          const delta = body?.delta;
          if (typeof delta !== "string") return false;
          outputText += delta;
          pendingDelta += delta;
          return true;
        }
        if (event === "response.completed" || event === "response.incomplete") {
          providerResult = parseProviderResponse(body?.response, input.countPayload.model);
          return providerResult !== null;
        }
        if (event === "response.failed" || event === "error") return false;
        return true;
      };

      void (async () => {
        try {
          if (
            !emit(chatChunk(claim.requestId, created, { role: "assistant" }, input.outputModel))
          ) {
            await fail("Inference result exceeds the response limit", true);
            return;
          }
          const decoder = new TextDecoder("utf-8", { fatal: true });
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            rawBytes += value.byteLength;
            if (rawBytes > CLOUD_INFERENCE_MAX_RESPONSE_BYTES * 4) {
              await fail("Inference result exceeds the response limit", true);
              return;
            }
            buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
            let boundary = buffer.indexOf("\n\n");
            let emittedDelta = false;
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (!processFrame(frame)) {
                await fail("Inference result could not be safely confirmed", true);
                return;
              }
              if (providerResult) break;
              if (pendingDelta) emittedDelta = true;
              boundary = buffer.indexOf("\n\n");
            }
            if (pendingDelta && emittedDelta) {
              if (
                !emit(
                  chatChunk(claim.requestId, created, { content: pendingDelta }, input.outputModel)
                )
              ) {
                await fail("Inference result exceeds the response limit", true);
                return;
              }
              pendingDelta = "";
            }
            if (providerResult) break;
          }
          if (!providerResult && buffer.trim()) {
            if (!processFrame(buffer)) {
              await fail("Inference result could not be safely confirmed", true);
              return;
            }
          }
          if (providerResult) await reader.cancel().catch(() => undefined);
          if (
            !providerResult ||
            outputText.length === 0 ||
            assistantText(providerResult.output) !== outputText ||
            providerResult.usage.input_tokens > input.inputTokens ||
            providerResult.usage.output_tokens > input.maxOutputTokens
          ) {
            await fail("Inference result could not be safely confirmed", true);
            return;
          }
          if (
            pendingDelta &&
            !emit(chatChunk(claim.requestId, created, { content: pendingDelta }, input.outputModel))
          ) {
            await fail("Inference result exceeds the response limit", true);
            return;
          }
          const settled = await settleCloudInferenceReservation(db, {
            tenantId: input.tenantId,
            reservationId: input.reservationId,
            actualInputTokens: providerResult.usage.input_tokens,
            actualOutputTokens: providerResult.usage.output_tokens,
            now: new Date(nowMs()),
          });
          if (settled.kind !== "updated" && settled.kind !== "replay") {
            await fail("Token accounting could not be safely confirmed", true);
            return;
          }
          try {
            await appendCloudUsageRecord(db, {
              id: input.reservationId,
              tenantId: input.tenantId,
              provider: CLOUD_INFERENCE_PROVIDER,
              model: input.countPayload.model,
              connectionId: input.connectionId,
              apiKeyId: input.apiKeyId,
              tokensInput: providerResult.usage.input_tokens,
              tokensOutput: providerResult.usage.output_tokens,
              serviceTier: "customer-managed",
              status: "success",
              success: true,
              comboStrategy: input.comboStrategy,
              latencyMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
              endpoint: CLOUD_INFERENCE_CHAT_PATH,
              timestamp: new Date(nowMs()).toISOString(),
            });
            await input.audit("success", {
              model: input.countPayload.model,
              inputTokens: providerResult.usage.input_tokens,
              outputTokens: providerResult.usage.output_tokens,
              connectionId: input.connectionId,
            });
          } catch {
            await fail("Inference accounting is unavailable", true);
            return;
          }
          const finishReason =
            providerResult.status === "incomplete" &&
            providerResult.incomplete_details?.reason === "max_output_tokens"
              ? "length"
              : "stop";
          const terminal =
            chatChunk(claim.requestId, created, {}, input.outputModel, finishReason) +
            "data: [DONE]\n\n";
          const terminalBytes = outputEncoder.encode(terminal);
          if (transcriptBytes + terminalBytes.byteLength > CLOUD_INFERENCE_MAX_RESPONSE_BYTES) {
            await fail("Inference result exceeds the response limit", true);
            return;
          }
          transcript += terminal;
          try {
            const stored = await completeCloudInferenceIdempotency(
              db,
              claim,
              { status: 200, body: transcript },
              nowMs()
            );
            if (stored.kind !== "completed") {
              await fail("Inference result is unavailable", true);
              return;
            }
          } catch {
            await fail("Inference result is unavailable", true);
            return;
          }
          finalized = true;
          clearTimeout(timer);
          if (!cancelled) {
            streamController.enqueue(terminalBytes);
            streamController.close();
          }
        } catch {
          await fail("Inference result could not be safely confirmed", true);
        }
      })();
    },
    async cancel() {
      await handleConsumerCancel?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Request-ID": claim.requestId,
      "X-Accel-Buffering": "no",
    },
  });
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

/** Customer-authenticated, fixed-endpoint OpenAI chat compatibility route. */
export async function handleCloudInferenceCustomerRequest(
  request: Request,
  options: CloudInferenceCustomerHttpApiOptions
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.pathname !== CLOUD_INFERENCE_CHAT_PATH &&
    url.pathname !== CLOUD_INFERENCE_CHAT_API_PATH
  ) {
    return errorResponse("Not found", 404);
  }
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
    return errorResponse(
      "Unsupported model or request; one plain-text user message is required",
      400
    );
  }
  if (
    !customerRequest.comboName &&
    customerRequest.model !== CLOUD_INFERENCE_MODEL &&
    identity.role !== "owner" &&
    identity.role !== "admin"
  ) {
    return errorResponse("Owner or admin membership is required to select an inference model", 403);
  }

  if (!options.requestHashSecret || options.requestHashSecret === options.credentialEncryptionKey) {
    return errorResponse("Cloud inference idempotency is unavailable", 503);
  }

  const requestFingerprint = {
    model: customerRequest.model,
    messages: [{ role: "user", content: customerRequest.message }],
    max_completion_tokens: customerRequest.maxOutputTokens ?? null,
    ...(customerRequest.stream ? { stream: true } : {}),
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
    return storedResponse(
      claimResult.body,
      claimResult.status,
      claimResult.requestId,
      customerRequest.stream
    );
  }
  const claim = claimResult.claim;

  const cache = async (body: unknown, status: number): Promise<Response> => {
    const serialized = safeJsonString(body);
    if (serialized === null) {
      await markCloudInferenceOutcomeUnavailable(options.db!, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference result is unavailable", 503, claim.requestId);
    }
    const responseBody = serialized;
    try {
      const stored = await completeCloudInferenceIdempotency(
        options.db!,
        claim,
        { status, body: responseBody },
        options.now?.() ?? Date.now()
      );
      if (stored.kind === "completed") {
        return storedResponse(responseBody, status, claim.requestId, customerRequest.stream);
      }
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

  const targetResolution = await resolveCloudInferenceTargets(
    options.db,
    identity.tenantId,
    customerRequest
  );
  if (targetResolution.kind === "unavailable") {
    return cache(
      { error: { message: "Inference policy is unavailable", type: "cloud_inference_error" } },
      503
    );
  }
  if (targetResolution.kind === "not_found") {
    try {
      await audit("denied", { reason: "combo_not_found" });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference audit is unavailable", 503, claim.requestId);
    }
    return cache(
      { error: { message: "Customer combo is unavailable", type: "cloud_inference_error" } },
      404
    );
  }
  if (targetResolution.kind === "unsupported") {
    try {
      await audit("denied", { reason: "combo_contract_unsupported" });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference audit is unavailable", 503, claim.requestId);
    }
    return cache(
      {
        error: {
          message: "Customer combo uses unsupported routing settings",
          type: "cloud_inference_error",
        },
      },
      400
    );
  }
  if (targetResolution.kind === "not_entitled") {
    try {
      await audit("denied", { reason: "combo_target_not_entitled" });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference audit is unavailable", 503, claim.requestId);
    }
    return cache(
      {
        error: {
          message: customerRequest.comboName
            ? "Inference is not enabled for every combo target"
            : "Inference is not enabled for this model",
          type: "cloud_inference_error",
        },
      },
      403
    );
  }

  const targets = targetResolution.targets;
  if (
    customerRequest.stream &&
    targets.some((target) => target.provider === CLOUD_ANTHROPIC_PROVIDER)
  ) {
    try {
      await audit("denied", {
        reason: "provider_streaming_unsupported",
        provider: CLOUD_ANTHROPIC_PROVIDER,
      });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference audit is unavailable", 503, claim.requestId);
    }
    return cache(
      {
        error: {
          message: "Streaming is not supported for this provider target",
          type: "cloud_inference_error",
        },
      },
      400
    );
  }
  const maxEntitledOutputTokens = Math.min(
    ...targets.map((target) => target.entitlement.maxOutputTokens)
  );
  const maxOutputTokens =
    customerRequest.maxOutputTokens ??
    Math.min(CLOUD_INFERENCE_DEFAULT_OUTPUT_TOKENS, maxEntitledOutputTokens);
  if (maxOutputTokens < 1 || maxOutputTokens > maxEntitledOutputTokens) {
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

  const credentials = new Map<string, { apiKey: string; connectionId: string }>();
  try {
    for (const provider of new Set(targets.map((target) => target.provider))) {
      const connections = await getCloudProviderConnections(options.db, identity.tenantId, {
        provider,
        isActive: true,
      });
      for (const connection of connections) {
        // Cloud dispatch supports only customer-managed API keys sent directly to
        // the provider. Hosted credentials and OAuth modes remain metadata-only.
        // Null authType is accepted for pre-contract API-key rows.
        if (
          connection.provider !== provider ||
          connection.credentialOwnership !== "customer_managed" ||
          connection.executionLocation !== "third_party" ||
          (connection.authType !== null && connection.authType !== "api_key")
        ) {
          continue;
        }
        if (!connection.apiKey || !isCloudCredentialEnvelope(connection.apiKey)) continue;
        const apiKey = await decryptCloudCredential(
          connection.apiKey,
          options.credentialEncryptionKey,
          {
            tenantId: identity.tenantId,
            connectionId: connection.id,
            field: "apiKey",
          }
        );
        credentials.set(provider, { apiKey, connectionId: connection.id });
        break;
      }
    }
  } catch {
    credentials.clear();
  }
  if (credentials.size !== new Set(targets.map((target) => target.provider)).size) {
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
  let inputCapFailures = 0;
  let rejectedTargets = 0;

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const targetCredential = credentials.get(target.provider);
    if (!targetCredential) {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Provider credentials are unavailable", 503, claim.requestId);
    }
    const { apiKey, connectionId } = targetCredential;
    const attemptStartedAt = performance.now();
    const countPayload = requestPayload(customerRequest, target.provider, target.model);
    let countResponse: TimedResponseBody;
    try {
      countResponse = await fetchTimedBody(
        fetcher,
        providerEndpoint(target.provider, "count"),
        {
          method: "POST",
          headers: requestHeaders(target.provider, apiKey),
          body: JSON.stringify(countPayload),
        },
        options.countTimeoutMs ?? CLOUD_INFERENCE_COUNT_TIMEOUT_MS,
        CLOUD_INFERENCE_MAX_COUNT_RESPONSE_BYTES
      );
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      try {
        await audit("count_outcome_unavailable", {
          model: target.model,
          endpoint: "/v1/responses/input_tokens",
        });
      } catch {
        // The idempotency tombstone is authoritative if accounting is unavailable.
      }
      return errorResponse("Input token count could not be confirmed", 504, claim.requestId);
    }
    const countJson = countResponse.body === null ? null : safeParseJson(countResponse.body);
    const countResult = countResponse.response.ok
      ? target.provider === CLOUD_ANTHROPIC_PROVIDER
        ? parseAnthropicCountResponse(countJson)
        : parseCountResponse(countJson)
      : null;
    if (!countResult) {
      if (CLOUD_COMBO_RETRYABLE_REJECTIONS[target.provider].has(countResponse.response.status)) {
        rejectedTargets += 1;
        try {
          await audit("target_fallback", {
            provider: target.provider,
            model: target.model,
            reason: "token_count_rejected",
            upstreamStatus: countResponse.response.status,
          });
        } catch {
          await markCloudInferenceOutcomeUnavailable(
            options.db,
            claim,
            options.now?.() ?? Date.now()
          );
          return errorResponse("Inference accounting is unavailable", 503, claim.requestId);
        }
        continue;
      }
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      try {
        await audit("count_outcome_unavailable", {
          provider: target.provider,
          model: target.model,
          endpoint:
            target.provider === CLOUD_ANTHROPIC_PROVIDER
              ? "/v1/messages/count_tokens"
              : "/v1/responses/input_tokens",
          upstreamStatus: countResponse.response.status,
        });
      } catch {
        // The idempotency tombstone is authoritative if accounting is unavailable.
      }
      return errorResponse("Input token count could not be confirmed", 502, claim.requestId);
    }

    const inputTokens = countResult.input_tokens;
    if (inputTokens > target.entitlement.maxInputTokens) {
      inputCapFailures += 1;
      try {
        await audit("target_skipped", {
          provider: target.provider,
          model: target.model,
          reason: "input_cap_exceeded",
          inputTokens,
        });
      } catch {
        await markCloudInferenceOutcomeUnavailable(
          options.db,
          claim,
          options.now?.() ?? Date.now()
        );
        return errorResponse("Inference accounting is unavailable", 503, claim.requestId);
      }
      continue;
    }

    const reservationId = attemptReservationId(
      claim.requestId,
      index,
      Boolean(targetResolution.strategy)
    );
    let reservation;
    try {
      reservation = await reserveCloudInferenceTokens(options.db, {
        tenantId: identity.tenantId,
        reservationId,
        provider: target.provider,
        model: target.model,
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
          provider: target.provider,
          model: target.model,
          reason: "token_budget_or_policy_denied",
          inputTokens,
          maxOutputTokens,
        });
      } catch {
        await markCloudInferenceOutcomeUnavailable(
          options.db,
          claim,
          options.now?.() ?? Date.now()
        );
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

    const settle = async (actualInputTokens: number, actualOutputTokens: number) =>
      settleCloudInferenceReservation(options.db!, {
        tenantId: identity.tenantId,
        reservationId,
        actualInputTokens,
        actualOutputTokens,
        now: new Date(options.now?.() ?? Date.now()),
      });
    const recordRejectedAttempt = async (upstreamStatus: number) => {
      const settled = await settle(inputTokens, 0);
      if (settled.kind !== "updated" && settled.kind !== "replay")
        throw new Error("Rejected inference attempt could not be settled");
      await appendCloudUsageRecord(options.db!, {
        id: reservationId,
        tenantId: identity.tenantId,
        provider: target.provider,
        model: target.model,
        connectionId,
        apiKeyId: identity.apiKeyId,
        tokensInput: inputTokens,
        tokensOutput: 0,
        serviceTier: "customer-managed",
        status: targetResolution.strategy ? "fallback" : "rejected",
        success: false,
        errorCode: `upstream_rejected_${upstreamStatus}`,
        comboStrategy: targetResolution.strategy,
        latencyMs: Math.max(0, Math.round(performance.now() - attemptStartedAt)),
        endpoint: CLOUD_INFERENCE_CHAT_PATH,
        timestamp: new Date(options.now?.() ?? Date.now()).toISOString(),
      });
      await audit(targetResolution.strategy ? "target_fallback" : "target_rejected", {
        provider: target.provider,
        model: target.model,
        reason: "upstream_rejected_before_generation",
        upstreamStatus,
        countedInputTokens: inputTokens,
      });
    };
    const settleAmbiguous = async (status: string, metadata: Record<string, unknown> = {}) => {
      try {
        await settle(inputTokens, maxOutputTokens);
      } catch {
        // The idempotency tombstone prevents a second generation after uncertain dispatch.
      }
      await markCloudInferenceOutcomeUnavailable(options.db!, claim, options.now?.() ?? Date.now());
      try {
        await audit(status, {
          provider: target.provider,
          model: target.model,
          inputTokens,
          outputTokensReserved: maxOutputTokens,
          connectionId,
          ...metadata,
        });
      } catch {
        // Keep provider details and accounting failures out of the client response.
      }
    };

    if (customerRequest.stream) {
      let streamStart: Awaited<ReturnType<typeof fetchTimedStreamHeaders>>;
      try {
        streamStart = await fetchTimedStreamHeaders(
          fetcher,
          providerEndpoint(target.provider, "generate"),
          {
            method: "POST",
            headers: { ...requestHeaders(target.provider, apiKey), Accept: "text/event-stream" },
            body: JSON.stringify({
              ...generationPayload(target.provider, countPayload, maxOutputTokens),
              stream: true,
            }),
          },
          options.generationTimeoutMs ?? CLOUD_INFERENCE_GENERATION_TIMEOUT_MS
        );
      } catch {
        await settleAmbiguous("generation_outcome_unavailable");
        return errorResponse(
          "Inference outcome is unavailable and will not be retried",
          504,
          claim.requestId
        );
      }
      if (CLOUD_COMBO_RETRYABLE_REJECTIONS[target.provider].has(streamStart.response.status)) {
        clearTimeout(streamStart.timer);
        await streamStart.response.body?.cancel().catch(() => undefined);
        try {
          await recordRejectedAttempt(streamStart.response.status);
        } catch {
          await markCloudInferenceOutcomeUnavailable(
            options.db,
            claim,
            options.now?.() ?? Date.now()
          );
          return errorResponse("Inference accounting is unavailable", 503, claim.requestId);
        }
        continue;
      }
      if (
        streamStart.response.status >= 300 ||
        !streamStart.response.ok ||
        !streamStart.response.body
      ) {
        clearTimeout(streamStart.timer);
        await streamStart.response.body?.cancel().catch(() => undefined);
        await settleAmbiguous("generation_outcome_unavailable", {
          upstreamStatus: streamStart.response.status,
        });
        return errorResponse(
          "Inference result could not be safely confirmed",
          502,
          claim.requestId
        );
      }
      return streamCloudInference({
        options,
        claim,
        reservationId,
        tenantId: identity.tenantId,
        apiKeyId: identity.apiKeyId,
        connectionId,
        inputTokens,
        maxOutputTokens,
        response: streamStart.response,
        controller: streamStart.controller,
        timer: streamStart.timer,
        countPayload,
        outputModel: customerRequest.model,
        comboStrategy: targetResolution.strategy,
        audit,
        startedAt: attemptStartedAt,
      });
    }

    let result: TimedResponseBody;
    try {
      result = await fetchTimedBody(
        fetcher,
        providerEndpoint(target.provider, "generate"),
        {
          method: "POST",
          headers: requestHeaders(target.provider, apiKey),
          body: JSON.stringify(generationPayload(target.provider, countPayload, maxOutputTokens)),
        },
        options.generationTimeoutMs ?? CLOUD_INFERENCE_GENERATION_TIMEOUT_MS,
        CLOUD_INFERENCE_MAX_RESPONSE_BYTES
      );
    } catch {
      await settleAmbiguous("generation_outcome_unavailable");
      return errorResponse(
        "Inference outcome is unavailable and will not be retried",
        504,
        claim.requestId
      );
    }
    if (CLOUD_COMBO_RETRYABLE_REJECTIONS[target.provider].has(result.response.status)) {
      try {
        await recordRejectedAttempt(result.response.status);
      } catch {
        await markCloudInferenceOutcomeUnavailable(
          options.db,
          claim,
          options.now?.() ?? Date.now()
        );
        return errorResponse("Inference accounting is unavailable", 503, claim.requestId);
      }
      continue;
    }

    const providerJson = result.body === null ? null : safeParseJson(result.body);
    const providerResult = result.response.ok
      ? parseCloudProviderResponse(target.provider, providerJson, target.model)
      : null;
    const content = providerResult ? assistantText(providerResult.output) : null;
    if (
      !providerResult ||
      content === null ||
      providerResult.usage.input_tokens > inputTokens ||
      providerResult.usage.output_tokens > maxOutputTokens
    ) {
      await settleAmbiguous("generation_outcome_unavailable", {
        upstreamStatus: result.response.status,
      });
      return errorResponse("Inference result could not be safely confirmed", 502, claim.requestId);
    }

    const settled = await settle(
      providerResult.usage.input_tokens,
      providerResult.usage.output_tokens
    );
    if (settled.kind !== "updated" && settled.kind !== "replay") {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Token accounting could not be safely confirmed", 503, claim.requestId);
    }
    const completion = chatCompletion(
      providerResult,
      content,
      claim.requestId,
      customerRequest.model
    );
    if (safeJsonString(completion) === null) {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference result exceeds the response limit", 502, claim.requestId);
    }
    try {
      await appendCloudUsageRecord(options.db, {
        id: reservationId,
        tenantId: identity.tenantId,
        provider: target.provider,
        model: target.model,
        connectionId,
        apiKeyId: identity.apiKeyId,
        tokensInput: providerResult.usage.input_tokens,
        tokensOutput: providerResult.usage.output_tokens,
        serviceTier: "customer-managed",
        status: "success",
        success: true,
        comboStrategy: targetResolution.strategy,
        latencyMs: Math.max(0, Math.round(performance.now() - attemptStartedAt)),
        endpoint: CLOUD_INFERENCE_CHAT_PATH,
        timestamp: new Date(options.now?.() ?? Date.now()).toISOString(),
      });
      await audit("success", {
        provider: target.provider,
        model: target.model,
        inputTokens: providerResult.usage.input_tokens,
        outputTokens: providerResult.usage.output_tokens,
        connectionId,
        ...(targetResolution.strategy ? { comboStrategy: targetResolution.strategy } : {}),
      });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference accounting is unavailable", 503, claim.requestId);
    }
    return cache(completion, 200);
  }

  if (inputCapFailures === targets.length) {
    try {
      await audit("denied", {
        reason: "input_cap_exceeded",
        targets: inputCapFailures,
      });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference audit is unavailable", 503, claim.requestId);
    }
    return cache(
      { error: { message: "Input exceeds the tenant model limit", type: "cloud_inference_error" } },
      413
    );
  }
  if (rejectedTargets > 0) {
    try {
      await audit("unavailable", {
        reason: "all_targets_rejected_before_generation",
        rejectedTargets,
      });
    } catch {
      await markCloudInferenceOutcomeUnavailable(options.db, claim, options.now?.() ?? Date.now());
      return errorResponse("Inference accounting is unavailable", 503, claim.requestId);
    }
    return cache(
      {
        error: {
          message: customerRequest.comboName
            ? "No combo target accepted the inference request"
            : "The inference model rejected the request",
          type: "cloud_inference_error",
        },
      },
      502
    );
  }
  return cache(
    { error: { message: "No combo target can serve this request", type: "cloud_inference_error" } },
    413
  );
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
