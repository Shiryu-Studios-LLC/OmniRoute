import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverLocalCapabilities } from "../../src/lib/localAgent/localDiscovery";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

test("discovers installed Ollama IDs and only reports verified model capabilities", async () => {
  const requested: string[] = [];
  const result = await discoverLocalCapabilities(
    { ollamaUrl: "http://localhost:11434", comfyUiUrl: "http://comfy.internal:8188" },
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
    { service: "comfyui", reachable: false, models: [] },
  ]);
  assert.deepEqual(result.heartbeat, {
    status: "online",
    capabilities: [
      "ollama:model:llama3.2:3b",
      "ollama:model:llava:7b",
      "ollama:chat:llama3.2:3b",
      "ollama:chat:llava:7b",
    ],
    serviceHealth: { ollama: true, comfyui: false },
  });
  assert.equal(
    result.heartbeat.capabilities.some((capability) => /:(vision|embedding):/.test(capability)),
    false
  );
  assert.equal(requested.length, 3);
  assert.match(requested[0], /^GET http:\/\/127\.0\.0\.1:11434\/api\/tags$/);
  assert.match(requested[1], /^POST http:\/\/127\.0\.0\.1:11434\/api\/show$/);
});

test("pins localhost to its validated loopback address before fetching", async () => {
  const requested: string[] = [];
  const result = await discoverLocalCapabilities(
    { ollamaUrl: "http://localhost:11434" },
    {
      resolveHost: async () => ["::1"],
      fetch: async (input) => {
        requested.push(String(input));
        return jsonResponse({ models: [] });
      },
    }
  );

  assert.equal(result.services[0]?.reachable, true);
  assert.equal(requested[0], "http://[::1]:11434/api/tags");
});

test("rejects localhost that resolves to a non-loopback private address", async () => {
  const requested: string[] = [];
  const result = await discoverLocalCapabilities(
    { ollamaUrl: "http://localhost:11434" },
    {
      resolveHost: async () => ["127.0.0.1", "192.168.1.10"],
      fetch: async (input) => {
        requested.push(String(input));
        return jsonResponse({ models: [] });
      },
    }
  );

  assert.equal(
    requested.some((url) => url.includes(":11434/")),
    false
  );
  assert.equal(result.services[0]?.reachable, false);
});

test("discovers ComfyUI checkpoint IDs and only executable image capability", async () => {
  const result = await discoverLocalCapabilities(
    { ollamaUrl: "http://ollama.internal:11434", comfyUiUrl: "http://192.168.1.20:8188" },
    {
      resolveHost: async () => ["192.168.1.20"],
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/object_info/CheckpointLoaderSimple")) {
          return jsonResponse({
            CheckpointLoaderSimple: {
              input: { required: { ckpt_name: [["sdxl.safetensors"]] } },
            },
          });
        }
        if (url.endsWith("/object_info/KSampler")) return jsonResponse({ KSampler: {} });
        if (url.endsWith("/object_info/SaveImage")) return jsonResponse({ SaveImage: {} });
        throw new Error(`Unexpected ComfyUI metadata request: ${url}`);
      },
    }
  );

  assert.deepEqual(result.services, [
    { service: "ollama", reachable: false, models: [] },
    { service: "comfyui", reachable: true, models: ["comfyui:checkpoint:sdxl.safetensors"] },
  ]);
  assert.deepEqual(result.heartbeat, {
    status: "online",
    capabilities: ["comfyui:image"],
    serviceHealth: { ollama: false, comfyui: true },
  });
});

test("probes only the default loopback endpoints when service URLs are omitted", async () => {
  const requested: string[] = [];
  const result = await discoverLocalCapabilities(
    {},
    {
      fetch: async (input, init) => {
        const url = String(input);
        requested.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen3" }] });
        if (url.endsWith("/api/show")) return jsonResponse({ capabilities: ["completion"] });
        if (url.endsWith("/object_info/CheckpointLoaderSimple"))
          return jsonResponse({
            CheckpointLoaderSimple: {
              input: { required: { ckpt_name: [["sdxl.safetensors"]] } },
            },
          });
        if (url.endsWith("/object_info/KSampler")) return jsonResponse({ KSampler: {} });
        if (url.endsWith("/object_info/SaveImage")) return jsonResponse({ SaveImage: {} });
        throw new Error(`Unexpected local service request: ${url}`);
      },
    }
  );

  assert.deepEqual(requested, [
    "GET http://127.0.0.1:11434/api/tags",
    "POST http://127.0.0.1:11434/api/show",
    "GET http://127.0.0.1:8188/object_info/CheckpointLoaderSimple",
    "GET http://127.0.0.1:8188/object_info/KSampler",
    "GET http://127.0.0.1:8188/object_info/SaveImage",
  ]);
  assert.deepEqual(result.services, [
    { service: "ollama", reachable: true, models: ["qwen3"] },
    { service: "comfyui", reachable: true, models: ["comfyui:checkpoint:sdxl.safetensors"] },
  ]);
  assert.deepEqual(result.heartbeat.capabilities, [
    "ollama:model:qwen3",
    "ollama:chat:qwen3",
    "comfyui:image",
  ]);
  assert.deepEqual(result.heartbeat.serviceHealth, { ollama: true, comfyui: true });
});

test("reports omitted default loopback services as unavailable when probes fail", async () => {
  const requested: string[] = [];
  const result = await discoverLocalCapabilities(
    {},
    {
      fetch: async (input) => {
        requested.push(String(input));
        throw new Error("service offline");
      },
    }
  );

  assert.deepEqual(requested, [
    "http://127.0.0.1:11434/api/tags",
    "http://127.0.0.1:8188/object_info/CheckpointLoaderSimple",
    "http://127.0.0.1:8188/object_info/KSampler",
    "http://127.0.0.1:8188/object_info/SaveImage",
  ]);
  assert.deepEqual(result.services, [
    { service: "ollama", reachable: false, models: [] },
    { service: "comfyui", reachable: false, models: [] },
  ]);
  assert.deepEqual(result.heartbeat.capabilities, []);
  assert.deepEqual(result.heartbeat.serviceHealth, { ollama: false, comfyui: false });
});

test("does not make a request to arbitrary DNS hostnames, even if they resolve privately", async () => {
  let calls = 0;
  const result = await discoverLocalCapabilities(
    { ollamaUrl: "http://ollama.internal:11434", comfyUiUrl: "http://comfy.internal:8188" },
    {
      resolveHost: async () => ["10.0.0.4"],
      fetch: async () => {
        calls += 1;
        return jsonResponse({ models: [] });
      },
    }
  );
  assert.equal(calls, 0);
  assert.deepEqual(result.services, [
    { service: "ollama", reachable: false, models: [] },
    { service: "comfyui", reachable: false, models: [] },
  ]);
});

test("rejects link-local metadata addresses before sending a request", async () => {
  let calls = 0;
  const result = await discoverLocalCapabilities(
    {
      ollamaUrl: "http://169.254.169.254/latest/meta-data",
      comfyUiUrl: "http://169.254.169.254/latest/meta-data",
    },
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
    {
      ollamaUrl: "http://user:password@127.0.0.1:11434",
      comfyUiUrl: "http://user:password@127.0.0.1:8188",
    },
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
    {
      ollamaUrl: "http://127.0.0.1:11434",
      comfyUiUrl: "http://user:password@127.0.0.1:8188",
    },
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

test("omits capabilities exceeding the heartbeat field limit without dropping valid models", async () => {
  const tooLongModel = "m".repeat(80);
  const result = await discoverLocalCapabilities(
    { ollamaUrl: "http://127.0.0.1:11434", comfyUiUrl: "http://user:password@127.0.0.1:8188" },
    {
      fetch: async (_input, init) =>
        init?.method === "POST"
          ? jsonResponse({ capabilities: ["completion"] })
          : jsonResponse({ models: [{ name: tooLongModel }, { name: "valid-model" }] }),
    }
  );

  assert.deepEqual(result.services[0], {
    service: "ollama",
    reachable: true,
    models: [tooLongModel, "valid-model"],
  });
  assert.deepEqual(result.heartbeat.capabilities, [
    "ollama:model:valid-model",
    "ollama:chat:valid-model",
  ]);
  assert.ok(result.heartbeat.capabilities.every((capability) => capability.length <= 80));
});

test("never infers ComfyUI image generation without required nodes and checkpoints", async () => {
  const result = await discoverLocalCapabilities(
    { ollamaUrl: "http://user:password@127.0.0.1:11434", comfyUiUrl: "http://127.0.0.1:8188" },
    {
      fetch: async () => jsonResponse({ KSampler: {}, SaveImage: {} }),
    }
  );
  assert.deepEqual(result.heartbeat.capabilities, []);
});
