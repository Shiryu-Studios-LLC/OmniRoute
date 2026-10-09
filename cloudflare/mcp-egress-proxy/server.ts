import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createNodePinnedMcpTransport } from "../../src/lib/mcp/nodePinnedMcpTransport.ts";
import { createOidcEgressProxyHandler, OIDC_PROXY_PATH } from "./oidcHandler.ts";
import {
  DEFAULT_PROXY_BODY_READ_TIMEOUT_MS,
  MAX_PROXY_PAYLOAD_BYTES,
  createMcpEgressProxyHandler,
} from "./handler.ts";

function sendJsonError(response: ServerResponse, status: number, error: string): void {
  const bytes = Buffer.from(JSON.stringify({ error }), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
  });
  response.end(bytes);
}

class IncomingBodyTimeoutError extends Error {
  constructor() {
    super("proxy request body timeout");
    this.name = "IncomingBodyTimeoutError";
  }
}

async function readIncomingBody(
  request: IncomingMessage,
  timeoutMs: number,
  maxBytes = MAX_PROXY_PAYLOAD_BYTES
): Promise<Buffer> {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    request.resume();
    throw new RangeError("payload too large");
  }
  const read = async () => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversized = false;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        oversized = true;
        chunks.length = 0;
        continue;
      }
      if (!oversized) chunks.push(bytes);
    }
    if (oversized) throw new RangeError("payload too large");
    return Buffer.concat(chunks, total);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new IncomingBodyTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Starts the standalone Node.js HTTP service. No request details are logged. */
export function startMcpEgressProxyServer(options: {
  proxyToken: string;
  oidcProxyToken?: string;
  port?: number;
  host?: string;
  timeoutMs?: number;
  bodyReadTimeoutMs?: number;
  maxInFlight?: number;
}): ReturnType<typeof createServer> {
  const bodyReadTimeoutMs = options.bodyReadTimeoutMs ?? DEFAULT_PROXY_BODY_READ_TIMEOUT_MS;
  if (!Number.isFinite(bodyReadTimeoutMs) || bodyReadTimeoutMs <= 0) {
    throw new TypeError("MCP egress proxy body read timeout must be positive");
  }
  const handler = createMcpEgressProxyHandler({
    proxyToken: options.proxyToken,
    timeoutMs: options.timeoutMs,
    bodyReadTimeoutMs,
    maxInFlight: options.maxInFlight,
    transport: createNodePinnedMcpTransport(),
  });
  const oidcHandler = createOidcEgressProxyHandler({
    proxyToken: options.oidcProxyToken ?? options.proxyToken,
    transport: createNodePinnedMcpTransport(),
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const signedHeaders = ["x-omniroute-timestamp", "x-omniroute-nonce", "x-omniroute-signature"];
      const requestPath = new URL(incoming.url ?? "/", "http://localhost").pathname;
      const isHealthRequest = requestPath === "/healthz";
      const isOidcRequest = requestPath === OIDC_PROXY_PATH;
      if (isHealthRequest && incoming.method !== "GET") {
        outgoing.writeHead(405, {
          allow: "GET",
          "cache-control": "no-store",
          "content-length": "0",
        });
        outgoing.end();
        return;
      }
      if (!isHealthRequest) {
        for (const name of signedHeaders) {
          const rawValues: string[] = [];
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            if (incoming.rawHeaders[index].toLowerCase() === name) {
              rawValues.push(incoming.rawHeaders[index + 1]);
            }
          }
          const normalized = incoming.headers[name];
          if (
            rawValues.length !== 1 ||
            typeof normalized !== "string" ||
            rawValues[0] !== normalized
          ) {
            sendJsonError(outgoing, 401, "unauthorized");
            return;
          }
        }
      }
      const body = isHealthRequest
        ? Buffer.alloc(0)
        : await readIncomingBody(
            incoming,
            bodyReadTimeoutMs,
            isOidcRequest ? 96 * 1024 : MAX_PROXY_PAYLOAD_BYTES
          );
      const host = incoming.headers.host ?? "localhost";
      const requestHeaders = new Headers();
      for (const name of signedHeaders) {
        const value = incoming.headers[name];
        if (typeof value === "string") requestHeaders.set(name, value);
      }
      requestHeaders.set("content-type", incoming.headers["content-type"] ?? "application/json");
      const request = new Request(`http://${host}${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers: requestHeaders,
        body: body.byteLength ? new Uint8Array(body) : undefined,
      });
      const result = await (isOidcRequest ? oidcHandler(request) : handler(request));
      const responseBody = Buffer.from(await result.arrayBuffer());
      const responseHeaders = Object.fromEntries(result.headers.entries());
      outgoing.writeHead(result.status, {
        ...responseHeaders,
        "content-length": responseBody.byteLength,
      });
      outgoing.end(responseBody);
    } catch (error) {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        if (error instanceof IncomingBodyTimeoutError) {
          incoming.pause();
          sendJsonError(outgoing, 408, "request_timeout");
          outgoing.once("finish", () => incoming.destroy());
          return;
        }
        sendJsonError(
          outgoing,
          error instanceof RangeError ? 413 : 400,
          error instanceof RangeError ? "payload_too_large" : "invalid_request"
        );
      }
    }
  });
  server.listen(options.port ?? 8788, options.host ?? "127.0.0.1");
  return server;
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  const proxyToken = process.env.MCP_EGRESS_PROXY_TOKEN;
  if (!proxyToken) throw new Error("MCP_EGRESS_PROXY_TOKEN must be configured");
  const oidcProxyToken = process.env.OIDC_EGRESS_PROXY_TOKEN;
  const port = Number(process.env.PORT ?? "8788");
  const rawMaxInFlight = process.env.MCP_EGRESS_PROXY_MAX_IN_FLIGHT;
  startMcpEgressProxyServer({
    proxyToken,
    ...(oidcProxyToken ? { oidcProxyToken } : {}),
    port,
    host: process.env.HOST ?? "127.0.0.1",
    ...(rawMaxInFlight ? { maxInFlight: Number(rawMaxInFlight) } : {}),
  });
}
