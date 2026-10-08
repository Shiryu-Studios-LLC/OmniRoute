import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runLocalAgent,
  runLocalAgentCycle,
  type LocalAgentRunnerConfig,
} from "../../src/lib/localAgent/runner";
import { signLocalAgentHeartbeat } from "../../src/lib/localAgent/protocol";

const config: LocalAgentRunnerConfig = {
  gatewayUrl: "https://gateway.example.test/base",
  deviceId: "device-123",
  credential: "a".repeat(43),
  ollamaUrl: "http://127.0.0.1:11434",
};

const discover = async () => ({
  heartbeat: { status: "online" as const, capabilities: ["ollama:chat:local"] },
  services: [{ service: "ollama" as const, reachable: true, models: ["local"] }],
});

test("sends signed heartbeat outbound to the existing endpoint with discovered capabilities", async () => {
  let sentUrl = "";
  let sentBody: Record<string, unknown> | null = null;
  const result = await runLocalAgentCycle(config, {
    discover,
    now: () => 1_800_000_000_000,
    createNonce: () => "runner-nonce-00000001",
    fetch: async (input, init) => {
      sentUrl = String(input);
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      return new Response("{}", { status: 200 });
    },
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(sentUrl, "https://gateway.example.test/api/local-agents/heartbeat");
  assert.ok(sentBody);
  assert.equal(sentBody.deviceId, config.deviceId);
  assert.equal(sentBody.credential, config.credential);
  assert.deepEqual(sentBody.payload, { status: "online", capabilities: ["ollama:chat:local"] });
  assert.equal(
    sentBody.signature,
    signLocalAgentHeartbeat(config.credential, 1_800_000_000_000, "runner-nonce-00000001", {
      status: "online",
      capabilities: ["ollama:chat:local"],
    })
  );
});

test("permits plain HTTP only for local development gateways", async () => {
  await assert.rejects(
    runLocalAgentCycle(
      { ...config, gatewayUrl: "http://gateway.example.test" },
      {
        discover,
        fetch: async () => new Response("{}", { status: 200 }),
      }
    ),
    /must use HTTPS/
  );
  await runLocalAgentCycle(
    { ...config, gatewayUrl: "http://localhost:20128" },
    {
      discover,
      fetch: async () => new Response("{}", { status: 200 }),
    }
  );
});

test("retries with capped exponential backoff and stops when aborted", async () => {
  const delays: number[] = [];
  let calls = 0;
  const controller = new AbortController();
  await runLocalAgent(
    { ...config, retryBaseMs: 10, retryMaxMs: 25, heartbeatIntervalMs: 50 },
    {
      discover,
      fetch: async () => {
        calls += 1;
        if (calls === 4) controller.abort();
        return new Response("unavailable", { status: 503 });
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
    controller.signal
  );
  assert.equal(calls, 4);
  assert.deepEqual(delays, [10, 20, 25]);
});

test("rejects invalid credentials and unsafe gateway URLs before network access", async () => {
  let calls = 0;
  await assert.rejects(
    runLocalAgentCycle(
      { ...config, credential: "short" },
      {
        discover,
        fetch: async () => {
          calls += 1;
          return new Response("{}", { status: 200 });
        },
      }
    ),
    /Invalid local agent credential/
  );
  assert.equal(calls, 0);
});
