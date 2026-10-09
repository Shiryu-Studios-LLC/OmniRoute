import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runLocalAgentGatewayCycle,
  type LocalAgentRunnerConfig,
} from "../../src/lib/localAgent/runner";
import type {
  LocalAgentGatewayRequest,
  LocalAgentGatewayResult,
  LocalAgentGatewaySession,
} from "../../src/lib/localAgent/gatewayProtocol";
import { createConnectorGatewayTransport } from "../../src/lib/localAgent/gatewayProtocol";

const config: LocalAgentRunnerConfig = {
  gatewayUrl: "https://gateway.example.test",
  deviceId: "device-123",
  credential: "a".repeat(43),
  ollamaUrl: "http://127.0.0.1:11434",
};

const session: LocalAgentGatewaySession = {
  sessionId: "session-123",
  deviceId: config.deviceId,
  tenantId: "tenant-test",
  sessionToken: "session-token",
  leaseExpiresAt: "2027-01-01T00:00:00.000Z",
};

test("gateway cycle heartbeats, connects, polls, executes, and submits a versioned result", async () => {
  const events: string[] = [];
  let submitted: LocalAgentGatewayResult | null = null;
  const request: Omit<LocalAgentGatewayRequest, "version"> = {
    requestId: "request-123",
    capability: "ollama:chat:local",
    payload: { messages: [{ role: "user", content: "hello" }] },
    expiresAt: "2026-10-08T12:01:00.000Z",
  };
  const result = await runLocalAgentGatewayCycle(
    config,
    {
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      createNonce: () => "heartbeat-nonce-0001",
      discover: async () => ({
        heartbeat: { status: "online", capabilities: ["ollama:chat:local"] },
        services: [{ service: "ollama", reachable: true, models: ["local"] }],
      }),
      fetch: async (input) => {
        events.push(`heartbeat:${String(input)}`);
        return Response.json({ accepted: true });
      },
      gateway: {
        connect: async (deviceId, credential) => {
          events.push(`connect:${deviceId}:${credential.length}`);
          return session;
        },
        heartbeat: async () => {
          events.push("lease");
          return true;
        },
        poll: async () => {
          events.push("poll");
          return [request];
        },
        submitResult: async (_activeSession, gatewayResult) => {
          events.push("result");
          submitted = gatewayResult;
          return true;
        },
      },
      execute: async (gatewayRequest) => {
        assert.equal(gatewayRequest.version, 1);
        return { answer: "hello" };
      },
    },
    session
  );

  assert.equal(result.session, session);
  assert.equal(result.processed, 1);
  assert.deepEqual(
    events.map((event) => event.split(":")[0]),
    ["lease", "poll", "result"]
  );
  assert.deepEqual(submitted, {
    version: 1,
    requestId: "request-123",
    outcome: { ok: true, value: { answer: "hello" } },
  });
});

test("gateway cycle connects when there is no reusable session and returns a bounded failure result", async () => {
  let connected = 0;
  let submitted: LocalAgentGatewayResult | null = null;
  const cycle = await runLocalAgentGatewayCycle(config, {
    now: () => Date.parse("2026-10-08T12:00:00.000Z"),
    createNonce: () => "heartbeat-nonce-0002",
    discover: async () => ({
      heartbeat: { status: "online", capabilities: [] },
      services: [],
    }),
    fetch: async () => Response.json({ accepted: true }),
    gateway: {
      connect: async () => {
        connected += 1;
        return session;
      },
      heartbeat: async () => true,
      poll: async () => [
        {
          requestId: "request-456",
          capability: "unknown:capability",
          payload: {},
          expiresAt: "2026-10-08T12:01:00.000Z",
        },
      ],
      submitResult: async (_activeSession, result) => {
        submitted = result;
        return true;
      },
    },
    execute: async () => {
      throw new Error("Raw local service detail must not cross the gateway");
    },
  });

  assert.equal(connected, 1);
  assert.equal(cycle.session, session);
  assert.equal(cycle.processed, 1);
  assert.deepEqual(submitted, {
    version: 1,
    requestId: "request-456",
    outcome: { ok: false, error: { code: "capability_execution_failed" } },
  });
});

test("gateway cycle ignores malformed and expired envelopes", async () => {
  let submitted = 0;
  let executed = 0;
  const cycle = await runLocalAgentGatewayCycle(
    config,
    {
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      createNonce: () => "heartbeat-nonce-0003",
      discover: async () => ({ heartbeat: { status: "online", capabilities: [] }, services: [] }),
      fetch: async () => Response.json({ accepted: true }),
      gateway: {
        connect: async () => session,
        heartbeat: async () => true,
        poll: async () => [
          { requestId: "expired", capability: "x", payload: {}, expiresAt: "2026-10-08T11:59:00Z" },
          { requestId: "bad id", capability: "x", payload: {}, expiresAt: "2026-10-08T12:01:00Z" },
        ],
        submitResult: async () => {
          submitted += 1;
          return true;
        },
      },
      execute: async () => {
        executed += 1;
        return {};
      },
    },
    session
  );
  assert.equal(cycle.processed, 0);
  assert.equal(executed, 0);
  assert.equal(submitted, 0);
});

test("versioned transport maps directly onto the connector gateway primitives", async () => {
  const calls: unknown[][] = [];
  const transport = createConnectorGatewayTransport({
    connect: async (deviceId, credential) => {
      calls.push(["connect", deviceId, credential]);
      return session;
    },
    heartbeat: async (deviceId, sessionToken, capabilities) => {
      calls.push(["heartbeat", deviceId, sessionToken, capabilities]);
      return true;
    },
    pollDeviceRequests: async (input) => {
      calls.push(["poll", input]);
      return [
        {
          requestId: "request-789",
          capability: "comfyui:image",
          payload: { workflow: {} },
          expiresAt: "2026-10-08T12:01:00.000Z",
        },
      ];
    },
    submitDeviceResult: async (input) => {
      calls.push(["submit", input]);
      return true;
    },
  });

  assert.equal(await transport.connect(config.deviceId, config.credential), session);
  assert.equal(await transport.heartbeat(session), true);
  const requests = await transport.poll(session);
  assert.deepEqual(requests?.[0], {
    requestId: "request-789",
    capability: "comfyui:image",
    payload: { workflow: {} },
    expiresAt: "2026-10-08T12:01:00.000Z",
  });
  assert.equal(
    await transport.submitResult(session, {
      version: 1,
      requestId: "request-789",
      outcome: { ok: true, value: { accepted: true } },
    }),
    true
  );
  assert.deepEqual(calls, [
    ["connect", config.deviceId, config.credential],
    ["heartbeat", config.deviceId, session.sessionToken, undefined],
    ["poll", { deviceId: config.deviceId, sessionToken: session.sessionToken, limit: 1 }],
    [
      "submit",
      {
        deviceId: config.deviceId,
        sessionToken: session.sessionToken,
        requestId: "request-789",
        result: { version: 1, outcome: { ok: true, value: { accepted: true } } },
      },
    ],
  ]);
});

test("streaming gateway cycle submits ordered events one at a time and terminates", async () => {
  const submissions: Array<{ sequence: number; event: unknown }> = [];
  const request: Omit<LocalAgentGatewayRequest, "version"> = {
    requestId: "stream-123",
    capability: "ollama:chat:local",
    payload: { messages: [{ role: "user", content: "hello" }] },
    expiresAt: "2026-10-08T12:01:00.000Z",
    stream: true,
  };
  const cycle = await runLocalAgentGatewayCycle(
    config,
    {
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      discover: async () => ({
        heartbeat: { status: "online", capabilities: ["ollama:chat:local"] },
        services: [],
      }),
      fetch: async () => Response.json({ accepted: true }),
      gateway: {
        connect: async () => session,
        heartbeat: async () => true,
        poll: async () => [request],
        submitResult: async () => false,
        submitStreamEvent: async (_session, _requestId, sequence, event) => {
          submissions.push({ sequence, event });
          return true;
        },
      },
      executeStream: async (_request, _discovery, signal, emit) => {
        assert.equal(signal.aborted, false);
        await emit({ type: "delta", data: { content: "hi" } });
        await emit({ type: "usage", data: { promptTokens: 3, completionTokens: 1 } });
      },
    },
    session
  );
  assert.equal(cycle.processed, 1);
  assert.deepEqual(submissions, [
    { sequence: 0, event: { type: "delta", data: { content: "hi" } } },
    { sequence: 1, event: { type: "usage", data: { promptTokens: 3, completionTokens: 1 } } },
    { sequence: 2, event: { type: "done", data: {} } },
  ]);
});

test("runner shutdown cancels a stream while device event acknowledgment is pending", async () => {
  const controller = new AbortController();
  let canceled = 0;
  const cyclePromise = runLocalAgentGatewayCycle(
    config,
    {
      abortSignal: controller.signal,
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      discover: async () => ({
        heartbeat: { status: "online", capabilities: ["ollama:chat:local"] },
        services: [],
      }),
      fetch: async () => Response.json({ accepted: true }),
      gateway: {
        connect: async () => session,
        heartbeat: async () => true,
        poll: async () => [
          {
            requestId: "stream-cancel",
            capability: "ollama:chat:local",
            payload: {},
            expiresAt: "2026-10-08T12:01:00.000Z",
            stream: true,
          },
        ],
        submitResult: async () => false,
        submitStreamEvent: async () => new Promise<boolean>(() => undefined),
        cancelStream: async () => {
          canceled += 1;
          return true;
        },
      },
      executeStream: async (_request, _discovery, signal, emit) => {
        setTimeout(() => controller.abort(), 5);
        await emit({ type: "delta", data: { content: "waiting" } });
        assert.equal(signal.aborted, true);
      },
    },
    session
  );
  const cycle = await Promise.race([
    cyclePromise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("cycle hung")), 250)
    ),
  ]);
  assert.equal(cycle.processed, 1);
  assert.equal(canceled, 1);
});
