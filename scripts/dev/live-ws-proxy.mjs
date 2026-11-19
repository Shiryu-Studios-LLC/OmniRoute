/**
 * Forward the dashboard's same-origin /live-ws Upgrade to the local live sidecar.
 * A reverse proxy/Tunnel only exposes the main HTTP port; browsers cannot dial
 * the sidecar's loopback port from the public HTTPS site.
 *
 * This only forwards WebSocket upgrades to 127.0.0.1, never arbitrary hosts.
 * Authentication and Origin verification stay in src/server/ws/liveServer.ts.
 */
import net from "node:net";

export function proxyLiveWsUpgrade(req, socket, head, options = {}) {
  const route = options.path ?? "/live-ws";
  let pathname;
  try {
    pathname = new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  if (pathname !== route || req.method !== "GET") return false;

  const port = Number(options.port ?? process.env.LIVE_WS_PORT ?? 20132);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    socket.destroy();
    return true;
  }

  const upstream = net.connect({ host: "127.0.0.1", port });
  const fail = () => {
    if (!socket.destroyed) socket.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };
  upstream.once("error", fail);
  socket.once("error", fail);
  socket.once("close", () => {
    if (!upstream.destroyed) upstream.destroy();
  });
  upstream.setTimeout(10_000, fail);

  upstream.once("connect", () => {
    upstream.setTimeout(0);
    let handshake = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    // Raw header pairs preserve repeated Cookie and Sec-WebSocket-* headers.
    if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
      for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
        handshake += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
    } else {
      for (const [key, value] of Object.entries(req.headers ?? {})) {
        if (Array.isArray(value)) {
          for (const entry of value) handshake += `${key}: ${entry}\r\n`;
        } else if (value !== undefined) {
          handshake += `${key}: ${value}\r\n`;
        }
      }
    }
    upstream.write(handshake + "\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  return true;
}
