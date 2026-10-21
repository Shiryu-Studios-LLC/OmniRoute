/**
 * Opt-in, provider-scoped HTTP and WebSocket gateway for providers whose
 * native client talks to more than OmniRoute's normalized `/v1` APIs.
 *
 * A provider is reachable only when it is explicitly mapped in
 * OMNIROUTE_PROVIDER_GATEWAYS (JSON: {"providerId":"public-host"} or an
 * array of host aliases). The
 * upstream URL is resolved from that provider's active OmniRoute connection,
 * so ComfyUI's browser, desktop client, and MCP client see the same upstream
 * model inventory and API surface through this gateway.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProviderConnections } from "@/lib/db/providers";
import { getProviderById } from "@/shared/constants/providers";
import {
  attachRequestStreamGuards,
  installProcessCrashGuard,
} from "@/shared/utils/httpClientAbortGuard.mjs";

const DEFAULT_PORT = 20133;
const DEFAULT_HOST = "127.0.0.1";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
]);

type ProviderGatewayMap = Record<string, string>;

declare global {
  var __omnirouteProviderGatewayStarted: boolean | undefined;
}

/** Parse and normalize the explicitly enabled provider-to-host mappings. */
export function parseProviderGatewayMap(raw: string | undefined): ProviderGatewayMap {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[ProviderGateway] Ignoring invalid OMNIROUTE_PROVIDER_GATEWAYS JSON");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const result: ProviderGatewayMap = {};
  for (const [providerId, hostValue] of Object.entries(parsed)) {
    const hosts = Array.isArray(hostValue) ? hostValue : [hostValue];
    for (const value of hosts) {
      if (typeof value !== "string") continue;
      const host = value.trim().toLowerCase();
      if (
        !providerId.trim() ||
        !host ||
        host.includes("/") ||
        host.includes(":") ||
        host.includes("@")
      ) {
        continue;
      }
      result[host] = providerId.trim();
    }
  }
  return result;
}

function writeError(socket: net.Socket, status: number, message: string): void {
  if (socket.destroyed || !socket.writable) return;
  const body = Buffer.from(JSON.stringify({ error: message }), "utf8");
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n` +
      "Connection: close\r\nContent-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n\r\n${body.toString("utf8")}`
  );
}

function providerForRequest(req: IncomingMessage): string | null {
  const hostHeader = req.headers.host?.split(":", 1)[0]?.toLowerCase();
  if (!hostHeader) return null;
  return parseProviderGatewayMap(process.env.OMNIROUTE_PROVIDER_GATEWAYS)[hostHeader] ?? null;
}

async function resolveUpstreamBaseUrl(providerId: string): Promise<string | null> {
  const connections = await getProviderConnections({ provider: providerId, isActive: true });
  const connection = connections.find((item) => {
    const psd = item.providerSpecificData;
    return psd && typeof psd === "object" && typeof psd.baseUrl === "string" && psd.baseUrl.trim();
  });
  const psd = connection?.providerSpecificData;
  const configuredUrl =
    psd && typeof psd === "object" && typeof psd.baseUrl === "string" ? psd.baseUrl.trim() : "";
  const localDefault = getProviderById(providerId)?.localDefault;
  const rawUrl = configuredUrl || localDefault;
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function upstreamUrl(baseUrl: string, requestUrl: string): URL {
  const incoming = new URL(requestUrl, "http://gateway.invalid");
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/$/, "")}${incoming.pathname}`;
  base.search = incoming.search;
  return base;
}

function forwardHeaders(
  headers: IncomingMessage["headers"],
  target: URL
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = value;
  }
  result.host = target.host;
  result.origin = target.origin;
  result["x-forwarded-host"] = headers.host;
  const forwardedProto = headers["x-forwarded-proto"];
  result["x-forwarded-proto"] = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : (forwardedProto ?? "http");
  if (headers.upgrade?.toLowerCase() === "websocket") {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  const cookies = headers.cookie;
  if (cookies) {
    const kept = (Array.isArray(cookies) ? cookies.join("; ") : cookies)
      .split(";")
      .map((cookie) => cookie.trim())
      .filter((cookie) => !/^CF_Authorization=/i.test(cookie));
    if (kept.length) result.cookie = kept.join("; ");
    else delete result.cookie;
  }
  return result;
}

function rewriteLocationHeader(location: string, target: URL, req: IncomingMessage): string {
  try {
    const parsed = new URL(location, target);
    if (parsed.origin !== target.origin) return location;
    const host = req.headers.host;
    if (!host) return location;
    const forwardedProto = req.headers["x-forwarded-proto"];
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    parsed.protocol = proto === "https" ? "https:" : "http:";
    parsed.host = host;
    return parsed.toString();
  } catch {
    return location;
  }
}

async function proxyHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const providerId = providerForRequest(req);
  if (!providerId) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "provider_gateway_not_configured" }));
    return;
  }
  console.log(
    `[ProviderGateway] ${providerId} ${req.method ?? "GET"} ${(req.url ?? "/").split("?", 1)[0]}`
  );
  const baseUrl = await resolveUpstreamBaseUrl(providerId);
  if (!baseUrl) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "provider_upstream_not_configured", provider: providerId }));
    return;
  }

  const target = upstreamUrl(baseUrl, req.url ?? "/");
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(
    target,
    { method: req.method, headers: forwardHeaders(req.headers, target) },
    (upstreamResponse) => {
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
        headers[name] =
          name.toLowerCase() === "location" && typeof value === "string"
            ? rewriteLocationHeader(value, target, req)
            : value;
      }
      headers["cache-control"] = "no-store";
      res.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(res);
    }
  );
  upstream.setTimeout(0); // ComfyUI jobs and event streams can remain open for a long time.
  upstream.on("error", (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "provider_upstream_unavailable", provider: providerId }));
  });
  req.pipe(upstream);
}

async function proxyWebSocket(
  req: IncomingMessage,
  socket: net.Socket,
  head: Buffer
): Promise<void> {
  const providerId = providerForRequest(req);
  if (!providerId)
    return writeError(socket, 404, "Provider gateway is not configured for this host");
  console.log(`[ProviderGateway] ${providerId} WS ${(req.url ?? "/").split("?", 1)[0]}`);
  const baseUrl = await resolveUpstreamBaseUrl(providerId);
  if (!baseUrl)
    return writeError(socket, 503, `Provider '${providerId}' has no active upstream URL`);

  const target = upstreamUrl(baseUrl, req.url ?? "/");
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(target, {
    method: req.method,
    headers: forwardHeaders(req.headers, target),
  });
  upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    const status = response.statusCode ?? 101;
    const reason = response.statusMessage ?? "Switching Protocols";
    const headerLines = Object.entries(response.headers)
      .flatMap(([name, value]) => {
        if (value === undefined) return [];
        return (Array.isArray(value) ? value : [value]).map((entry) => `${name}: ${entry}`);
      })
      .join("\r\n");
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n${headerLines}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
    socket.once("error", () => upstreamSocket.destroy());
    upstreamSocket.once("error", () => socket.destroy());
    socket.once("close", () => upstreamSocket.destroy());
    upstreamSocket.once("close", () => socket.destroy());
  });
  upstream.on("response", (response) => {
    writeError(socket, response.statusCode ?? 502, "Upstream rejected WebSocket upgrade");
  });
  upstream.on("error", () => writeError(socket, 502, "Provider WebSocket upstream unavailable"));
  upstream.end();
}

/** Start the opt-in provider gateway. No providers are exposed by default. */
export function initProviderGateway(): void {
  if (globalThis.__omnirouteProviderGatewayStarted) return;
  const providerMap = parseProviderGatewayMap(process.env.OMNIROUTE_PROVIDER_GATEWAYS);
  if (!Object.keys(providerMap).length) {
    console.log("[ProviderGateway] Disabled (no OMNIROUTE_PROVIDER_GATEWAYS mappings)");
    return;
  }

  installProcessCrashGuard();
  const host = process.env.OMNIROUTE_PROVIDER_GATEWAY_HOST?.trim() || DEFAULT_HOST;
  const port = Number.parseInt(
    process.env.OMNIROUTE_PROVIDER_GATEWAY_PORT ?? String(DEFAULT_PORT),
    10
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn("[ProviderGateway] Invalid OMNIROUTE_PROVIDER_GATEWAY_PORT; gateway disabled");
    return;
  }

  const server = http.createServer((req, res) => {
    attachRequestStreamGuards(req, res);
    proxyHttp(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "provider_gateway_error" }));
      } else res.destroy();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    proxyWebSocket(req, socket, head).catch(() =>
      writeError(socket, 502, "Provider gateway error")
    );
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.warn("[ProviderGateway] Failed to start:", error.message);
  });
  server.listen(port, host, () => {
    globalThis.__omnirouteProviderGatewayStarted = true;
    console.log(
      `[ProviderGateway] Listening on ${host}:${port} for ${Object.keys(providerMap).join(", ")}`
    );
  });
}
