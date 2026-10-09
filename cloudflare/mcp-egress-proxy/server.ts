import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createNodePinnedMcpTransport } from "../../src/lib/mcp/nodePinnedMcpTransport.ts";
import { MAX_PROXY_PAYLOAD_BYTES, createMcpEgressProxyHandler } from "./handler.ts";

function sendJsonError(response: ServerResponse, status: number, error: string): void {
  const bytes = Buffer.from(JSON.stringify({ error }), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
  });
  response.end(bytes);
}

async function readIncomingBody(request: IncomingMessage): Promise<Buffer> {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_PROXY_PAYLOAD_BYTES)) {
    request.resume();
    throw new RangeError("payload too large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let oversized = false;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_PROXY_PAYLOAD_BYTES) {
      oversized = true;
      chunks.length = 0;
      continue;
    }
    if (!oversized) chunks.push(bytes);
  }
  if (oversized) throw new RangeError("payload too large");
  return Buffer.concat(chunks, total);
}

/** Starts the standalone Node.js HTTP service. No request details are logged. */
export function startMcpEgressProxyServer(options: {
  proxyToken: string;
  port?: number;
  host?: string;
  timeoutMs?: number;
}): ReturnType<typeof createServer> {
  const handler = createMcpEgressProxyHandler({
    proxyToken: options.proxyToken,
    timeoutMs: options.timeoutMs,
    transport: createNodePinnedMcpTransport(),
  });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const signedHeaders = ["x-omniroute-timestamp", "x-omniroute-nonce", "x-omniroute-signature"];
      const requestPath = new URL(incoming.url ?? "/", "http://localhost").pathname;
      const isHealthRequest = requestPath === "/healthz";
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
      const body = isHealthRequest ? Buffer.alloc(0) : await readIncomingBody(incoming);
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
      const result = await handler(request);
      const responseBody = Buffer.from(await result.arrayBuffer());
      const responseHeaders = Object.fromEntries(result.headers.entries());
      outgoing.writeHead(result.status, {
        ...responseHeaders,
        "content-length": responseBody.byteLength,
      });
      outgoing.end(responseBody);
    } catch (error) {
      if (!outgoing.headersSent && !outgoing.destroyed) {
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
  const port = Number(process.env.PORT ?? "8788");
  startMcpEgressProxyServer({ proxyToken, port, host: process.env.HOST ?? "127.0.0.1" });
}
