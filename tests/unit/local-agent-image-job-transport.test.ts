import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpLocalAgentGatewayTransport } from "../../src/lib/localAgent/httpGatewayTransport";
import type { LocalAgentGatewaySession } from "../../src/lib/localAgent/gatewayProtocol";

const session: LocalAgentGatewaySession = {
  sessionId: "session-1",
  deviceId: "device-1",
  tenantId: "tenant-1",
  sessionToken: "s".repeat(43),
  leaseExpiresAt: "2026-10-10T00:00:00.000Z",
};

test("HTTP transport uses authenticated image-job control, raw artifact, complete, and fail requests", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; body: BodyInit | null }> =
    [];
  const transport = createHttpLocalAgentGatewayTransport("https://gateway.example.test", {
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: (init?.body as BodyInit | null | undefined) ?? null,
      });
      const url = new URL(String(input));
      if (url.pathname.endsWith("/control")) return Response.json({ status: "running" });
      return Response.json({ accepted: true });
    },
  });
  const artifact = new Uint8Array([1, 2, 3, 4]);
  assert.equal(await transport.getImageJobControl?.(session, "job-1"), "running");
  assert.equal(
    await transport.uploadImageJobArtifact?.(session, "job-1", artifact, "image/png"),
    true
  );
  assert.equal(await transport.completeImageJob?.(session, "job-1", "prompt_1"), true);
  assert.equal(await transport.failImageJob?.(session, "job-1", "execution_failed"), true);

  assert.deepEqual(
    requests.map((request) => [request.method, new URL(request.url).pathname]),
    [
      ["GET", "/__gateway/v1/device/image-jobs/job-1/control"],
      ["PUT", "/__gateway/v1/device/image-jobs/job-1/artifact"],
      ["POST", "/__gateway/v1/device/image-jobs/job-1/complete"],
      ["POST", "/__gateway/v1/device/image-jobs/job-1/fail"],
    ]
  );
  for (const request of requests) {
    assert.equal(request.headers.get("x-device-id"), session.deviceId);
    assert.equal(request.headers.get("authorization"), `Bearer ${session.sessionToken}`);
  }
  assert.equal(requests[1].headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await new Response(requests[1].body).arrayBuffer()), artifact);
  assert.deepEqual(JSON.parse(String(requests[2].body)), { promptId: "prompt_1" });
  assert.deepEqual(JSON.parse(String(requests[3].body)), { code: "execution_failed" });
});

test("HTTP transport treats a missing image job as expired and rejects unsafe artifact metadata", async () => {
  let calls = 0;
  const transport = createHttpLocalAgentGatewayTransport("https://gateway.example.test", {
    fetch: async () => {
      calls += 1;
      return new Response("", { status: 404 });
    },
  });
  assert.equal(await transport.getImageJobControl?.(session, "missing-job"), "expired");
  assert.equal(
    await transport.uploadImageJobArtifact?.(
      session,
      "missing-job",
      new Uint8Array([1]),
      "text/plain"
    ),
    false
  );
  assert.equal(
    await transport.uploadImageJobArtifact?.(
      session,
      "missing-job",
      new Uint8Array(10 * 1024 * 1024 + 1),
      "image/png"
    ),
    false
  );
  assert.equal(calls, 1, "invalid artifacts must be rejected before network access");
});
