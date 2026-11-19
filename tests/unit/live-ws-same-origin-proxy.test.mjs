import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";

import { proxyLiveWsUpgrade } from "../../scripts/dev/live-ws-proxy.mjs";

test("live-ws dashboard proxy relays the same-origin WebSocket upgrade", async () => {
  let received = "";
  const upstream = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\r\n\r\n")) {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
        );
      }
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = upstream.address().port;
  const dashboard = http.createServer((_req, res) => res.writeHead(404).end());
  dashboard.on("upgrade", (req, socket, head) => {
    if (!proxyLiveWsUpgrade(req, socket, head, { port: upstreamPort })) socket.destroy();
  });
  dashboard.listen(0, "127.0.0.1");
  await once(dashboard, "listening");
  const client = net.connect(dashboard.address().port, "127.0.0.1");
  const response = new Promise((resolve, reject) => {
    client.once("data", (chunk) => resolve(chunk.toString()));
    client.once("error", reject);
  });
  try {
    await once(client, "connect");
    client.write(
      "GET /live-ws HTTP/1.1\r\n" +
        "Host: omniroute.shiryu.org\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Cookie: auth_token=test-cookie\r\nOrigin: https://omniroute.shiryu.org\r\n\r\n"
    );
    assert.match(await response, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(received, /GET \/live-ws HTTP\/1\.1/);
    assert.match(received.toLowerCase(), /cookie: auth_token=test-cookie/);
    assert.match(received.toLowerCase(), /origin: https:\/\/omniroute\.shiryu\.org/);
  } finally {
    client.destroy();
    dashboard.close();
    upstream.close();
  }
});

test("live-ws dashboard proxy ignores non-live paths", () => {
  assert.equal(
    proxyLiveWsUpgrade({ url: "/v1/ws", method: "GET" }, { destroy() {} }, Buffer.alloc(0)),
    false
  );
  assert.equal(
    proxyLiveWsUpgrade({ url: "/live-ws-evil", method: "GET" }, { destroy() {} }, Buffer.alloc(0)),
    false
  );
});
