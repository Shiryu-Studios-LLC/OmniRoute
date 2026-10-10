import assert from "node:assert/strict";
import test from "node:test";
import type {
  GatewayDurableObjectNamespace,
  GatewayDurableStorage,
  GatewayDurableStorageTransaction,
} from "../../src/cloud/connectorGatewayDurableObject.js";
import {
  DurableObjectGatewayCoordinator,
  GatewaySessionDurableObject,
} from "../../src/cloud/connectorGatewayDurableObject.js";
import { createConnectorGateway } from "../../src/cloud/connectorGateway.js";
import { runLocalAgentGatewayCycle } from "../../src/lib/localAgent/runner.js";
import type { LocalDiscoveryResult } from "../../src/lib/localAgent/localDiscovery.js";
import type {
  GatewayDeviceRequest,
  GatewaySessionRecord,
} from "../../src/cloud/connectorGateway.js";
import type { LocalAgentGatewayResult } from "../../src/lib/localAgent/gatewayProtocol.js";

class MemoryStorage implements GatewayDurableStorage {
  private values = new Map<string, unknown>();
  private tail: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async transaction<T>(callback: (transaction: GatewayDurableStorageTransaction) => Promise<T>) {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    const working = new Map(this.values);
    const transaction: GatewayDurableStorageTransaction = {
      get: async <Value>(key: string) => working.get(key) as Value | undefined,
      put: async <Value>(key: string, value: Value) => {
        working.set(key, value);
      },
      delete: async (key: string) => working.delete(key),
    };
    try {
      const result = await callback(transaction);
      this.values = working;
      return result;
    } finally {
      release();
    }
  }
}

function session(deviceId = "device_A", sessionId = "session_A"): GatewaySessionRecord {
  return {
    sessionId,
    deviceId,
    tenantId: "tenant_A",
    tokenHash: "a".repeat(64),
    connectedAt: "2026-10-08T12:00:00.000Z",
    lastSeenAt: "2026-10-08T12:00:00.000Z",
    leaseExpiresAt: "2026-10-08T12:01:00.000Z",
    revokedAt: null,
  };
}

function makeNamespace() {
  const objects = new Map<string, GatewaySessionDurableObject>();
  const namespace: GatewayDurableObjectNamespace<GatewaySessionDurableObject> = {
    idFromName: (name) => name,
    get: (id) => {
      const key = String(id);
      let object = objects.get(key);
      if (!object) {
        object = new GatewaySessionDurableObject({
          id: { name: key },
          storage: new MemoryStorage(),
        });
        objects.set(key, object);
      }
      return object;
    },
  };
  return { namespace, objects };
}

test("coordinator persists sessions in a deterministic per-device object", async () => {
  const { namespace, objects } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  const first = session();
  await coordinator.putSession(first);

  assert.deepEqual(await coordinator.getSession("device_A"), first);
  assert.equal(objects.size, 1);

  const secondDeviceSession = session("device_B", "session_B");
  await coordinator.putSession(secondDeviceSession);
  assert.deepEqual(await coordinator.getSession("device_B"), secondDeviceSession);
  assert.equal(objects.size, 2);
  assert.deepEqual(await coordinator.getSession("device_A"), first);
});

test("Durable Object identity cannot be rebound or store a foreign device session", async () => {
  const durableObject = new GatewaySessionDurableObject({
    id: { name: "device_A" },
    storage: new MemoryStorage(),
  });
  await durableObject.putSession("device_A", session());

  await assert.rejects(durableObject.getSession("device_B"), /identity does not match/);
  await assert.rejects(
    durableObject.putSession("device_A", session("device_B", "foreign")),
    /does not match/
  );
  assert.equal((await durableObject.getSession("device_A"))?.sessionId, "session_A");
});

test("touch requires the current session and revoke is durable and blocks later touches", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());

  assert.equal(
    await coordinator.touchSession(
      "device_A",
      "stale_session",
      "2026-10-08T12:00:10.000Z",
      "2026-10-08T12:01:10.000Z"
    ),
    false
  );
  assert.equal(
    await coordinator.touchSession(
      "device_A",
      "session_A",
      "2026-10-08T12:00:10.000Z",
      "2026-10-08T12:01:10.000Z"
    ),
    true
  );
  await coordinator.revokeSession("device_A", "2026-10-08T12:00:20.000Z");

  assert.equal(
    await coordinator.touchSession(
      "device_A",
      "session_A",
      "2026-10-08T12:00:30.000Z",
      "2026-10-08T12:01:30.000Z"
    ),
    false
  );
  assert.equal((await coordinator.getSession("device_A"))?.revokedAt, "2026-10-08T12:00:20.000Z");
});

test("malformed identities, records, and timestamps fail closed", async () => {
  const durableObject = new GatewaySessionDurableObject({
    id: { name: "device_A" },
    storage: new MemoryStorage(),
  });
  await assert.rejects(durableObject.getSession("../device"), /Invalid gateway device identity/);
  await assert.rejects(
    durableObject.putSession("device_A", { ...session(), tokenHash: "plaintext" }),
    /does not match/
  );
  await assert.rejects(
    durableObject.revokeSession("device_A", "not-a-date"),
    /Invalid gateway revocation timestamp/
  );
});

test("Durable Object request queue binds delivery and results to the active tenant session", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());
  const request: GatewayDeviceRequest = {
    requestId: "request_A",
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama.chat",
    payload: JSON.stringify({ prompt: "hello" }),
    createdAt: "2026-10-08T12:00:00.000Z",
    expiresAt: "2026-10-08T12:00:10.000Z",
    status: "pending",
  };
  assert.equal(await coordinator.enqueueRequest("device_A", request), true);
  assert.deepEqual(
    await coordinator.takeRequests("device_A", "wrong_session", request.createdAt),
    []
  );
  const delivered = await coordinator.takeRequests("device_A", "session_A", request.createdAt);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].status, "delivered");
  assert.equal(
    await coordinator.submitRequestResult(
      "device_A",
      "wrong_session",
      "request_A",
      JSON.stringify({ text: "bad" }),
      request.createdAt
    ),
    false
  );
  assert.equal(
    await coordinator.submitRequestResult(
      "device_A",
      "session_A",
      "request_A",
      JSON.stringify({ text: "hello" }),
      request.createdAt,
      1
    ),
    true
  );
  assert.deepEqual(await coordinator.getRequest("device_A", "request_A", request.createdAt), {
    ...request,
    status: "complete",
    result: JSON.stringify({ text: "hello" }),
  });
  assert.equal(
    await coordinator.submitRequestResult(
      "device_A",
      "session_A",
      "request_A",
      "{}",
      "2026-10-08T12:00:11.000Z"
    ),
    false
  );
  const largeRequest = {
    ...request,
    requestId: "request_B",
    expiresAt: "2026-10-08T12:01:00.000Z",
    payload: JSON.stringify({ prompt: "x".repeat(65_537) }),
  };
  assert.equal(await coordinator.enqueueRequest("device_A", largeRequest), false);
});

test("Durable Object redelivers non-stream work after a lost poll response lease", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession({
    ...session(),
    leaseExpiresAt: "2026-10-08T12:10:00.000Z",
  });
  const createdAt = "2026-10-08T12:00:00.000Z";
  const request: GatewayDeviceRequest = {
    requestId: "poll_response_lost",
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama.chat",
    payload: "{}",
    createdAt,
    expiresAt: "2026-10-08T12:10:00.000Z",
    status: "pending",
  };

  assert.equal(await coordinator.enqueueRequest("device_A", request), true);
  const firstDelivery = await coordinator.takeRequests("device_A", "session_A", createdAt);
  assert.equal(firstDelivery.length, 1);
  assert.equal(firstDelivery[0]?.deliveryAttempts, 1);
  assert.equal(firstDelivery[0]?.deliveryLeaseExpiresAt, "2026-10-08T12:00:30.000Z");
  assert.deepEqual(
    await coordinator.takeRequests("device_A", "session_A", "2026-10-08T12:00:29.999Z"),
    [],
    "the queue must not immediately duplicate work while its delivery lease is active"
  );

  const redelivered = await coordinator.takeRequests(
    "device_A",
    "session_A",
    "2026-10-08T12:00:30.000Z"
  );
  assert.equal(redelivered.length, 1);
  assert.equal(redelivered[0]?.requestId, request.requestId);
  assert.equal(redelivered[0]?.deliveryAttempts, 2);
  assert.equal(
    await coordinator.submitRequestResult(
      "device_A",
      "session_A",
      request.requestId,
      JSON.stringify({ text: "stale" }),
      "2026-10-08T12:00:30.001Z",
      1
    ),
    false,
    "an earlier Local Agent execution cannot submit after its lease was superseded"
  );
  assert.equal(
    await coordinator.submitRequestResult(
      "device_A",
      "session_A",
      request.requestId,
      JSON.stringify({ text: "recovered" }),
      "2026-10-08T12:00:31.000Z",
      2
    ),
    true
  );
  assert.deepEqual(await coordinator.getRequest("device_A", request.requestId, createdAt), {
    ...request,
    status: "complete",
    result: JSON.stringify({ text: "recovered" }),
  });
  assert.deepEqual(
    await coordinator.takeRequests("device_A", "session_A", "2026-10-08T12:01:00.000Z"),
    [],
    "a completed result stops further deliveries"
  );
});

test("exhausted non-stream delivery becomes terminal instead of remaining delivered", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession({
    ...session(),
    leaseExpiresAt: "2026-10-08T12:10:00.000Z",
  });
  const request: GatewayDeviceRequest = {
    requestId: "delivery_attempt_limit",
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama.chat",
    payload: "{}",
    createdAt: "2026-10-08T12:00:00.000Z",
    expiresAt: "2026-10-08T12:10:00.000Z",
    status: "pending",
  };
  assert.equal(await coordinator.enqueueRequest("device_A", request), true);
  for (const at of [0, 30_000, 60_000]) {
    const deliveries = await coordinator.takeRequests(
      "device_A",
      "session_A",
      new Date(Date.parse(request.createdAt) + at).toISOString()
    );
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.deliveryAttempts, Math.floor(at / 30_000) + 1);
  }

  const terminal = await coordinator.getRequest(
    "device_A",
    request.requestId,
    "2026-10-08T12:01:30.000Z"
  );
  assert.deepEqual(
    terminal,
    { ...request, status: "failed", deliveryFailure: "delivery_attempts_exhausted" },
    "a result poll exposes and persists the terminal recovery reason without another device poll"
  );
  assert.deepEqual(
    await coordinator.takeRequests("device_A", "session_A", "2026-10-08T12:01:30.000Z"),
    [],
    "attempt exhaustion must stop re-delivery"
  );
  assert.equal(
    await coordinator.submitRequestResult(
      "device_A",
      "session_A",
      request.requestId,
      "{}",
      "2026-10-08T12:01:31.000Z",
      3
    ),
    false,
    "late work cannot overwrite the terminal attempt limit"
  );
});

test("retry recovers one lost poll delivery without enqueueing a duplicate request", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  const credential = "integration_device_credential_1234567890";
  const credentialDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(credential)
  );
  const device = {
    id: "device_A",
    tenantId: "tenant_A",
    credentialHash: Array.from(new Uint8Array(credentialDigest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join(""),
    capabilities: ["ollama.chat"],
    revokedAt: null,
  };
  const directory = {
    async getDevice(deviceId: string) {
      return deviceId === device.id ? device : null;
    },
    async revokeDevice() {
      return false;
    },
  };
  let now = Date.parse("2026-10-08T12:00:00.000Z");
  const gateway = createConnectorGateway({
    coordinator,
    directory,
    now: () => now,
    createId: () => "session_A",
    createToken: () => "device-session-token",
    createRequestId: () => "stable_request_A",
    wait: async () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  const session = await gateway.connect(device.id, credential);
  assert.ok(session);

  let enqueueCalls = 0;
  const enqueue = coordinator.enqueueRequest.bind(coordinator);
  coordinator.enqueueRequest = async (...args) => {
    enqueueCalls += 1;
    return enqueue(...args);
  };
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 15 * 60_000).toISOString();
  const request: GatewayDeviceRequest = {
    requestId: "stable_request_A",
    tenantId: device.tenantId,
    sessionId: session.sessionId,
    capability: "ollama.chat",
    payload: JSON.stringify({ prompt: "hello" }),
    createdAt,
    expiresAt,
    status: "pending",
  };
  assert.equal(await coordinator.enqueueRequest(device.id, request), true);
  const lostPollResponse = await gateway.pollDeviceRequests({
    deviceId: device.id,
    sessionToken: session.sessionToken,
  });
  assert.equal(lostPollResponse?.[0]?.requestId, request.requestId);
  assert.equal(enqueueCalls, 1);

  // The client retries with the same idempotency identity after the bounded
  // delivery lease expires. The gateway resumes the retained row.
  now += 30_000;
  const localAgentTransport = {
    connect: gateway.connect,
    heartbeat: (currentSession: typeof session, capabilities?: string[]) =>
      gateway.heartbeat(currentSession.deviceId, currentSession.sessionToken, capabilities),
    poll: async (currentSession: typeof session) => {
      const requests = await gateway.pollDeviceRequests({
        deviceId: currentSession.deviceId,
        sessionToken: currentSession.sessionToken,
      });
      assert.equal(requests?.length, 1, "runner should recover the expired non-stream delivery");
      return requests;
    },
    submitResult: (currentSession: typeof session, result: LocalAgentGatewayResult) =>
      gateway.submitDeviceResult({
        deviceId: currentSession.deviceId,
        sessionToken: currentSession.sessionToken,
        requestId: result.requestId,
        deliveryAttempt: result.deliveryAttempt,
        result: { version: result.version, outcome: result.outcome },
      }),
  };
  const discovery: LocalDiscoveryResult = {
    heartbeat: {
      status: "online",
      capabilities: ["ollama.chat"],
      serviceHealth: { ollama: true, comfyui: false },
    },
    services: [
      { service: "ollama", reachable: true, models: [] },
      { service: "comfyui", reachable: false, models: [] },
    ],
  };
  let localExecutions = 0;
  const cycle = await runLocalAgentGatewayCycle(
    { gatewayUrl: "http://127.0.0.1:8787", deviceId: device.id, credential },
    {
      fetch,
      now: () => now,
      gateway: localAgentTransport,
      execute: async (receivedRequest) => {
        assert.equal(receivedRequest.requestId, request.requestId);
        localExecutions += 1;
        return { text: "hello" };
      },
    },
    session,
    discovery
  );
  assert.equal(cycle.processed, 1);
  assert.equal(enqueueCalls, 1, "retry must reuse the durable request instead of enqueuing again");
  assert.equal(localExecutions, 1);
  assert.deepEqual(
    await gateway.requestCapability({
      tenantId: device.tenantId,
      deviceId: device.id,
      capability: request.capability,
      payload: { prompt: "hello" },
      timeoutMs: 30_000,
      requestId: request.requestId,
      requestCreatedAt: createdAt,
      requestExpiresAt: expiresAt,
    }),
    {
      ok: true,
      requestId: request.requestId,
      result: {
        version: 1,
        outcome: { ok: true, value: { text: "hello" } },
      },
    }
  );
  assert.deepEqual(
    await gateway.pollDeviceRequests({ deviceId: device.id, sessionToken: session.sessionToken }),
    [],
    "a completed request is no longer eligible for delivery"
  );
});

test("Durable Object rejects requests whose deadline is not after creation", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());
  const request: GatewayDeviceRequest = {
    requestId: "expired_at_creation",
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama.chat",
    payload: "{}",
    createdAt: "2026-10-08T12:00:00.000Z",
    expiresAt: "2026-10-08T12:00:00.000Z",
    status: "pending",
  };

  assert.equal(await coordinator.enqueueRequest("device_A", request), false);
  assert.equal(
    await coordinator.getRequest("device_A", request.requestId, request.createdAt),
    null,
    "invalid work must not be retained as a dead queue row"
  );
  assert.equal(
    await coordinator.enqueueRequest("device_A", {
      ...request,
      requestId: "valid_deadline",
      expiresAt: "2026-10-08T12:00:01.000Z",
    }),
    true,
    "rejecting an invalid deadline must leave queue capacity available"
  );
});

test("invalid protocol timestamps cannot purge queued work or complete a request", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());
  const request: GatewayDeviceRequest = {
    requestId: "invalid_clock_request",
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama.chat",
    payload: "{}",
    createdAt: "2026-10-08T12:00:00.000Z",
    expiresAt: "2026-10-08T12:00:30.000Z",
    status: "pending",
  };
  assert.equal(await coordinator.enqueueRequest("device_A", request), true);

  assert.equal(
    await coordinator.getRequest("device_A", request.requestId, "invalid-clock"),
    null,
    "an invalid clock must not be treated as a valid queue expiry comparison"
  );
  assert.deepEqual(
    await coordinator.getRequest("device_A", request.requestId, request.createdAt),
    request,
    "invalid expiry input must not delete retained work"
  );

  assert.equal(
    (await coordinator.takeRequests("device_A", "session_A", request.createdAt)).length,
    1
  );
  assert.equal(
    await coordinator.submitRequestResult(
      "device_A",
      "session_A",
      request.requestId,
      "{}",
      "invalid-clock",
      1
    ),
    false,
    "an invalid clock must not bypass session or request expiry checks"
  );
  assert.equal(
    (await coordinator.getRequest("device_A", request.requestId, request.createdAt))?.status,
    "delivered",
    "rejecting invalid time must leave the request available for a valid response"
  );
});

test("Durable Object stream queue allows one ordered event and acknowledges only on consume", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());
  const request: GatewayDeviceRequest = {
    requestId: "stream_request_1",
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama:chat:qwen-local",
    payload: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    createdAt: "2026-10-08T12:00:00.000Z",
    expiresAt: "2026-10-08T12:00:30.000Z",
    status: "pending",
    stream: true,
    streamNextSequence: 0,
    streamAcknowledgedSequence: -1,
    streamEventCount: 0,
    streamTotalEventBytes: 0,
  };
  assert.equal(await coordinator.enqueueRequest("device_A", request), true);
  assert.equal(
    (await coordinator.takeRequests("device_A", "session_A", request.createdAt))[0]?.stream,
    true
  );
  assert.deepEqual(
    await coordinator.takeRequests("device_A", "session_A", "2026-10-08T12:00:15.000Z"),
    [],
    "stream work is never redelivered after a possible partial execution"
  );

  const delta = JSON.stringify({ type: "delta", data: { content: "hello" } });
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      0,
      delta,
      request.createdAt
    ),
    true
  );
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      1,
      delta,
      request.createdAt
    ),
    false,
    "the producer cannot queue a second event before the consumer takes the first"
  );
  const consumed = await coordinator.peekStreamEvent!(
    "device_A",
    "session_A",
    request.requestId,
    0,
    request.createdAt
  );
  assert.deepEqual(consumed, { sequence: 0, type: "delta", data: { content: "hello" } });
  assert.equal(
    (await coordinator.getRequest("device_A", request.requestId, request.createdAt))
      ?.streamAcknowledgedSequence,
    -1,
    "reading a pending event does not acknowledge it"
  );
  assert.equal(
    await coordinator.acknowledgeStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      0,
      request.createdAt
    ),
    true
  );
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      0,
      delta,
      request.createdAt
    ),
    true,
    "retrying an acknowledged sequence is idempotent"
  );
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      2,
      delta,
      request.createdAt
    ),
    false
  );

  const done = JSON.stringify({ type: "done", data: {} });
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      1,
      done,
      request.createdAt
    ),
    true
  );
  assert.deepEqual(
    await coordinator.peekStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      1,
      request.createdAt
    ),
    { sequence: 1, type: "done", data: {} }
  );
  assert.equal(
    await coordinator.acknowledgeStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      1,
      request.createdAt
    ),
    true
  );
  assert.equal(
    (await coordinator.getRequest("device_A", request.requestId, request.createdAt))?.status,
    "complete"
  );
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      2,
      delta,
      request.createdAt
    ),
    false
  );
});

test("Durable Object stream cancellation clears a pending event and blocks stale session writes", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());
  const request: GatewayDeviceRequest = {
    requestId: "stream_request_cancel",
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama:chat:qwen-local",
    payload: "{}",
    createdAt: "2026-10-08T12:00:00.000Z",
    expiresAt: "2026-10-08T12:00:30.000Z",
    status: "pending",
    stream: true,
    streamNextSequence: 0,
    streamAcknowledgedSequence: -1,
    streamEventCount: 0,
    streamTotalEventBytes: 0,
  };
  await coordinator.enqueueRequest("device_A", request);
  await coordinator.takeRequests("device_A", "session_A", request.createdAt);
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      0,
      JSON.stringify({ type: "delta", data: { content: "pending" } }),
      request.createdAt
    ),
    true
  );
  assert.equal(
    await coordinator.cancelStream!("device_A", "session_A", request.requestId, request.createdAt),
    true
  );
  assert.equal(
    await coordinator.peekStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      0,
      request.createdAt
    ),
    null
  );
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      0,
      JSON.stringify({ type: "delta", data: { content: "late" } }),
      request.createdAt
    ),
    false
  );
  assert.equal(
    await coordinator.cancelStream!(
      "device_A",
      "stale_session",
      request.requestId,
      request.createdAt
    ),
    false
  );
});

test("Durable Object cancels streams that exceed aggregate bytes or event count", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());
  const makeStreamRequest = (requestId: string): GatewayDeviceRequest => ({
    requestId,
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama:chat:qwen-local",
    payload: "{}",
    createdAt: "2026-10-08T12:00:00.000Z",
    expiresAt: "2026-10-08T12:00:30.000Z",
    status: "pending",
    stream: true,
    streamNextSequence: 0,
    streamAcknowledgedSequence: -1,
    streamEventCount: 0,
    streamTotalEventBytes: 0,
  });
  const bytesRequest = makeStreamRequest("stream_bytes_cap");
  await coordinator.enqueueRequest("device_A", bytesRequest);
  await coordinator.takeRequests("device_A", "session_A", bytesRequest.createdAt);
  const largeEvent = JSON.stringify({ type: "delta", data: { content: "x".repeat(7_900) } });
  const exactEventBytes = new TextEncoder().encode(largeEvent).byteLength;
  assert.ok(exactEventBytes <= 8 * 1024);
  for (let sequence = 0; sequence < 16; sequence += 1) {
    assert.equal(
      await coordinator.submitStreamEvent!(
        "device_A",
        "session_A",
        bytesRequest.requestId,
        sequence,
        largeEvent,
        bytesRequest.createdAt
      ),
      true
    );
    assert.equal(
      await coordinator.acknowledgeStreamEvent!(
        "device_A",
        "session_A",
        bytesRequest.requestId,
        sequence,
        bytesRequest.createdAt
      ),
      true
    );
  }
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      bytesRequest.requestId,
      16,
      largeEvent,
      bytesRequest.createdAt
    ),
    false,
    "aggregate output bytes above 128 KiB cancel the stream"
  );
  const bytesState = await coordinator.getRequest(
    "device_A",
    bytesRequest.requestId,
    bytesRequest.createdAt
  );
  assert.equal(bytesState?.streamCancelled, true);
  assert.equal(bytesState?.streamTotalEventBytes, exactEventBytes * 16);

  const countRequest = makeStreamRequest("stream_events_cap");
  await coordinator.enqueueRequest("device_A", countRequest);
  await coordinator.takeRequests("device_A", "session_A", countRequest.createdAt);
  const smallEvent = JSON.stringify({ type: "delta", data: { content: "x" } });
  for (let sequence = 0; sequence < 256; sequence += 1) {
    assert.equal(
      await coordinator.submitStreamEvent!(
        "device_A",
        "session_A",
        countRequest.requestId,
        sequence,
        smallEvent,
        countRequest.createdAt
      ),
      true
    );
    assert.equal(
      await coordinator.acknowledgeStreamEvent!(
        "device_A",
        "session_A",
        countRequest.requestId,
        sequence,
        countRequest.createdAt
      ),
      true
    );
  }
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      countRequest.requestId,
      256,
      smallEvent,
      countRequest.createdAt
    ),
    false,
    "the 257th output event cancels the stream"
  );
  const countState = await coordinator.getRequest(
    "device_A",
    countRequest.requestId,
    countRequest.createdAt
  );
  assert.equal(countState?.streamCancelled, true);
  assert.equal(countState?.streamEventCount, 256);
});

test("Durable Object accepts only one usage event in the contiguous stream sequence", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());
  const request: GatewayDeviceRequest = {
    requestId: "stream_usage_once",
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama:chat:qwen-local",
    payload: "{}",
    createdAt: "2026-10-08T12:00:00.000Z",
    expiresAt: "2026-10-08T12:00:30.000Z",
    status: "pending",
    stream: true,
    streamNextSequence: 0,
    streamAcknowledgedSequence: -1,
    streamEventCount: 0,
    streamTotalEventBytes: 0,
  };
  await coordinator.enqueueRequest("device_A", request);
  await coordinator.takeRequests("device_A", "session_A", request.createdAt);
  const usage = JSON.stringify({ type: "usage", data: { promptTokens: 2, completionTokens: 3 } });
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      1,
      usage,
      request.createdAt
    ),
    false,
    "out-of-order usage events are rejected"
  );
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      0,
      usage,
      request.createdAt
    ),
    true
  );
  assert.equal(
    await coordinator.acknowledgeStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      0,
      request.createdAt
    ),
    true
  );
  assert.equal(
    await coordinator.submitStreamEvent!(
      "device_A",
      "session_A",
      request.requestId,
      1,
      usage,
      request.createdAt
    ),
    false,
    "a second usage event cancels the compromised stream"
  );
  assert.equal(
    (await coordinator.getRequest("device_A", request.requestId, request.createdAt))
      ?.streamCancelled,
    true
  );
});

test("completed idempotent results do not consume the pending queue capacity", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());
  const createdAt = "2026-10-08T12:00:00.000Z";
  const expiresAt = "2026-10-08T12:10:00.000Z";

  for (let index = 0; index < 16; index += 1) {
    assert.equal(
      await coordinator.enqueueRequest("device_A", {
        requestId: `retained_${index}`,
        tenantId: "tenant_A",
        sessionId: "session_A",
        capability: "ollama.chat",
        payload: "{}",
        createdAt,
        expiresAt,
        status: "pending",
      }),
      true
    );
  }
  assert.equal(
    await coordinator.enqueueRequest("device_A", {
      requestId: "pending_overflow",
      tenantId: "tenant_A",
      sessionId: "session_A",
      capability: "ollama.chat",
      payload: "{}",
      createdAt,
      expiresAt,
      status: "pending",
    }),
    false
  );

  const delivered = await coordinator.takeRequests("device_A", "session_A", createdAt);
  assert.equal(delivered.length, 16);
  for (const request of delivered) {
    assert.equal(
      await coordinator.submitRequestResult(
        "device_A",
        "session_A",
        request.requestId,
        "{}",
        createdAt,
        1
      ),
      true
    );
  }
  assert.equal(
    await coordinator.enqueueRequest("device_A", {
      requestId: "after_completions",
      tenantId: "tenant_A",
      sessionId: "session_A",
      capability: "ollama.chat",
      payload: "{}",
      createdAt,
      expiresAt,
      status: "pending",
    }),
    true
  );
});

test("revocation and session replacement clear undeliverable work", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());
  const request: GatewayDeviceRequest = {
    requestId: "revoked_work",
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama.chat",
    payload: "{}",
    createdAt: "2026-10-08T12:00:00.000Z",
    expiresAt: "2026-10-08T12:10:00.000Z",
    status: "pending",
  };
  assert.equal(await coordinator.enqueueRequest("device_A", request), true);
  await coordinator.revokeSession("device_A", "2026-10-08T12:00:01.000Z");
  assert.equal(
    await coordinator.getRequest("device_A", request.requestId, "2026-10-08T12:00:02.000Z"),
    null
  );

  await coordinator.putSession(session("device_A", "session_B"));
  assert.equal(
    await coordinator.enqueueRequest("device_A", {
      ...request,
      requestId: "new_session_work",
      sessionId: "session_B",
      createdAt: "2026-10-08T12:00:03.000Z",
    }),
    true
  );
});

test("stale connect cleanup leaves a replacement Durable Object session and queue intact", async () => {
  const { namespace } = makeNamespace();
  const coordinator = new DurableObjectGatewayCoordinator(namespace);
  await coordinator.putSession(session());
  await coordinator.putSession(session("device_A", "session_B"));
  const replacementRequest: GatewayDeviceRequest = {
    requestId: "replacement_work",
    tenantId: "tenant_A",
    sessionId: "session_B",
    capability: "ollama.chat",
    payload: "{}",
    createdAt: "2026-10-08T12:00:02.000Z",
    expiresAt: "2026-10-08T12:10:00.000Z",
    status: "pending",
  };
  assert.equal(await coordinator.enqueueRequest("device_A", replacementRequest), true);

  await coordinator.revokeSession("device_A", "2026-10-08T12:00:03.000Z", "session_A");

  assert.equal((await coordinator.getSession("device_A"))?.sessionId, "session_B");
  assert.equal(
    await coordinator.getRequest(
      "device_A",
      replacementRequest.requestId,
      "2026-10-08T12:00:04.000Z"
    ),
    replacementRequest
  );
});

test("completed request retention is bounded by row count and serialized bytes", async () => {
  const storage = new MemoryStorage();
  const durableObject = new GatewaySessionDurableObject({
    id: { name: "device_A" },
    storage,
  });
  await durableObject.putSession("device_A", session());
  const createdAt = "2026-10-08T12:00:00.000Z";
  const expiresAt = "2026-10-08T12:10:00.000Z";

  for (let index = 0; index < 64; index += 1) {
    const row: GatewayDeviceRequest = {
      requestId: `retained_${index}`,
      tenantId: "tenant_A",
      sessionId: "session_A",
      capability: "ollama.chat",
      payload: "{}",
      createdAt,
      expiresAt,
      status: "pending",
    };
    assert.equal(await durableObject.enqueueRequest("device_A", row), true);
    assert.equal((await durableObject.takeRequests("device_A", "session_A", createdAt)).length, 1);
    assert.equal(
      await durableObject.submitRequestResult(
        "device_A",
        "session_A",
        row.requestId,
        "{}",
        createdAt,
        1
      ),
      true
    );
  }
  assert.equal(
    await durableObject.enqueueRequest("device_A", {
      requestId: "retained_overflow",
      tenantId: "tenant_A",
      sessionId: "session_A",
      capability: "ollama.chat",
      payload: "{}",
      createdAt,
      expiresAt,
      status: "pending",
    }),
    false
  );

  // Large completed requests are bounded by the serialized queue budget even
  // before the separate retained-row ceiling is reached.
  const byteStorage = new MemoryStorage();
  const byteLimited = new GatewaySessionDurableObject({
    id: { name: "device_A" },
    storage: byteStorage,
  });
  await byteLimited.putSession("device_A", session());
  let completedLargeRows = 0;
  for (let index = 0; index < 20; index += 1) {
    const row: GatewayDeviceRequest = {
      requestId: `large_${index}`,
      tenantId: "tenant_A",
      sessionId: "session_A",
      capability: "ollama.chat",
      payload: "x".repeat(64 * 1024),
      createdAt,
      expiresAt,
      status: "pending",
    };
    if (!(await byteLimited.enqueueRequest("device_A", row))) break;
    await byteLimited.takeRequests("device_A", "session_A", createdAt);
    if (
      !(await byteLimited.submitRequestResult(
        "device_A",
        "session_A",
        row.requestId,
        "x".repeat(64 * 1024),
        createdAt,
        1
      ))
    ) {
      break;
    }
    completedLargeRows += 1;
  }
  const persisted = (await byteStorage.get<GatewayDeviceRequest[]>("gateway:requests")) ?? [];
  assert.ok(completedLargeRows > 0);
  assert.ok(new TextEncoder().encode(JSON.stringify(persisted)).byteLength <= 1_500_000);

  const legacyStorage = new MemoryStorage();
  const recoveringObject = new GatewaySessionDurableObject({
    id: { name: "device_A" },
    storage: legacyStorage,
  });
  await recoveringObject.putSession("device_A", session());
  const legacyRows: GatewayDeviceRequest[] = Array.from({ length: 70 }, (_, index) => ({
    requestId: `legacy_${index}`,
    tenantId: "tenant_A",
    sessionId: "session_A",
    capability: "ollama.chat",
    payload: "{}",
    createdAt: new Date(Date.parse(createdAt) + index).toISOString(),
    expiresAt,
    status: "complete",
    result: "{}",
  }));
  await legacyStorage.transaction(async (transaction) => {
    await transaction.put("gateway:requests", legacyRows);
  });
  assert.equal(
    (await recoveringObject.getRequest("device_A", "legacy_69", createdAt))?.requestId,
    "legacy_69"
  );
  const recoveredRows = (await legacyStorage.get<GatewayDeviceRequest[]>("gateway:requests")) ?? [];
  assert.ok(recoveredRows.length <= 64);
  assert.ok(new TextEncoder().encode(JSON.stringify(recoveredRows)).byteLength <= 1_500_000);
});
