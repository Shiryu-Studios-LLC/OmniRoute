import { McpOutboundEgressError, type McpOutboundTransport } from "../lib/mcp/mcpOutboundTransport";

export interface CloudMcpEgressBinding {
  fetch(request: Request): Promise<Response>;
}

const PROXY_URL = "http://omniroute-mcp-egress.internal:8080/v1/mcp/forward";
const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
]);

interface ProxyResponseEnvelope {
  status: number;
  headers: { contentType?: string; mcpSessionId?: string };
  body: string;
}

async function readBoundedText(
  response: Response,
  limit: number,
  signal: AbortSignal
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>(
        (resolve, reject) => {
          if (signal.aborted) {
            void reader.cancel();
            reject(new Error("MCP egress proxy response read aborted"));
            return;
          }
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            void reader.cancel();
            reject(new Error("MCP egress proxy response read aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          reader.read().then(
            (result) => {
              signal.removeEventListener("abort", onAbort);
              resolve(result);
            },
            (error: unknown) => {
              signal.removeEventListener("abort", onAbort);
              reject(error);
            }
          );
        }
      );
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel();
        throw new McpOutboundEgressError(
          "MCP_OUTBOUND_DNS_REJECTED",
          "MCP egress proxy response exceeded the configured limit"
        );
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
  return new TextDecoder().decode(bytes);
}

function readAllowedHeaders(input: HeadersInit | undefined): {
  accept?: string;
  upstreamAuthorization?: string;
  contentType?: string;
  mcpSessionId?: string;
  mcpProtocolVersion?: string;
} {
  const headers = new Headers(input);
  for (const name of headers.keys()) {
    if (!ALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new McpOutboundEgressError(
        "MCP_OUTBOUND_DNS_REJECTED",
        "MCP egress proxy request headers were rejected"
      );
    }
  }
  const accept = headers.get("accept") ?? undefined;
  const authorization = headers.get("authorization") ?? undefined;
  const contentType = headers.get("content-type") ?? undefined;
  const mcpSessionId = headers.get("mcp-session-id") ?? undefined;
  const mcpProtocolVersion = headers.get("mcp-protocol-version") ?? undefined;
  if (
    (accept !== undefined && accept.length > 256) ||
    (authorization !== undefined && authorization.length > 8_192) ||
    (contentType !== undefined && contentType.length > 128) ||
    (mcpSessionId !== undefined && mcpSessionId.length > 512) ||
    (mcpProtocolVersion !== undefined && mcpProtocolVersion.length > 128)
  ) {
    throw new McpOutboundEgressError(
      "MCP_OUTBOUND_DNS_REJECTED",
      "MCP egress proxy request headers were rejected"
    );
  }
  return {
    ...(accept ? { accept } : {}),
    ...(authorization ? { upstreamAuthorization: authorization } : {}),
    ...(contentType ? { contentType } : {}),
    ...(mcpSessionId ? { mcpSessionId } : {}),
    ...(mcpProtocolVersion ? { mcpProtocolVersion } : {}),
  };
}

function validateEndpoint(input: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch {
    throw new McpOutboundEgressError("MCP_OUTBOUND_DNS_REJECTED", "MCP endpoint was rejected");
  }
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname ||
    endpoint.hostname.includes(":") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(endpoint.hostname) ||
    (endpoint.port !== "" && endpoint.port !== "443") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    throw new McpOutboundEgressError("MCP_OUTBOUND_DNS_REJECTED", "MCP endpoint was rejected");
  }
  return endpoint.toString();
}

function parseEnvelope(value: unknown): ProxyResponseEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpOutboundEgressError(
      "MCP_OUTBOUND_DNS_REJECTED",
      "MCP egress proxy returned an invalid response"
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["status", "headers", "body"].includes(key)) ||
    !Number.isInteger(record.status) ||
    (record.status as number) < 200 ||
    (record.status as number) > 599 ||
    typeof record.body !== "string" ||
    new TextEncoder().encode(record.body).byteLength > MAX_PROXY_BODY_BYTES ||
    !record.headers ||
    typeof record.headers !== "object" ||
    Array.isArray(record.headers)
  ) {
    throw new McpOutboundEgressError(
      "MCP_OUTBOUND_DNS_REJECTED",
      "MCP egress proxy returned an invalid response"
    );
  }
  const headers = record.headers as Record<string, unknown>;
  if (
    Object.keys(headers).some((key) => !["contentType", "mcpSessionId"].includes(key)) ||
    (headers.contentType !== undefined &&
      (typeof headers.contentType !== "string" ||
        headers.contentType.length > 256 ||
        /[\r\n\0]/.test(headers.contentType))) ||
    (headers.mcpSessionId !== undefined &&
      (typeof headers.mcpSessionId !== "string" || headers.mcpSessionId.length > 512))
  ) {
    throw new McpOutboundEgressError(
      "MCP_OUTBOUND_DNS_REJECTED",
      "MCP egress proxy returned invalid response headers"
    );
  }
  return {
    status: record.status as number,
    headers: {
      ...(typeof headers.contentType === "string" ? { contentType: headers.contentType } : {}),
      ...(typeof headers.mcpSessionId === "string" ? { mcpSessionId: headers.mcpSessionId } : {}),
    },
    body: record.body,
  };
}

/**
 * Create the Worker-side transport for a dedicated VPC Service bound to the
 * pinned Node egress proxy. This binding never receives the customer URL as
 * its destination; the URL is data sent to the fixed private proxy endpoint.
 */
export function createCloudMcpEgressTransport(input: {
  binding?: CloudMcpEgressBinding;
  proxyToken?: string;
  timeoutMs?: number;
}): McpOutboundTransport | null {
  const binding = input.binding;
  const proxyToken = input.proxyToken;
  if (!binding || !proxyToken) return null;
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(proxyToken)) {
    throw new TypeError("MCP egress proxy token is invalid");
  }
  const timeoutMs = Math.max(100, Math.min(input.timeoutMs ?? 15_000, 30_000));

  return {
    async fetch(endpointInput, init, context) {
      if (
        init.method !== "POST" ||
        typeof init.body !== "string" ||
        !context ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(context.tenantId) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(context.serverId)
      ) {
        throw new McpOutboundEgressError(
          "MCP_OUTBOUND_DNS_REJECTED",
          "MCP egress proxy only accepts JSON POST requests"
        );
      }
      const endpoint = validateEndpoint(endpointInput);
      const bodyBytes = new TextEncoder().encode(init.body);
      if (bodyBytes.byteLength > MAX_PROXY_BODY_BYTES) {
        throw new McpOutboundEgressError(
          "MCP_OUTBOUND_DNS_REJECTED",
          "MCP egress proxy request exceeded the configured limit"
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const signal = init.signal;
      const abortFromCaller = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", abortFromCaller, { once: true });
      try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = crypto.randomUUID();
        const proxyBody = JSON.stringify({
          tenantId: context.tenantId,
          serverId: context.serverId,
          url: endpoint,
          headers: readAllowedHeaders(init.headers),
          body: init.body,
        });
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(proxyToken),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const signed = await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${timestamp}\n${nonce}\n${proxyBody}`)
        );
        const signature = Array.from(new Uint8Array(signed), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");
        const response = await binding.fetch(
          new Request(PROXY_URL, {
            method: "POST",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              "X-OmniRoute-Timestamp": timestamp,
              "X-OmniRoute-Nonce": nonce,
              "X-OmniRoute-Signature": signature,
              "Content-Type": "application/json",
            },
            body: proxyBody,
          })
        );
        if (!response.ok) {
          throw new McpOutboundEgressError(
            "MCP_OUTBOUND_DNS_REJECTED",
            "MCP egress proxy rejected the request"
          );
        }
        const text = await readBoundedText(
          response,
          MAX_PROXY_BODY_BYTES + 16_384,
          controller.signal
        );
        let decoded: unknown;
        try {
          decoded = JSON.parse(text) as unknown;
        } catch {
          throw new McpOutboundEgressError(
            "MCP_OUTBOUND_DNS_REJECTED",
            "MCP egress proxy returned an invalid response"
          );
        }
        const envelope = parseEnvelope(decoded);
        const headers = new Headers();
        if (envelope.headers.contentType) headers.set("Content-Type", envelope.headers.contentType);
        if (envelope.headers.mcpSessionId) {
          headers.set("Mcp-Session-Id", envelope.headers.mcpSessionId);
        }
        const noBodyStatus = [204, 205, 304].includes(envelope.status);
        return new Response(noBodyStatus || envelope.body.length === 0 ? null : envelope.body, {
          status: envelope.status,
          headers,
        });
      } catch (error) {
        if (error instanceof McpOutboundEgressError) throw error;
        if (controller.signal.aborted) {
          throw new McpOutboundEgressError(
            "MCP_OUTBOUND_DNS_REJECTED",
            "MCP egress proxy request timed out"
          );
        }
        throw new McpOutboundEgressError(
          "MCP_OUTBOUND_DNS_REJECTED",
          "MCP egress proxy is unavailable"
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}
