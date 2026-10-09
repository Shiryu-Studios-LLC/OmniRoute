import { createHmac, timingSafeEqual } from "node:crypto";
import type { McpOutboundTransport } from "../../src/lib/mcp/mcpOutboundTransport.ts";

export const OIDC_PROXY_PATH = "/v1/oidc/fetch";
const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 30;
const OPERATIONS = new Set(["discovery", "token", "jwks"]);

type OidcOperation = "discovery" | "token" | "jwks";

interface OidcProxyPayload {
  issuer: string;
  operation: OidcOperation;
  url: string;
  method: "GET" | "POST";
  body?: string;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function signature(rawBody: string, timestamp: string, nonce: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}\n${nonce}\n${rawBody}`).digest("hex");
}

function equalSignature(received: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host.length > 0 &&
    !host.startsWith("[") &&
    !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) &&
    host !== "localhost" &&
    ![".localhost", ".local", ".internal", ".test", ".invalid", ".example"].some((suffix) =>
      host.endsWith(suffix)
    )
  );
}

function parseIssuerAndTarget(payload: OidcProxyPayload): { issuer: URL; target: URL } | null {
  try {
    const issuer = new URL(payload.issuer);
    const target = new URL(payload.url);
    const validBase = (url: URL) =>
      url.protocol === "https:" &&
      url.port === "" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      isPublicHostname(url.hostname);
    if (!validBase(issuer) || !validBase(target) || target.origin !== issuer.origin) return null;
    const issuerPath = issuer.pathname.replace(/\/$/, "");
    if (payload.operation === "discovery") {
      const expectedPath = `${issuerPath}/.well-known/openid-configuration`;
      if (
        payload.method !== "GET" ||
        target.pathname !== expectedPath ||
        payload.body !== undefined
      )
        return null;
    } else if (payload.operation === "token") {
      if (
        payload.method !== "POST" ||
        typeof payload.body !== "string" ||
        Buffer.byteLength(payload.body, "utf8") > 24 * 1024 ||
        !target.pathname.startsWith("/")
      ) {
        return null;
      }
    } else if (
      payload.method !== "GET" ||
      payload.body !== undefined ||
      !target.pathname.startsWith("/")
    ) {
      return null;
    }
    // Reject encoded separators and dot segments so intermediaries cannot
    // reinterpret the approved path as a different request target.
    if (/%(?:2f|5c|2e)/i.test(target.pathname) || target.pathname.includes("\\")) return null;
    return { issuer, target };
  } catch {
    return null;
  }
}

function validatePayload(value: unknown): OidcProxyPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["issuer", "operation", "url", "method", "body"].includes(key)
    ) ||
    typeof record.issuer !== "string" ||
    record.issuer.length > 2048 ||
    typeof record.operation !== "string" ||
    !OPERATIONS.has(record.operation) ||
    typeof record.url !== "string" ||
    record.url.length > 2048 ||
    (record.method !== "GET" && record.method !== "POST") ||
    (record.body !== undefined && typeof record.body !== "string")
  ) {
    return null;
  }
  const payload = record as unknown as OidcProxyPayload;
  return parseIssuerAndTarget(payload) ? payload : null;
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
  if (signal.aborted) throw signal.reason;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RangeError("OIDC response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
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

/** Private fixed-binding endpoint for the Worker's OIDC discovery/token/JWKS calls. */
export function createOidcEgressProxyHandler(options: {
  proxyToken: string;
  transport: McpOutboundTransport;
  timeoutMs?: number;
  nowSeconds?: () => number;
}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  if (options.proxyToken.length < 32 || options.proxyToken.length > 512 || timeoutMs <= 0) {
    throw new TypeError("OIDC proxy signing secret and positive timeout are required");
  }
  const nonces = new Map<string, number>();
  let inFlight = 0;
  return async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== OIDC_PROXY_PATH) return jsonResponse({ error: "not_found" }, 404);
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (!request.body) return jsonResponse({ error: "invalid_json" }, 400);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_REQUEST_BYTES) {
          await reader.cancel();
          return jsonResponse({ error: "too_large" }, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let rawBody: string;
    try {
      rawBody = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    const timestamp = request.headers.get("x-omniroute-timestamp") ?? "";
    const nonce = request.headers.get("x-omniroute-nonce") ?? "";
    const received = request.headers.get("x-omniroute-signature") ?? "";
    const now = nowSeconds();
    if (
      !/^\d{1,12}$/.test(timestamp) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
      Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS ||
      !equalSignature(received, signature(rawBody, timestamp, nonce, options.proxyToken))
    ) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    for (const [key, expiry] of nonces) if (expiry < now) nonces.delete(key);
    if (nonces.has(nonce) || nonces.size >= 50_000)
      return jsonResponse({ error: "unauthorized" }, 401);
    nonces.set(nonce, Number(timestamp) + MAX_CLOCK_SKEW_SECONDS);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    const payload = validatePayload(parsed);
    if (!payload) return jsonResponse({ error: "invalid_request" }, 400);
    const target = parseIssuerAndTarget(payload)?.target;
    if (!target) return jsonResponse({ error: "invalid_request" }, 400);
    if (inFlight >= 16) return jsonResponse({ error: "proxy_busy" }, 503);
    const abort = new AbortController();
    inFlight += 1;
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      inFlight -= 1;
    };
    let rejectTimeout: ((reason?: unknown) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      abort.abort(new Error("OIDC egress timeout"));
      rejectTimeout?.(new Error("OIDC egress timeout"));
    }, timeoutMs);
    timer.unref?.();
    const upstreamOperation = (async () => {
      const upstream = await options.transport.fetch(target.toString(), {
        method: payload.method,
        headers:
          payload.method === "POST"
            ? { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }
            : { accept: "application/json" },
        ...(payload.body === undefined ? {} : { body: payload.body }),
        redirect: "manual",
        signal: abort.signal,
      });
      const body = await readBounded(upstream, abort.signal);
      return jsonResponse({
        status: upstream.status,
        contentType: upstream.headers.get("content-type"),
        body,
      });
    })();
    void upstreamOperation.then(releaseSlot, releaseSlot);
    try {
      return await Promise.race([upstreamOperation, timeout]);
    } catch (error) {
      return jsonResponse(
        {
          error: abort.signal.aborted
            ? "upstream_timeout"
            : error instanceof RangeError
              ? "upstream_too_large"
              : "upstream_unavailable",
        },
        abort.signal.aborted ? 504 : 502
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
