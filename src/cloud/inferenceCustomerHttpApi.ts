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
const ALLOWED_BODY_FIELDS = new Set(["model", "messages", "max_completion_tokens", "stream"]);
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
  stream: boolean;
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
  if (body.stream !== undefined && typeof body.stream !== "boolean") return null;
  return {
    model: CLOUD_INFERENCE_MODEL,
    message: content,
    stream: body.stream === true,
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

function sseData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function chatChunk(
  requestId: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: string | null = null
): string {
  return sseData({
    id: `chatcmpl_${requestId.replace(/-/g, "")}`,
    object: "chat.completion.chunk",
    created,
    model: CLOUD_INFERENCE_MODEL,
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
  tenantId: string;
  apiKeyId: string;
  apiKey: string;
  connectionId: string;
  inputTokens: number;
  maxOutputTokens: number;
  fetcher: typeof fetch;
  countPayload: ReturnType<typeof requestPayload>;
  audit: (status: string, metadata?: Record<string, unknown>) => Promise<void>;
  startedAt: number;
}

/** Stream only the pinned Responses endpoint; persist the bounded SSE transcript for exact replay. */
async function streamCloudInference(input: CloudStreamInput): Promise<Response> {
  const { options, claim } = input;
  const db = options.db!;
  const nowMs = () => options.now?.() ?? Date.now();
  const failedResponse = (message: string, status: number) =>
    errorResponse(message, status, claim.requestId);
  const settleConservatively = async () => {
    await settleCloudInferenceReservation(db, {
      tenantId: input.tenantId,
      reservationId: claim.requestId,
      actualInputTokens: input.inputTokens,
      actualOutputTokens: input.maxOutputTokens,
      now: new Date(nowMs()),
    });
  };
  const controller = new AbortController();
  let response: Response;
  let rejectTimeout: ((error: Error) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort("upstream timeout");
    rejectTimeout?.(new Error("upstream timeout"));
  }, options.generationTimeoutMs ?? CLOUD_INFERENCE_GENERATION_TIMEOUT_MS);
  try {
    response = await Promise.race([
      input.fetcher(CLOUD_INFERENCE_RESPONSE_URL, {
        method: "POST",
        headers: {
          ...requestHeaders(input.apiKey),
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          ...input.countPayload,
          max_output_tokens: input.maxOutputTokens,
          store: false,
          stream: true,
        }),
        signal: controller.signal,
        redirect: "error",
      }),
      timeout,
    ]);
  } catch {
    clearTimeout(timer);
    controller.abort("upstream unavailable");
    try {
      await settleConservatively();
    } catch {
      // The idempotency tombstone below prevents uncertain redispatch.
    }
    await markCloudInferenceOutcomeUnavailable(db, claim, nowMs());
    try {
      await input.audit("generation_outcome_unavailable", {
        inputTokens: input.inputTokens,
        outputTokensReserved: input.maxOutputTokens,
        connectionId: input.connectionId,
      });
    } catch {
      // Keep the public failure generic.
    }
    return failedResponse("Inference outcome is unavailable and will not be retried", 504);
  }
  if (!response.ok || !response.body) {
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
          providerResult = parseProviderResponse(body?.response);
          return providerResult !== null;
        }
        if (event === "response.failed" || event === "error") return false;
        return true;
      };

      void (async () => {
        try {
          if (!emit(chatChunk(claim.requestId, created, { role: "assistant" }))) {
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
              if (!emit(chatChunk(claim.requestId, created, { content: pendingDelta }))) {
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
            !emit(chatChunk(claim.requestId, created, { content: pendingDelta }))
          ) {
            await fail("Inference result exceeds the response limit", true);
            return;
          }
          const settled = await settleCloudInferenceReservation(db, {
            tenantId: input.tenantId,
            reservationId: claim.requestId,
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
              id: claim.requestId,
              tenantId: input.tenantId,
              provider: CLOUD_INFERENCE_PROVIDER,
              model: CLOUD_INFERENCE_MODEL,
              connectionId: input.connectionId,
              apiKeyId: input.apiKeyId,
              tokensInput: providerResult.usage.input_tokens,
              tokensOutput: providerResult.usage.output_tokens,
              serviceTier: "customer-managed",
              status: "success",
              success: true,
              latencyMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
              endpoint: CLOUD_INFERENCE_CHAT_PATH,
              timestamp: new Date(nowMs()).toISOString(),
            });
            await input.audit("success", {
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
            chatChunk(claim.requestId, created, {}, finishReason) + "data: [DONE]\n\n";
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
  if (customerRequest.stream) {
    return streamCloudInference({
      options,
      claim,
      tenantId: identity.tenantId,
      apiKeyId: identity.apiKeyId,
      apiKey,
      connectionId,
      inputTokens,
      maxOutputTokens,
      fetcher,
      countPayload,
      audit,
      startedAt,
    });
  }
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
