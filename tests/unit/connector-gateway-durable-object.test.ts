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
import type {
  GatewayDeviceRequest,
  GatewaySessionRecord,
} from "../../src/cloud/connectorGateway.js";

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
      request.createdAt
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
        createdAt
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
        createdAt
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
        createdAt
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
