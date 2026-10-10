import test from "node:test";
import assert from "node:assert/strict";
import {
  createConnectorGateway,
  type GatewayCoordinator,
  type GatewayDeviceDirectory,
  type GatewayDeviceRecord,
  type GatewayDeviceRequest,
  type GatewaySessionRecord,
} from "../../src/cloud/connectorGateway.ts";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createMemoryAdapters(initialDevices: GatewayDeviceRecord[]) {
  const devices = new Map(initialDevices.map((device) => [device.id, { ...device }]));
  const sessions = new Map<string, GatewaySessionRecord>();
  const requests = new Map<string, GatewayDeviceRequest[]>();
  const directory: GatewayDeviceDirectory = {
    async getDevice(deviceId) {
      const device = devices.get(deviceId);
      return device ? { ...device } : null;
    },
    async revokeDevice(tenantId, deviceId, revokedAt) {
      const device = devices.get(deviceId);
      if (!device || device.tenantId !== tenantId) return false;
      device.revokedAt ??= revokedAt;
      return true;
    },
  };
  const coordinator: GatewayCoordinator = {
    async putSession(session) {
      sessions.set(session.deviceId, { ...session });
    },
    async getSession(deviceId) {
      const session = sessions.get(deviceId);
      return session ? { ...session } : null;
    },
    async touchSession(deviceId, sessionId, lastSeenAt, leaseExpiresAt) {
      const session = sessions.get(deviceId);
      if (!session || session.sessionId !== sessionId || session.revokedAt) return false;
      session.lastSeenAt = lastSeenAt;
      session.leaseExpiresAt = leaseExpiresAt;
      return true;
    },
    async revokeSession(deviceId, revokedAt, expectedSessionId) {
      const session = sessions.get(deviceId);
      if (session && (expectedSessionId === undefined || session.sessionId === expectedSessionId)) {
        session.revokedAt = revokedAt;
      }
    },
    async enqueueRequest(deviceId, request) {
      const rows = requests.get(deviceId) ?? [];
      if (rows.length >= 16) return false;
      rows.push({ ...request });
      requests.set(deviceId, rows);
      return true;
    },
    async takeRequests(deviceId, sessionId, timestamp) {
      const session = sessions.get(deviceId);
      if (
        !session ||
        session.sessionId !== sessionId ||
        session.revokedAt ||
        Date.parse(session.leaseExpiresAt) <= Date.parse(timestamp)
      )
        return [];
      const rows = requests.get(deviceId) ?? [];
      const delivered = rows.filter(
        (row) =>
          row.status === "pending" &&
          row.sessionId === sessionId &&
          Date.parse(row.expiresAt) > Date.parse(timestamp)
      );
      for (const row of delivered) row.status = "delivered";
      return delivered.map((row) => ({ ...row }));
    },
    async submitRequestResult(deviceId, sessionId, requestId, result, timestamp) {
      const row = (requests.get(deviceId) ?? []).find((request) => request.requestId === requestId);
      const session = sessions.get(deviceId);
      if (
        !row ||
        row.sessionId !== sessionId ||
        row.status !== "delivered" ||
        Date.parse(row.expiresAt) <= Date.parse(timestamp) ||
        !session ||
        session.sessionId !== sessionId ||
        session.revokedAt ||
        Date.parse(session.leaseExpiresAt) <= Date.parse(timestamp)
      )
        return false;
      row.status = "complete";
      row.result = result;
      return true;
    },
    async getRequest(deviceId, requestId, timestamp) {
      const row = (requests.get(deviceId) ?? []).find(
        (request) =>
          request.requestId === requestId && Date.parse(request.expiresAt) > Date.parse(timestamp)
      );
      return row ? { ...row } : null;
    },
    async deleteRequest(deviceId, requestId) {
      requests.set(
        deviceId,
        (requests.get(deviceId) ?? []).filter((row) => row.requestId !== requestId)
      );
    },
  };
  return { devices, sessions, requests, directory, coordinator };
}

test("gateway derives tenant from registered device and requires its credential", async () => {
  const credential = "customer-agent-registration-credential";
  const adapters = createMemoryAdapters([
    {
      id: "device_a",
      tenantId: "tenant_a",
      credentialHash: await sha256Hex(credential),
      capabilities: ["ollama.chat"],
      revokedAt: null,
    },
  ]);
  const gateway = createConnectorGateway({
    ...adapters,
    now: () => 1_800_000_000_000,
    createId: () => "session_a",
    createToken: () => "opaque-session-secret",
  });

  assert.equal(await gateway.connect("device_a", "wrong"), null);
  const session = await gateway.connect("device_a", credential);
  assert.ok(session);
  assert.equal(session.tenantId, "tenant_a");
  assert.equal(session.sessionToken, "opaque-session-secret");
  assert.equal(
    JSON.stringify(adapters.sessions.get("device_a")).includes(session.sessionToken),
    false
  );
  assert.deepEqual(
    await gateway.authorizeCapability({
      tenantId: "tenant_a",
      deviceId: "device_a",
      capability: "ollama.chat",
    }),
    {
      ok: true,
      target: {
        deviceId: "device_a",
        tenantId: "tenant_a",
        sessionId: "session_a",
        capability: "ollama.chat",
        leaseExpiresAt: new Date(1_800_000_045_000).toISOString(),
      },
    }
  );
  assert.deepEqual(
    await gateway.authorizeCapability({
      tenantId: "tenant_b",
      deviceId: "device_a",
      capability: "ollama.chat",
    }),
    { ok: false, reason: "tenant_mismatch" }
  );
  assert.deepEqual(await gateway.getDeviceHealth({ tenantId: "tenant_b", deviceId: "device_a" }), {
    ok: false,
    reason: "tenant_mismatch",
  });
  const connectedHealth = await gateway.getDeviceHealth({
    tenantId: "tenant_a",
    deviceId: "device_a",
  });
  assert.equal(connectedHealth.ok ? connectedHealth.health : null, "online");
  assert.deepEqual(
    await gateway.authorizeCapability({
      tenantId: "tenant_a",
      deviceId: "device_a",
      capability: "comfyui.generate",
    }),
    { ok: false, reason: "capability_unavailable" }
  );
});

test("session heartbeat extends a lease and expired sessions report offline", async () => {
  const credential = "agent-credential-b";
  let now = 1_800_000_000_000;
  const adapters = createMemoryAdapters([
    {
      id: "device_b",
      tenantId: "tenant_b",
      credentialHash: await sha256Hex(credential),
      capabilities: ["comfyui.generate"],
      revokedAt: null,
    },
  ]);
  const gateway = createConnectorGateway({
    ...adapters,
    now: () => now,
    createId: () => "session_b",
    createToken: () => "session-token-b",
  });
  const session = await gateway.connect("device_b", credential);
  assert.ok(session);
  assert.equal(await gateway.heartbeat("device_b", "bad-token"), false);
  now += 10_000;
  assert.equal(await gateway.heartbeat("device_b", session.sessionToken), true);
  assert.equal(adapters.sessions.get("device_b")?.lastSeenAt, new Date(now).toISOString());

  now += 45_001;
  assert.deepEqual(
    await gateway.authorizeCapability({
      tenantId: "tenant_b",
      deviceId: "device_b",
      capability: "comfyui.generate",
    }),
    { ok: false, reason: "offline" }
  );
  assert.equal(await gateway.heartbeat("device_b", session.sessionToken), false);
  const expiredHealth = await gateway.getDeviceHealth({
    tenantId: "tenant_b",
    deviceId: "device_b",
  });
  assert.equal(expiredHealth.ok ? expiredHealth.health : null, "offline");
});

test("revocation immediately blocks an established device session", async () => {
  const credential = "agent-credential-c";
  const adapters = createMemoryAdapters([
    {
      id: "device_c",
      tenantId: "tenant_c",
      credentialHash: await sha256Hex(credential),
      capabilities: ["ollama.chat"],
      revokedAt: null,
    },
  ]);
  const gateway = createConnectorGateway({
    ...adapters,
    createId: () => "session_c",
    createToken: () => "session-token-c",
  });
  const session = await gateway.connect("device_c", credential);
  assert.ok(session);
  assert.equal(await gateway.revokeDevice("tenant_other", "device_c"), false);
  assert.equal(await gateway.revokeDevice("tenant_c", "device_c"), true);
  assert.equal(await gateway.connect("device_c", credential), null);
  assert.equal(await gateway.heartbeat("device_c", session.sessionToken), false);
  assert.deepEqual(
    await gateway.authorizeCapability({
      tenantId: "tenant_c",
      deviceId: "device_c",
      capability: "ollama.chat",
    }),
    { ok: false, reason: "revoked" }
  );
});

test("connect racing with credential rotation revokes the session it just created", async () => {
  const credential = "agent-credential-race";
  const adapters = createMemoryAdapters([
    {
      id: "device_race",
      tenantId: "tenant_race",
      credentialHash: await sha256Hex(credential),
      capabilities: ["ollama.chat"],
      revokedAt: null,
    },
  ]);
  const originalGetDevice = adapters.directory.getDevice.bind(adapters.directory);
  let reads = 0;
  adapters.directory.getDevice = async (deviceId) => {
    reads += 1;
    const device = await originalGetDevice(deviceId);
    if (reads < 2 || !device) return device;
    return { ...device, credentialHash: await sha256Hex("rotated-credential") };
  };
  const gateway = createConnectorGateway({
    ...adapters,
    createId: () => "session_race",
    createToken: () => "session-token-race",
  });

  assert.equal(await gateway.connect("device_race", credential), null);
  assert.equal(adapters.sessions.get("device_race")?.revokedAt !== null, true);
});

test("stale connect cleanup does not revoke a newer concurrent device session", async () => {
  const credential = "agent-credential-race";
  const adapters = createMemoryAdapters([
    {
      id: "device_race",
      tenantId: "tenant_race",
      credentialHash: await sha256Hex(credential),
      capabilities: ["ollama.chat"],
      revokedAt: null,
    },
  ]);
  const originalGetDevice = adapters.directory.getDevice.bind(adapters.directory);
  let reads = 0;
  adapters.directory.getDevice = async (deviceId) => {
    reads += 1;
    const device = await originalGetDevice(deviceId);
    if (reads === 2 && device) {
      await adapters.coordinator.putSession({
        sessionId: "session_newer",
        deviceId,
        tenantId: device.tenantId,
        tokenHash: await sha256Hex("newer-token"),
        connectedAt: "2026-10-08T12:00:01.000Z",
        lastSeenAt: "2026-10-08T12:00:01.000Z",
        leaseExpiresAt: "2026-10-08T12:01:01.000Z",
        revokedAt: null,
      });
      return { ...device, credentialHash: await sha256Hex("rotated-credential") };
    }
    return device;
  };
  const gateway = createConnectorGateway({
    ...adapters,
    createId: () => "session_stale",
    createToken: () => "session-token-stale",
  });

  assert.equal(await gateway.connect("device_race", credential), null);
  assert.equal(adapters.sessions.get("device_race")?.sessionId, "session_newer");
  assert.equal(adapters.sessions.get("device_race")?.revokedAt, null);
});

test("invalid lease bounds are rejected before creating gateway sessions", () => {
  const adapters = createMemoryAdapters([]);
  assert.throws(() => createConnectorGateway({ ...adapters, leaseMs: 1 }), /lease/);
});

test("tenant-authorized device requests complete through the authenticated device session", async () => {
  const credential = "agent-request-credential";
  const adapters = createMemoryAdapters([
    {
      id: "device_req",
      tenantId: "tenant_req",
      credentialHash: await sha256Hex(credential),
      capabilities: ["ollama.chat"],
      revokedAt: null,
    },
  ]);
  const sessionId = "session_req";
  const now = 1_800_000_000_000;
  const gateway = createConnectorGateway({
    ...adapters,
    now: () => now,
    createId: () => sessionId,
    createToken: () => "session-token-request",
    createRequestId: () => "request_1",
    wait: async () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  const session = await gateway.connect("device_req", credential);
  assert.ok(session);
  const pending = gateway.requestCapability({
    tenantId: "tenant_req",
    deviceId: "device_req",
    capability: "ollama.chat",
    payload: { prompt: "hello" },
  });
  for (
    let attempt = 0;
    attempt < 10 && !adapters.requests.get("device_req")?.length;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const deliveries = await gateway.pollDeviceRequests({
    deviceId: "device_req",
    sessionToken: session.sessionToken,
  });
  assert.deepEqual(deliveries, [
    {
      requestId: "request_1",
      capability: "ollama.chat",
      payload: { prompt: "hello" },
      expiresAt: new Date(now + 15_000).toISOString(),
    },
  ]);
  await assert.rejects(
    gateway.submitDeviceResult({
      deviceId: "device_req",
      sessionToken: session.sessionToken,
      requestId: "request_1",
      result: "x".repeat(65_537),
    }),
    /size limit/
  );
  assert.equal(
    await gateway.submitDeviceResult({
      deviceId: "device_req",
      sessionToken: session.sessionToken,
      requestId: "request_1",
      result: { text: "hello" },
    }),
    true
  );
  assert.deepEqual(await pending, { ok: true, requestId: "request_1", result: { text: "hello" } });
  assert.equal(adapters.requests.get("device_req")?.length, 0);
});

test("cross-tenant calls, revoked sessions, and expired calls cannot receive results", async () => {
  const credential = "agent-request-credential-b";
  let now = 1_800_000_000_000;
  const adapters = createMemoryAdapters([
    {
      id: "device_req_b",
      tenantId: "tenant_req_b",
      credentialHash: await sha256Hex(credential),
      capabilities: ["ollama.chat"],
      revokedAt: null,
    },
  ]);
  let advanceClock = true;
  const gateway = createConnectorGateway({
    ...adapters,
    now: () => now,
    createId: () => "session_req_b",
    createToken: () => "session-token-request-b",
    createRequestId: () => "request_2",
    wait: async (milliseconds) => {
      if (advanceClock) now += milliseconds;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });
  const session = await gateway.connect("device_req_b", credential);
  assert.ok(session);
  assert.deepEqual(
    await gateway.requestCapability({
      tenantId: "tenant_wrong",
      deviceId: "device_req_b",
      capability: "ollama.chat",
      payload: {},
    }),
    { ok: false, reason: "tenant_mismatch" }
  );
  assert.equal(
    await gateway.pollDeviceRequests({
      deviceId: "device_req_b",
      sessionToken: "wrong-session-token",
    }),
    null
  );
  await assert.rejects(
    gateway.requestCapability({
      tenantId: "tenant_req_b",
      deviceId: "device_req_b",
      capability: "ollama.chat",
      payload: "x".repeat(65_537),
    }),
    /size limit/
  );

  const timedOut = await gateway.requestCapability({
    tenantId: "tenant_req_b",
    deviceId: "device_req_b",
    capability: "ollama.chat",
    payload: {},
    timeoutMs: 100,
  });
  assert.deepEqual(timedOut, { ok: false, reason: "timeout" });

  advanceClock = false;
  const pending = gateway.requestCapability({
    tenantId: "tenant_req_b",
    deviceId: "device_req_b",
    capability: "ollama.chat",
    payload: {},
    timeoutMs: 500,
  });
  for (
    let attempt = 0;
    attempt < 10 && (adapters.requests.get("device_req_b")?.length ?? 0) === 0;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(await gateway.revokeDevice("tenant_req_b", "device_req_b"), true);
  assert.deepEqual(await pending, { ok: false, reason: "revoked" });
  assert.equal(
    await gateway.submitDeviceResult({
      deviceId: "device_req_b",
      sessionToken: session.sessionToken,
      requestId: "request_2",
      result: {},
    }),
    false
  );
});

test("stream producer returns cleanly when its request disappears during backpressure", async () => {
  const credential = "stream-expiry-agent-credential";
  let now = 1_800_000_000_000;
  let requestRemoved = false;
  const adapters = createMemoryAdapters([
    {
      id: "device_stream_expiry",
      tenantId: "tenant_stream_expiry",
      credentialHash: await sha256Hex(credential),
      capabilities: ["ollama:chat:test-model"],
      revokedAt: null,
    },
  ]);
  const getRequest = adapters.coordinator.getRequest.bind(adapters.coordinator);
  adapters.coordinator.getRequest = async (...args) =>
    requestRemoved ? null : getRequest(...args);
  adapters.coordinator.submitStreamEvent = async () => {
    requestRemoved = true;
    return false;
  };
  const gateway = createConnectorGateway({
    ...adapters,
    now: () => now,
    createId: () => "session_stream_expiry",
    createToken: () => "session-token-stream-expiry",
    createRequestId: () => "stream_request_expiry",
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });
  const session = await gateway.connect("device_stream_expiry", credential);
  assert.ok(session);
  const started = await gateway.startCapabilityStream({
    tenantId: "tenant_stream_expiry",
    deviceId: "device_stream_expiry",
    capability: "ollama:chat:test-model",
    payload: { messages: [] },
    stream: true,
    timeoutMs: 100,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  assert.equal(
    await gateway.submitDeviceStreamEvent({
      deviceId: "device_stream_expiry",
      sessionToken: session.sessionToken,
      requestId: started.requestId,
      sequence: 0,
      event: { type: "delta", data: { content: "late" } },
    }),
    false
  );
});

test("request deadline remains authoritative when result storage is slow", async () => {
  const credential = "slow-result-credential";
  const adapters = createMemoryAdapters([
    {
      id: "device_slow",
      tenantId: "tenant_slow",
      credentialHash: await sha256Hex(credential),
      capabilities: ["ollama.chat"],
      revokedAt: null,
    },
  ]);
  const getRequest = adapters.coordinator.getRequest.bind(adapters.coordinator);
  adapters.coordinator.getRequest = async (deviceId, requestId, timestamp) => {
    await new Promise((resolve) => setTimeout(resolve, 130));
    const row = await getRequest(deviceId, requestId, timestamp);
    return row ? { ...row, status: "complete", result: JSON.stringify({ text: "late" }) } : null;
  };
  const gateway = createConnectorGateway({
    ...adapters,
    createId: () => "session_slow",
    createToken: () => "session-token-slow",
    createRequestId: () => "request_slow",
  });
  assert.ok(await gateway.connect("device_slow", credential));
  assert.deepEqual(
    await gateway.requestCapability({
      tenantId: "tenant_slow",
      deviceId: "device_slow",
      capability: "ollama.chat",
      payload: {},
      timeoutMs: 100,
    }),
    { ok: false, reason: "timeout" }
  );
});

test("request deadline remains authoritative when completed-request deletion is slow", async () => {
  const credential = "slow-delete-credential";
  const baseTime = 1_800_000_000_000;
  let currentTime = baseTime;
  const adapters = createMemoryAdapters([
    {
      id: "device_slow_delete",
      tenantId: "tenant_slow_delete",
      credentialHash: await sha256Hex(credential),
      capabilities: ["ollama.chat"],
      revokedAt: null,
    },
  ]);
  const deleteRequest = adapters.coordinator.deleteRequest.bind(adapters.coordinator);
  adapters.coordinator.deleteRequest = async (deviceId, requestId) => {
    await deleteRequest(deviceId, requestId);
    currentTime = baseTime + 101;
  };
  const gateway = createConnectorGateway({
    ...adapters,
    now: () => currentTime,
    createId: () => "session_slow_delete",
    createToken: () => "session-token-slow-delete",
    createRequestId: () => "request_slow_delete",
    wait: async () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  const session = await gateway.connect("device_slow_delete", credential);
  assert.ok(session);
  const pending = gateway.requestCapability({
    tenantId: "tenant_slow_delete",
    deviceId: "device_slow_delete",
    capability: "ollama.chat",
    payload: {},
    timeoutMs: 100,
  });
  for (
    let attempt = 0;
    attempt < 10 && !adapters.requests.get("device_slow_delete")?.length;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const deliveries = await gateway.pollDeviceRequests({
    deviceId: "device_slow_delete",
    sessionToken: session.sessionToken,
  });
  assert.equal(deliveries.length, 1);
  assert.equal(
    await gateway.submitDeviceResult({
      deviceId: "device_slow_delete",
      sessionToken: session.sessionToken,
      requestId: "request_slow_delete",
      result: { text: "completed" },
    }),
    true
  );
  assert.deepEqual(await pending, { ok: false, reason: "timeout" });
});

test("a result found during a concurrent device revocation is not returned", async () => {
  const credential = "revocation-race-credential";
  const now = Date.now();
  const adapters = createMemoryAdapters([
    {
      id: "device_race",
      tenantId: "tenant_race",
      credentialHash: await sha256Hex(credential),
      capabilities: ["ollama.chat"],
      revokedAt: null,
    },
  ]);
  let revokeOnCompletedRead = false;
  const getRequest = adapters.coordinator.getRequest.bind(adapters.coordinator);
  adapters.coordinator.getRequest = async (deviceId, requestId, timestamp) => {
    const row = await getRequest(deviceId, requestId, timestamp);
    if (revokeOnCompletedRead && row?.status === "complete") {
      revokeOnCompletedRead = false;
      const device = adapters.devices.get(deviceId);
      if (device) device.revokedAt = new Date(now).toISOString();
    }
    return row;
  };
  const gateway = createConnectorGateway({
    ...adapters,
    now: () => now,
    createId: () => "session_race",
    createToken: () => "session-token-race",
    createRequestId: () => "request_race",
    wait: async () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  const session = await gateway.connect("device_race", credential);
  assert.ok(session);
  const input = {
    tenantId: "tenant_race",
    deviceId: "device_race",
    capability: "ollama.chat",
    payload: { prompt: "hello" },
    timeoutMs: 2_000,
    requestId: "stable_request_race",
  };
  const firstRequest = gateway.requestCapability(input);
  for (
    let attempt = 0;
    attempt < 20 && !adapters.requests.get("device_race")?.length;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const delivery = await gateway.pollDeviceRequests({
    deviceId: "device_race",
    sessionToken: session.sessionToken,
  });
  assert.equal(delivery?.length, 1);
  assert.equal(
    await gateway.submitDeviceResult({
      deviceId: "device_race",
      sessionToken: session.sessionToken,
      requestId: "stable_request_race",
      result: { text: "completed" },
    }),
    true
  );
  assert.equal((await firstRequest).ok, true);

  revokeOnCompletedRead = true;
  assert.deepEqual(await gateway.requestCapability(input), { ok: false, reason: "revoked" });
});
