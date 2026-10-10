import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runLocalAgentGatewayCycle,
  runLocalAgentWithGateway,
  type LocalAgentRunnerConfig,
} from "../../src/lib/localAgent/runner";
import type {
  LocalAgentGatewayRequest,
  LocalAgentGatewayResult,
  LocalAgentGatewaySession,
} from "../../src/lib/localAgent/gatewayProtocol";
import { createConnectorGatewayTransport } from "../../src/lib/localAgent/gatewayProtocol";
import { createHttpLocalAgentGatewayTransport } from "../../src/lib/localAgent/httpGatewayTransport";

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

test("ComfyUI image jobs upload raw artifact bytes before marking the job complete", async () => {
  const calls: string[] = [];
  let uploaded: Uint8Array | undefined;
  let uploadedType = "";
  let completedPromptId = "";
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const result = await runLocalAgentGatewayCycle(
    { ...config, comfyUiUrl: "http://127.0.0.1:8188" },
    {
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      createNonce: () => "heartbeat-nonce-image-01",
      discover: async () => ({
        heartbeat: { status: "online", capabilities: ["comfyui:image"] },
        services: [
          { service: "comfyui", reachable: true, models: ["comfyui:checkpoint:model.safetensors"] },
        ],
      }),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/heartbeat")) return Response.json({ accepted: true });
        if (url.pathname === "/prompt") {
          calls.push("prompt");
          const body = JSON.parse(String(init?.body)) as { prompt: Record<string, unknown> };
          assert.equal(Object.keys(body.prompt).length, 7);
          return Response.json({ prompt_id: "image_job_prompt" });
        }
        if (url.pathname === "/history/image_job_prompt") {
          calls.push("history");
          return Response.json({
            image_job_prompt: {
              status: { completed: true, status_str: "success" },
              outputs: {
                "7": { images: [{ filename: "image.png", subfolder: "", type: "output" }] },
              },
            },
          });
        }
        if (url.pathname === "/view") {
          calls.push("view");
          return new Response(png, { headers: { "content-type": "image/png" } });
        }
        throw new Error(`Unexpected request: ${url.href}`);
      },
      gateway: {
        connect: async () => session,
        heartbeat: async () => true,
        poll: async () => [
          {
            requestId: "image-job-1",
            capability: "comfyui:image",
            payload: {
              prompt: "a house",
              checkpoint: "model.safetensors",
              width: 64,
              height: 64,
              steps: 2,
              cfg: 1,
              seed: 9,
            },
            expiresAt: "2026-10-08T12:01:00.000Z",
          },
        ],
        submitResult: async () => {
          calls.push("submitResult");
          return true;
        },
        getImageJobControl: async () => {
          calls.push("control");
          return "running";
        },
        uploadImageJobArtifact: async (_activeSession, _requestId, bytes, contentType) => {
          calls.push("upload");
          uploaded = bytes;
          uploadedType = contentType;
          return true;
        },
        completeImageJob: async (_activeSession, _requestId, promptId) => {
          calls.push("complete");
          completedPromptId = promptId;
          return true;
        },
        failImageJob: async () => false,
      },
    },
    session
  );
  assert.equal(result.processed, 1);
  assert.deepEqual(uploaded, png);
  assert.equal(uploadedType, "image/png");
  assert.equal(completedPromptId, "image_job_prompt");
  assert.ok(calls.indexOf("upload") > calls.indexOf("view"));
  assert.ok(calls.indexOf("complete") > calls.indexOf("upload"));
  assert.ok(!calls.includes("submitResult"));
});

test("ComfyUI cancellation stops before artifact upload and reports a fixed failure code", async () => {
  const calls: string[] = [];
  let controlCalls = 0;
  await runLocalAgentGatewayCycle(
    { ...config, comfyUiUrl: "http://127.0.0.1:8188" },
    {
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      createNonce: () => "heartbeat-nonce-image-02",
      discover: async () => ({
        heartbeat: { status: "online", capabilities: ["comfyui:image"] },
        services: [
          { service: "comfyui", reachable: true, models: ["comfyui:checkpoint:model.safetensors"] },
        ],
      }),
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/heartbeat")) return Response.json({ accepted: true });
        if (url.pathname === "/prompt") return Response.json({ prompt_id: "cancelled_image_job" });
        throw new Error(`ComfyUI should not be polled after cancellation: ${url.href}`);
      },
      gateway: {
        connect: async () => session,
        heartbeat: async () => true,
        poll: async () => [
          {
            requestId: "image-job-cancelled",
            capability: "comfyui:image",
            payload: { prompt: "a house", width: 64, height: 64, steps: 2, cfg: 1, seed: 9 },
            expiresAt: "2026-10-08T12:01:00.000Z",
          },
        ],
        submitResult: async () => false,
        getImageJobControl: async () => (++controlCalls < 3 ? "running" : "cancelled"),
        uploadImageJobArtifact: async () => {
          calls.push("upload");
          return true;
        },
        completeImageJob: async () => {
          calls.push("complete");
          return true;
        },
        failImageJob: async (_activeSession, _requestId, code) => {
          calls.push(`fail:${code}`);
          return true;
        },
      },
    },
    session
  );
  assert.deepEqual(calls, ["fail:cancelled"]);
});

test("ComfyUI image jobs reject raw workflow payloads without running ComfyUI", async () => {
  const calls: string[] = [];
  await runLocalAgentGatewayCycle(
    { ...config, comfyUiUrl: "http://127.0.0.1:8188" },
    {
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      createNonce: () => "heartbeat-nonce-image-03",
      discover: async () => ({
        heartbeat: { status: "online", capabilities: ["comfyui:image"] },
        services: [
          { service: "comfyui", reachable: true, models: ["comfyui:checkpoint:model.safetensors"] },
        ],
      }),
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/heartbeat")) return Response.json({ accepted: true });
        calls.push(url.pathname);
        throw new Error(`Unexpected request: ${url.href}`);
      },
      gateway: {
        connect: async () => session,
        heartbeat: async () => true,
        poll: async () => [
          {
            requestId: "image-job-raw-workflow",
            capability: "comfyui:image",
            payload: { workflow: { "1": { class_type: "MaliciousCustomNode" } } },
            expiresAt: "2026-10-08T12:01:00.000Z",
          },
        ],
        submitResult: async () => false,
        getImageJobControl: async () => "running",
        uploadImageJobArtifact: async () => false,
        completeImageJob: async () => false,
        failImageJob: async (_activeSession, _requestId, code) => {
          calls.push(`fail:${code}`);
          return true;
        },
      },
    },
    session
  );
  assert.deepEqual(calls, ["fail:capability_unavailable"]);
});

test("gateway shutdown aborts an in-flight unary local capability request", async () => {
  const controller = new AbortController();
  let localRequestSignal: AbortSignal | undefined;
  let submitted: LocalAgentGatewayResult | null = null;
  await runLocalAgentGatewayCycle(
    config,
    {
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      createNonce: () => "heartbeat-nonce-shutdown",
      abortSignal: controller.signal,
      discover: async () => ({
        heartbeat: { status: "online", capabilities: ["ollama:chat:local"] },
        services: [{ service: "ollama", reachable: true, models: ["local"] }],
      }),
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname.endsWith("/heartbeat")) {
          return Response.json({ accepted: true });
        }
        localRequestSignal = init?.signal ?? undefined;
        controller.abort();
        assert.equal(localRequestSignal?.aborted, true);
        throw new DOMException("Aborted", "AbortError");
      },
      gateway: {
        connect: async () => session,
        heartbeat: async () => true,
        poll: async () => [
          {
            requestId: "request-shutdown",
            capability: "ollama:chat:local",
            payload: { messages: [{ role: "user", content: "hello" }] },
            expiresAt: "2026-10-08T12:01:00.000Z",
          },
        ],
        submitResult: async (_activeSession, result) => {
          submitted = result;
          return true;
        },
      },
    },
    session
  );

  assert.equal(localRequestSignal?.aborted, true);
  assert.deepEqual(submitted, {
    version: 1,
    requestId: "request-shutdown",
    outcome: { ok: false, error: { code: "capability_execution_failed" } },
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

test("gateway cycle reconnects when a cached device session has been revoked", async () => {
  const events: string[] = [];
  const replacementSession = {
    ...session,
    sessionId: "session-reconnected",
    sessionToken: "fresh-token",
  };
  const cycle = await runLocalAgentGatewayCycle(
    config,
    {
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      createNonce: () => "heartbeat-nonce-reconnect",
      discover: async () => ({ heartbeat: { status: "online", capabilities: [] }, services: [] }),
      fetch: async () => Response.json({ accepted: true }),
      gateway: {
        connect: async () => {
          events.push("connect");
          return replacementSession;
        },
        heartbeat: async (activeSession) => {
          events.push(`heartbeat:${activeSession.sessionId}`);
          return activeSession === replacementSession;
        },
        poll: async (activeSession) => {
          events.push(`poll:${activeSession.sessionId}`);
          return [];
        },
        submitResult: async () => true,
      },
      execute: async () => ({}),
    },
    session
  );

  assert.equal(cycle.session, replacementSession);
  assert.deepEqual(events, [
    "heartbeat:session-123",
    "connect",
    "heartbeat:session-reconnected",
    "poll:session-reconnected",
  ]);
});

test("gateway runner clears an offline session, backs off, and reconnects before polling again", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const delays: number[] = [];
  const replacementSession: LocalAgentGatewaySession = {
    ...session,
    sessionId: "session-after-outage",
    sessionToken: "replacement-token",
  };

  await runLocalAgentWithGateway(
    { ...config, retryBaseMs: 5, retryMaxMs: 20, heartbeatIntervalMs: 25 },
    {
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      discover: async () => ({
        heartbeat: { status: "online", capabilities: ["ollama:chat:local"] },
        services: [],
      }),
      fetch: async () => Response.json({ accepted: true }),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 2) controller.abort();
      },
      gateway: {
        connect: async () => {
          const connected = events.filter((event) => event.startsWith("connect:")).length + 1;
          events.push(`connect:${connected}`);
          return connected === 1 ? session : replacementSession;
        },
        heartbeat: async (activeSession) => {
          events.push(`heartbeat:${activeSession.sessionId}`);
          return true;
        },
        poll: async (activeSession) => {
          events.push(`poll:${activeSession.sessionId}`);
          return activeSession === session ? null : [];
        },
        submitResult: async () => true,
      },
    },
    controller.signal
  );

  assert.deepEqual(events, [
    "connect:1",
    "heartbeat:session-123",
    "poll:session-123",
    "connect:2",
    "heartbeat:session-after-outage",
    "poll:session-after-outage",
  ]);
  assert.deepEqual(delays, [5, 1_000]);
});

test("gateway runner stops when HTTP connect returns a credential rejection", async () => {
  const events: string[] = [];
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => logged.push(values.join(" "));
  const gateway = createHttpLocalAgentGatewayTransport(config.gatewayUrl, {
    fetch: async (_input, init) => {
      assert.equal(init?.method, "POST");
      events.push("connect");
      return Response.json({ error: "Device authentication failed" }, { status: 401 });
    },
  });
  try {
    await runLocalAgentWithGateway(
      { ...config, retryBaseMs: 1, retryMaxMs: 1 },
      {
        gateway,
        fetch: async () => Response.json({}),
        discover: async () => ({
          heartbeat: { status: "online", capabilities: ["ollama:chat:local"] },
          services: [],
        }),
        sleep: async () => {
          events.push("retry");
        },
      },
      new AbortController().signal
    );
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(events, ["connect"]);
  assert.match(logged.join(" "), /re-enroll the device/);
  assert.doesNotMatch(logged.join(" "), new RegExp(config.credential));
});

test("gateway runner polls within invocation deadlines and drains queued work between discovery refreshes", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const delays: number[] = [];
  const request = (requestId: string): Omit<LocalAgentGatewayRequest, "version"> => ({
    requestId,
    capability: "ollama:chat:local",
    payload: { messages: [{ role: "user", content: requestId }] },
    expiresAt: new Date(now + 15_000).toISOString(),
  });
  let now = Date.parse("2026-10-08T12:00:00.000Z");
  let discoveryCount = 0;
  let pollCount = 0;

  await runLocalAgentWithGateway(
    { ...config, heartbeatIntervalMs: 30_000 },
    {
      now: () => now,
      discover: async () => {
        discoveryCount += 1;
        return {
          heartbeat: { status: "online", capabilities: ["ollama:chat:local"] },
          services: [],
        };
      },
      fetch: async () => Response.json({ accepted: true }),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
        if (delays.length === 3) controller.abort();
      },
      gateway: {
        connect: async () => session,
        heartbeat: async () => true,
        poll: async () => {
          pollCount += 1;
          if (pollCount === 1) return [];
          if (pollCount === 2) return [request("request-first")];
          return [request("request-second")];
        },
        submitResult: async (_activeSession, result) => {
          events.push(result.requestId);
          return true;
        },
      },
      execute: async (gatewayRequest) => ({ requestId: gatewayRequest.requestId }),
    },
    controller.signal
  );

  assert.deepEqual(delays, [1_000, 1_000, 1_000]);
  assert.equal(discoveryCount, 1);
  assert.equal(pollCount, 3);
  assert.deepEqual(events, ["request-first", "request-second"]);
  assert.ok(now - Date.parse("2026-10-08T12:00:00.000Z") < 15_000);
});

test("slow periodic discovery does not pause gateway polling", async () => {
  const controller = new AbortController();
  const discoveryResult = {
    heartbeat: { status: "online" as const, capabilities: ["ollama:chat:local"] },
    services: [],
  };
  let now = Date.parse("2026-10-08T12:00:00.000Z");
  let discoveryCount = 0;
  let pollCount = 0;
  let finishRefresh: ((result: typeof discoveryResult) => void) | undefined;
  let markRefreshStarted: (() => void) | undefined;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });

  const run = runLocalAgentWithGateway(
    { ...config, heartbeatIntervalMs: 2_000 },
    {
      now: () => now,
      discover: async () => {
        discoveryCount += 1;
        if (discoveryCount === 1) return discoveryResult;
        markRefreshStarted?.();
        return new Promise<typeof discoveryResult>((resolve) => {
          finishRefresh = resolve;
        });
      },
      fetch: async () => Response.json({ accepted: true }),
      sleep: async (milliseconds) => {
        now += milliseconds;
        if (now - Date.parse("2026-10-08T12:00:00.000Z") >= 3_000) controller.abort();
      },
      gateway: {
        connect: async () => session,
        heartbeat: async () => true,
        poll: async () => {
          pollCount += 1;
          return [];
        },
        submitResult: async () => true,
      },
    },
    controller.signal
  );

  await refreshStarted;
  await run;
  finishRefresh?.(discoveryResult);
  assert.equal(discoveryCount, 2);
  assert.equal(pollCount, 3);
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

test("gateway cycle discovers and forwards only a configured Local MCP tool", async () => {
  let submitted: LocalAgentGatewayResult | null = null;
  const methods: string[] = [];
  const mcpServer = {
    id: "docs",
    endpoint: "http://127.0.0.1:9911/mcp",
    tools: [{ name: "read_file" }],
  };
  const cycle = await runLocalAgentGatewayCycle(
    { ...config, mcpServers: [{ id: mcpServer.id, endpoint: mcpServer.endpoint }] },
    {
      now: () => Date.parse("2026-10-08T12:00:00.000Z"),
      fetch: async (input) =>
        String(input).startsWith("https://gateway.example.test/")
          ? Response.json({ accepted: true })
          : new Response(null, { status: 404 }),
      mcp: {
        transport: {
          async fetch(input, init) {
            assert.equal(input, mcpServer.endpoint);
            assert.equal(init.redirect, "manual");
            const request = JSON.parse(String(init.body)) as {
              id?: number;
              method?: string;
              params?: unknown;
            };
            methods.push(String(request.method));
            if (request.method === "notifications/initialized") {
              return new Response(null, { status: 202 });
            }
            if (request.method === "initialize") {
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { protocolVersion: "2025-11-25" },
                },
                { headers: { "Mcp-Session-Id": "local-session" } }
              );
            }
            if (request.method === "tools/list") {
              return Response.json({
                jsonrpc: "2.0",
                id: request.id,
                result: { tools: [{ name: "read_file" }] },
              });
            }
            assert.equal(request.method, "tools/call");
            assert.deepEqual(request.params, {
              name: "read_file",
              arguments: { path: "README.md" },
            });
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: { content: [{ type: "text", text: "local result" }] },
            });
          },
        },
      },
      gateway: {
        connect: async () => session,
        heartbeat: async (_activeSession, capabilities) => {
          assert.deepEqual(capabilities, ["mcp:docs:read_file"]);
          return true;
        },
        poll: async () => [
          {
            requestId: "request-local-mcp",
            capability: "mcp:docs:read_file",
            payload: { path: "README.md" },
            expiresAt: "2026-10-08T12:01:00.000Z",
          },
        ],
        submitResult: async (_activeSession, result) => {
          submitted = result;
          return true;
        },
      },
    },
    session
  );

  assert.equal(cycle.processed, 1);
  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
  assert.deepEqual(submitted, {
    version: 1,
    requestId: "request-local-mcp",
    outcome: { ok: true, value: { content: [{ type: "text", text: "local result" }] } },
  });
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
