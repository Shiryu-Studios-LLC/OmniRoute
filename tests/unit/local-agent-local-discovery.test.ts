import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverLocalCapabilities } from "../../src/lib/localAgent/localDiscovery";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

test("discovers installed Ollama IDs and only reports verified model capabilities", async () => {
  const requested: string[] = [];
  const result = await discoverLocalCapabilities(
    { ollamaUrl: "http://localhost:11434" },
    {
      resolveHost: async (host) => (host === "localhost" ? ["127.0.0.1", "::1"] : []),
      fetch: async (input, init) => {
        const url = String(input);
        requested.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/api/tags")) {
          return jsonResponse({ models: [{ name: "llama3.2:3b" }, { name: "llava:7b" }] });
        }
        const modelName = String(init?.body ?? "");
        return jsonResponse({
          capabilities: modelName.includes("llava")
            ? ["completion", "vision", "embedding"]
            : ["completion"],
        });
      },
    }
  );

  assert.deepEqual(result.services, [
    { service: "ollama", reachable: true, models: ["llama3.2:3b", "llava:7b"] },
  ]);
  assert.deepEqual(result.heartbeat, {
    status: "online",
    capabilities: [
      "ollama:model:llama3.2:3b",
      "ollama:model:llava:7b",
      "ollama:chat:llama3.2:3b",
      "ollama:chat:llava:7b",
    ],
  });
  assert.equal(
    result.heartbeat.capabilities.some((capability) => /:(vision|embedding):/.test(capability)),
    false
  );
  assert.equal(requested.length, 3);
  assert.match(requested[0], /^GET http:\/\/localhost:11434\/api\/tags$/);
  assert.match(requested[1], /^POST http:\/\/localhost:11434\/api\/show$/);
});

test("discovers ComfyUI checkpoint IDs and only executable image capability", async () => {
  const result = await discoverLocalCapabilities(
    { comfyUiUrl: "http://192.168.1.20:8188" },
    {
      resolveHost: async () => ["192.168.1.20"],
      fetch: async () =>
        jsonResponse({
          CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl.safetensors"]] } } },
          KSampler: {},
          SaveImage: {},
          VHS_VideoCombine: {},
        }),
    }
  );

  assert.deepEqual(result.services, [
    { service: "comfyui", reachable: true, models: ["comfyui:checkpoint:sdxl.safetensors"] },
  ]);
  assert.deepEqual(result.heartbeat, {
    status: "online",
    capabilities: ["comfyui:image"],
  });
});

test("does not make a request to arbitrary DNS hostnames, even if they resolve privately", async () => {
  let calls = 0;
  const result = await discoverLocalCapabilities(
    { ollamaUrl: "http://ollama.internal:11434" },
    {
      resolveHost: async () => ["10.0.0.4"],
      fetch: async () => {
        calls += 1;
        return jsonResponse({ models: [] });
      },
    }
  );
  assert.equal(calls, 0);
  assert.deepEqual(result.services, [{ service: "ollama", reachable: false, models: [] }]);
});

test("rejects link-local metadata addresses before sending a request", async () => {
  let calls = 0;
  const result = await discoverLocalCapabilities(
    { ollamaUrl: "http://169.254.169.254/latest/meta-data" },
    {
      fetch: async () => {
        calls += 1;
        return jsonResponse({ models: [] });
      },
    }
  );
  assert.equal(calls, 0);
  assert.equal(result.services[0]?.reachable, false);
});

test("rejects URL credentials and caps Ollama model enumeration", async () => {
  let calls = 0;
  const rejected = await discoverLocalCapabilities(
    { ollamaUrl: "http://user:password@127.0.0.1:11434" },
    {
      fetch: async () => {
        calls += 1;
        return jsonResponse({ models: [] });
      },
    }
  );
  assert.equal(calls, 0);
  assert.equal(rejected.services[0]?.reachable, false);

  const models = Array.from({ length: 40 }, (_, index) => ({ name: `model-${index}` }));
  const bounded = await discoverLocalCapabilities(
    { ollamaUrl: "http://127.0.0.1:11434" },
    {
      fetch: async (_input, init) => {
        calls += 1;
        if (init?.method === "POST") return jsonResponse({ capabilities: [] });
        return jsonResponse({ models });
      },
    }
  );
  assert.equal(bounded.services[0]?.models.length, 32);
  assert.equal(calls, 33);
});

test("never infers ComfyUI image generation without required nodes and checkpoints", async () => {
  const result = await discoverLocalCapabilities(
    { comfyUiUrl: "http://127.0.0.1:8188" },
    {
      fetch: async () => jsonResponse({ KSampler: {}, SaveImage: {} }),
    }
  );
  assert.deepEqual(result.heartbeat.capabilities, []);
});
