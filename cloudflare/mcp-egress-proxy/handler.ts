import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { McpOutboundTransport } from "../../src/lib/mcp/mcpOutboundTransport.ts";

export const MAX_PROXY_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PROXY_BODY_READ_TIMEOUT_MS = 10_000;
export const DEFAULT_PROXY_MAX_IN_FLIGHT = 32;
const REQUEST_PATH = "/v1/mcp/forward";
const MAX_CLOCK_SKEW_SECONDS = 30;
const MAX_REPLAYED_NONCES = 50_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "contentType",
  "mcpSessionId",
  "mcpProtocolVersion",
  "upstreamAuthorization",
]);

export interface McpEgressProxyBody {
  tenantId: string;
  serverId: string;
  url: string;
  headers?: {
    accept?: string;
    contentType?: string;
    mcpSessionId?: string;
    mcpProtocolVersion?: string;
    upstreamAuthorization?: string;
  };
  body: string;
}

export interface McpEgressProxyOptions {
  proxyToken: string;
  transport: McpOutboundTransport;
  timeoutMs?: number;
  bodyReadTimeoutMs?: number;
  maxInFlight?: number;
  rateLimit?: { limit: number; windowMs: number };
  nowSeconds?: () => number;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function createMcpEgressSignature(
  rawBody: string,
  timestamp: string,
  nonce: string,
  proxyToken: string
): string {
  return createHmac("sha256", proxyToken)
    .update(`${timestamp}\n${nonce}\n${rawBody}`, "utf8")
    .digest("hex");
}

function constantTimeSignatureMatch(received: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(received)) return false;
  const receivedBytes = Buffer.from(received, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return timingSafeEqual(receivedBytes, expectedBytes);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeHeaderValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 16 * 1024 &&
    !/[\r\n\0]/.test(value)
  );
}

function validateBody(value: unknown): McpEgressProxyBody | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length < 4 ||
    keys.length > 5 ||
    keys.some((key) => !["tenantId", "serverId", "url", "headers", "body"].includes(key)) ||
    typeof value.tenantId !== "string" ||
    !ID_PATTERN.test(value.tenantId) ||
    typeof value.serverId !== "string" ||
    !ID_PATTERN.test(value.serverId) ||
    typeof value.url !== "string" ||
    value.url.length === 0 ||
    Buffer.byteLength(value.url, "utf8") > 8192 ||
    typeof value.body !== "string"
  ) {
    return null;
  }
  if (Buffer.byteLength(value.body, "utf8") > MAX_PROXY_PAYLOAD_BYTES) return null;
  if (value.headers === undefined) {
    return { tenantId: value.tenantId, serverId: value.serverId, url: value.url, body: value.body };
  }
  if (!isPlainRecord(value.headers)) return null;
  if (Object.keys(value.headers).some((key) => !ALLOWED_REQUEST_HEADERS.has(key))) return null;
  const headers: NonNullable<McpEgressProxyBody["headers"]> = {};
  const mapping = [
    ["accept", "accept"],
    ["contentType", "contentType"],
    ["mcpSessionId", "mcpSessionId"],
    ["mcpProtocolVersion", "mcpProtocolVersion"],
    ["upstreamAuthorization", "upstreamAuthorization"],
  ] as const;
  for (const [inputKey, outputKey] of mapping) {
    const headerValue = value.headers[inputKey];
    if (headerValue !== undefined) {
      if (!isSafeHeaderValue(headerValue)) return null;
      headers[outputKey] = headerValue;
    }
  }
  return {
    tenantId: value.tenantId,
    serverId: value.serverId,
    url: value.url,
    headers,
    body: value.body,
  };
}

/**
 * Keep the proxy's destination policy independent from its transport adapter.
 * The Worker applies the same policy, while the Node transport additionally
 * pins DNS answers and rejects private/special-purpose addresses.
 */
function isAllowedMcpEndpoint(input: string): boolean {
  try {
    const url = new URL(input);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return (
      url.protocol === "https:" &&
      hostname.length > 0 &&
      isIP(hostname) === 0 &&
      (url.port === "" || url.port === "443") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

class RequestBodyTimeoutError extends Error {
  constructor() {
    super("proxy request body timeout");
    this.name = "RequestBodyTimeoutError";
  }
}

async function readBoundedRequestWithTimeout(request: Request, timeoutMs: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_PROXY_PAYLOAD_BYTES)
  ) {
    throw new RangeError("payload too large");
  }
  if (!request.body) throw new SyntaxError("missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectTimeout: ((reason?: unknown) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    rejectTimeout?.(new RequestBodyTimeoutError());
  }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROXY_PAYLOAD_BYTES) throw new RangeError("payload too large");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may still have a read settling; it is already detached from the request.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelOnAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) {
    cancelOnAbort();
    throw signal.reason ?? new Error("proxy upstream timeout");
  }
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason ?? new Error("proxy upstream timeout");
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROXY_PAYLOAD_BYTES) {
        await reader.cancel();
        throw new RangeError("upstream response too large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Creates an authenticated, bounded MCP egress endpoint for Web Request runtimes. */
export function createMcpEgressProxyHandler(options: McpEgressProxyOptions) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const bodyReadTimeoutMs = options.bodyReadTimeoutMs ?? DEFAULT_PROXY_BODY_READ_TIMEOUT_MS;
  const maxInFlight = options.maxInFlight ?? DEFAULT_PROXY_MAX_IN_FLIGHT;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const rateLimit = options.rateLimit ?? { limit: 300, windowMs: 60_000 };
  if (
    options.proxyToken.length < 32 ||
    options.proxyToken.length > 512 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(bodyReadTimeoutMs) ||
    bodyReadTimeoutMs <= 0
  ) {
    throw new TypeError("MCP egress proxy signing secret and positive timeout are required");
  }
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 1000) {
    throw new TypeError("MCP egress proxy in-flight limit is invalid");
  }
  if (
    !Number.isInteger(rateLimit.limit) ||
    rateLimit.limit < 1 ||
    !Number.isFinite(rateLimit.windowMs) ||
    rateLimit.windowMs < 1
  ) {
    throw new TypeError("MCP egress proxy rate limit is invalid");
  }
  const seenNonces = new Map<string, number>();
  let rateWindow = -1;
  let rateCount = 0;
  let inFlightCount = 0;

  return async function handle(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/healthz") {
      if (request.method !== "GET") {
        return new Response(null, {
          status: 405,
          headers: { allow: "GET", "cache-control": "no-store" },
        });
      }
      return jsonResponse({ status: "ok" });
    }
    if (requestUrl.pathname !== REQUEST_PATH) return jsonResponse({ error: "not_found" }, 404);
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "cache-control": "no-store" },
      });
    }
    let rawBody: string;
    try {
      rawBody = await readBoundedRequestWithTimeout(request, bodyReadTimeoutMs);
    } catch (error) {
      if (error instanceof RequestBodyTimeoutError) {
        return jsonResponse({ error: "request_timeout" }, 408);
      }
      return jsonResponse(
        { error: error instanceof RangeError ? "payload_too_large" : "invalid_json" },
        error instanceof RangeError ? 413 : 400
      );
    }
    const timestamp = request.headers.get("x-omniroute-timestamp") ?? "";
    const nonce = request.headers.get("x-omniroute-nonce") ?? "";
    const signature = request.headers.get("x-omniroute-signature") ?? "";
    if (!/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const timestampSeconds = Number(timestamp);
    const now = nowSeconds();
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(now - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS
    ) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const expectedSignature = createMcpEgressSignature(
      rawBody,
      timestamp,
      nonce,
      options.proxyToken
    );
    if (!constantTimeSignatureMatch(signature, expectedSignature)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    for (const [seenNonce, expiresAt] of seenNonces) {
      if (expiresAt < now) seenNonces.delete(seenNonce);
    }
    if (seenNonces.has(nonce) || seenNonces.size >= MAX_REPLAYED_NONCES) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    seenNonces.set(nonce, timestampSeconds + MAX_CLOCK_SKEW_SECONDS);
    const currentRateWindow = Math.floor((now * 1000) / rateLimit.windowMs);
    if (currentRateWindow !== rateWindow) {
      rateWindow = currentRateWindow;
      rateCount = 0;
    }
    if (rateCount >= rateLimit.limit) return jsonResponse({ error: "rate_limited" }, 429);
    rateCount += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    const payload = validateBody(parsed);
    if (!payload || !isAllowedMcpEndpoint(payload.url)) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    if (inFlightCount >= maxInFlight) return jsonResponse({ error: "proxy_busy" }, 503);

    const upstreamHeaders = new Headers();
    if (payload.headers?.accept) upstreamHeaders.set("accept", payload.headers.accept);
    if (payload.headers?.contentType)
      upstreamHeaders.set("content-type", payload.headers.contentType);
    if (payload.headers?.mcpSessionId) {
      upstreamHeaders.set("mcp-session-id", payload.headers.mcpSessionId);
    }
    if (payload.headers?.mcpProtocolVersion) {
      upstreamHeaders.set("mcp-protocol-version", payload.headers.mcpProtocolVersion);
    }
    if (payload.headers?.upstreamAuthorization) {
      upstreamHeaders.set("authorization", payload.headers.upstreamAuthorization);
    }

    const abort = new AbortController();
    inFlightCount += 1;
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      inFlightCount -= 1;
    };
    let rejectTimeout: ((reason?: unknown) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      abort.abort(new Error("proxy upstream timeout"));
      rejectTimeout?.(new Error("proxy upstream timeout"));
    }, timeoutMs);
    timer.unref?.();
    const upstreamOperation = (async () => {
      const upstream = await options.transport.fetch(
        payload.url,
        {
          method: "POST",
          headers: upstreamHeaders,
          body: payload.body,
          redirect: "manual",
          signal: abort.signal,
        },
        { tenantId: payload.tenantId, serverId: payload.serverId }
      );
      const body = await readBoundedResponse(upstream, abort.signal);
      const headers: { contentType?: string; mcpSessionId?: string } = {};
      const contentType = upstream.headers.get("content-type");
      const mcpSessionId = upstream.headers.get("mcp-session-id");
      if (contentType) headers.contentType = contentType;
      if (mcpSessionId) headers.mcpSessionId = mcpSessionId;
      const serialized = JSON.stringify({ status: upstream.status, headers, body });
      if (Buffer.byteLength(serialized, "utf8") > MAX_PROXY_PAYLOAD_BYTES) {
        return jsonResponse({ error: "upstream_response_too_large" }, 502);
      }
      return new Response(serialized, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    })();
    void upstreamOperation.then(releaseSlot, releaseSlot);
    try {
      return await Promise.race([upstreamOperation, timeout]);
    } catch (error) {
      return jsonResponse(
        { error: abort.signal.aborted ? "upstream_timeout" : "upstream_failure" },
        abort.signal.aborted ? 504 : error instanceof RangeError ? 502 : 502
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
