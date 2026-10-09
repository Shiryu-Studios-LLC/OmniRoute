import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildComfyUiImageWorkflow,
  executeLocalCapability,
  executeLocalComfyUiImageJob,
  executeLocalCapabilityStream,
} from "../../src/lib/localAgent/capabilityExecutor";
import type { LocalDiscoveryResult } from "../../src/lib/localAgent/localDiscovery";

const discovery: LocalDiscoveryResult = {
  heartbeat: {
    status: "online",
    capabilities: ["ollama:chat:qwen2.5:7b", "comfyui:image"],
  },
  services: [
    { service: "ollama", reachable: true, models: ["qwen2.5:7b"] },
    { service: "comfyui", reachable: true, models: ["comfyui:checkpoint:sdxl.safetensors"] },
  ],
};

const imageJob = {
  prompt: "a red apple",
  negativePrompt: "blurry",
  checkpoint: "sdxl.safetensors",
  width: 64,
  height: 64,
  steps: 1,
  cfg: 1,
  seed: 42,
};

test("dispatches discovered Ollama chat to the fixed local API with the capability model", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> | null = null;
  const result = await executeLocalCapability(
    { ollamaUrl: "http://127.0.0.1:11434" },
    discovery,
    {
      capability: "ollama:chat:qwen2.5:7b",
      payload: { messages: [{ role: "user", content: "hello" }], options: { temperature: 0.2 } },
    },
    {
      resolveHost: async () => ["127.0.0.1"],
      fetch: async (input, init) => {
        requestedUrl = String(input);
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ message: { role: "assistant", content: "hi" }, done: true });
      },
    }
  );

  assert.equal(requestedUrl, "http://127.0.0.1:11434/api/chat");
  assert.deepEqual(requestedBody, {
    messages: [{ role: "user", content: "hello" }],
    options: { temperature: 0.2 },
    model: "qwen2.5:7b",
    stream: false,
  });
  assert.deepEqual(result, { message: { role: "assistant", content: "hi" }, done: true });
});

test("Ollama chat execution uses the bounded gateway-sized request timeout", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeoutValues: number[] = [];
  AbortSignal.timeout = ((milliseconds: number) => {
    timeoutValues.push(milliseconds);
    return originalTimeout(milliseconds);
  }) as typeof AbortSignal.timeout;
  try {
    await executeLocalCapability(
      { ollamaUrl: "http://127.0.0.1:11434" },
      discovery,
      {
        capability: "ollama:chat:qwen2.5:7b",
        payload: { messages: [{ role: "user", content: "hello" }] },
      },
      {
        resolveHost: async () => ["127.0.0.1"],
        fetch: async () => Response.json({ message: { role: "assistant", content: "hi" } }),
      }
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  assert.deepEqual(timeoutValues, [25_000]);
});

test("streams bounded Ollama chat deltas and usage from NDJSON", async () => {
  let requestedBody: Record<string, unknown> | null = null;
  const emitted: unknown[] = [];
  const encoder = new TextEncoder();
  await executeLocalCapabilityStream(
    { ollamaUrl: "http://127.0.0.1:11434" },
    discovery,
    {
      capability: "ollama:chat:qwen2.5:7b",
      payload: { messages: [{ role: "user", content: "hello" }] },
    },
    {
      resolveHost: async () => ["127.0.0.1"],
      signal: new AbortController().signal,
      emit: async (event) => emitted.push(event),
      fetch: async (_input, init) => {
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('{"message":{"content":"hel"},"done":false}\n'));
              controller.enqueue(
                encoder.encode(
                  '{"message":{"content":"lo"},"done":true,"prompt_eval_count":4,"eval_count":2}\n'
                )
              );
              controller.close();
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } }
        );
      },
    }
  );
  assert.deepEqual(requestedBody, {
    messages: [{ role: "user", content: "hello" }],
    model: "qwen2.5:7b",
    stream: true,
  });
  assert.deepEqual(emitted, [
    { type: "delta", data: { content: "hel" } },
    { type: "delta", data: { content: "lo" } },
    { type: "usage", data: { promptTokens: 4, completionTokens: 2 } },
  ]);
});

test("builds a fixed ComfyUI graph and returns validated raw image bytes", async () => {
  const requestedUrls: string[] = [];
  let requestedBody: Record<string, unknown> | null = null;
  const result = await executeLocalComfyUiImageJob(
    { comfyUiUrl: "http://127.0.0.1:8188" },
    discovery,
    imageJob,
    {
      resolveHost: async () => ["127.0.0.1"],
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requestedUrls.push(url.href);
        if (url.pathname.endsWith("/prompt")) {
          requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({ prompt_id: "job_123" });
        }
        if (url.pathname.endsWith("/history/job_123")) {
          return Response.json({
            job_123: {
              status: { completed: true, status_str: "success" },
              outputs: {
                "9": { images: [{ filename: "result.png", subfolder: "", type: "output" }] },
              },
            },
          });
        }
        assert.equal(url.pathname, "/view");
        assert.equal(url.searchParams.get("filename"), "result.png");
        assert.equal(url.searchParams.get("type"), "output");
        return new Response(
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
          {
            headers: { "content-type": "image/png" },
          }
        );
      },
    },
    async () => "running"
  );

  assert.equal(requestedUrls[0], "http://127.0.0.1:8188/prompt");
  assert.equal(Object.keys((requestedBody?.prompt ?? {}) as object).length, 7);
  const graph = (requestedBody?.prompt ?? {}) as Record<string, { class_type: string }>;
  assert.deepEqual([...new Set(Object.values(graph).map((node) => node.class_type))].sort(), [
    "CLIPTextEncode",
    "CheckpointLoaderSimple",
    "EmptyLatentImage",
    "KSampler",
    "SaveImage",
    "VAEDecode",
  ]);
  assert.deepEqual(result, {
    promptId: "job_123",
    contentType: "image/png",
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
  });
});

test("validates checkpoint discovery and image parameter bounds before building a graph", async () => {
  const graph = buildComfyUiImageWorkflow(imageJob, discovery);
  assert.equal(
    (graph["1"] as { inputs: { ckpt_name: string } }).inputs.ckpt_name,
    "sdxl.safetensors"
  );
  assert.throws(
    () => buildComfyUiImageWorkflow({ ...imageJob, checkpoint: "attacker.safetensors" }, discovery),
    /checkpoint is unavailable/
  );
  assert.throws(
    () => buildComfyUiImageWorkflow({ ...imageJob, width: 2048 }, discovery),
    /parameters|invalid/
  );
  assert.throws(
    () => buildComfyUiImageWorkflow({ ...imageJob, steps: 31 }, discovery),
    /parameters|invalid/
  );
});

test("rejects raw caller workflow graphs before any ComfyUI request", async () => {
  let calls = 0;
  await assert.rejects(
    executeLocalComfyUiImageJob(
      { comfyUiUrl: "http://127.0.0.1:8188" },
      discovery,
      { workflow: { "1": { class_type: "MaliciousCustomNode", inputs: {} } } },
      {
        resolveHost: async () => ["127.0.0.1"],
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      },
      async () => "running"
    ),
    /invalid/
  );
  await assert.rejects(
    executeLocalCapability(
      { comfyUiUrl: "http://127.0.0.1:8188" },
      discovery,
      { capability: "comfyui:image", payload: { workflow: { "1": { class_type: "SaveImage" } } } },
      {
        resolveHost: async () => ["127.0.0.1"],
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      }
    ),
    /artifact upload protocol/
  );
  assert.equal(calls, 0);
});

test("rejects unavailable capabilities and oversized request payloads before network access", async () => {
  let calls = 0;
  const dependencies = {
    resolveHost: async () => ["127.0.0.1"],
    fetch: async () => {
      calls += 1;
      return Response.json({});
    },
  };
  await assert.rejects(
    executeLocalCapability(
      { ollamaUrl: "http://127.0.0.1:11434" },
      discovery,
      {
        capability: "ollama:chat:missing",
        payload: { messages: [{ role: "user", content: "x" }] },
      },
      dependencies
    ),
    /unavailable/
  );
  await assert.rejects(
    executeLocalCapability(
      { ollamaUrl: "http://127.0.0.1:11434" },
      discovery,
      {
        capability: "ollama:chat:qwen2.5:7b",
        payload: { messages: [{ role: "user", content: "x".repeat(70_000) }] },
      },
      dependencies
    ),
    /size limit/
  );
  assert.equal(calls, 0);
});

test("rejects unsupported Ollama fields and refuses the old ComfyUI graph API", async () => {
  await assert.rejects(
    executeLocalCapability(
      { ollamaUrl: "http://127.0.0.1:11434" },
      discovery,
      {
        capability: "ollama:chat:qwen2.5:7b",
        payload: { model: "attacker-selected", messages: [{ role: "user", content: "x" }] },
      },
      { resolveHost: async () => ["127.0.0.1"], fetch: async () => Response.json({}) }
    ),
    /unsupported fields/
  );
  await assert.rejects(
    executeLocalCapability(
      { comfyUiUrl: "http://127.0.0.1:8188" },
      discovery,
      { capability: "comfyui:image", payload: { workflow: {} } },
      { resolveHost: async () => ["127.0.0.1"], fetch: async () => Response.json({}) }
    ),
    /artifact upload protocol/
  );
});

test("rejects unsafe ComfyUI output metadata and image payloads above the gateway bound", async () => {
  const common = imageJob;
  await assert.rejects(
    executeLocalComfyUiImageJob(
      { comfyUiUrl: "http://127.0.0.1:8188" },
      discovery,
      common,
      {
        resolveHost: async () => ["127.0.0.1"],
        fetch: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/prompt")) return Response.json({ prompt_id: "job_123" });
          return Response.json({
            job_123: {
              status: { completed: true, status_str: "success" },
              outputs: {
                "9": { images: [{ filename: "../x.png", subfolder: "", type: "output" }] },
              },
            },
          });
        },
      },
      async () => "running"
    ),
    /completed without safe image output metadata/
  );

  await assert.rejects(
    executeLocalComfyUiImageJob(
      { comfyUiUrl: "http://127.0.0.1:8188" },
      discovery,
      common,
      {
        resolveHost: async () => ["127.0.0.1"],
        fetch: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/prompt")) return Response.json({ prompt_id: "job_123" });
          if (url.pathname.endsWith("/history/job_123")) {
            return Response.json({
              job_123: {
                outputs: {
                  "9": { images: [{ filename: "result.png", subfolder: "", type: "output" }] },
                },
              },
            });
          }
          return new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
            headers: { "content-type": "image/png" },
          });
        },
      },
      async () => "running"
    ),
    /exceeds the size limit/
  );
});

test("stops a ComfyUI image job on cancellation without polling or fetching an artifact", async () => {
  const requestedPaths: string[] = [];
  let controls = 0;
  await assert.rejects(
    executeLocalComfyUiImageJob(
      { comfyUiUrl: "http://127.0.0.1:8188" },
      discovery,
      imageJob,
      {
        resolveHost: async () => ["127.0.0.1"],
        fetch: async (input) => {
          requestedPaths.push(new URL(String(input)).pathname);
          if (new URL(String(input)).pathname.endsWith("/prompt")) {
            return Response.json({ prompt_id: "cancelled_job" });
          }
          return Response.json({ cancelled_job: { status: { completed: false } } });
        },
      },
      async () => (++controls === 1 ? "running" : "cancelled")
    ),
    /image job cancelled/
  );
  assert.deepEqual(requestedPaths, ["/prompt"]);
});

test("throttles ComfyUI job-control checks while polling local generation", async () => {
  let controls = 0;
  let historyCalls = 0;
  await executeLocalComfyUiImageJob(
    { comfyUiUrl: "http://127.0.0.1:8188" },
    discovery,
    imageJob,
    {
      resolveHost: async () => ["127.0.0.1"],
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/prompt") return Response.json({ prompt_id: "throttled_job" });
        if (url.pathname === "/history/throttled_job") {
          historyCalls += 1;
          const completed = historyCalls >= 7;
          return Response.json({
            throttled_job: {
              status: { completed, status_str: completed ? "success" : "running" },
              outputs: completed
                ? {
                    "7": {
                      images: [{ filename: "result.png", subfolder: "", type: "output" }],
                    },
                  }
                : {},
            },
          });
        }
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
          headers: { "content-type": "image/png" },
        });
      },
    },
    async () => {
      controls += 1;
      return "running";
    }
  );
  assert.equal(historyCalls, 7);
  assert.ok(controls <= 5, `expected throttled checks, got ${controls} for ${historyCalls} polls`);
});

test("surfaces a ComfyUI workflow error instead of polling until timeout", async () => {
  const requestedPaths: string[] = [];
  await assert.rejects(
    executeLocalComfyUiImageJob(
      { comfyUiUrl: "http://127.0.0.1:8188" },
      discovery,
      imageJob,
      {
        resolveHost: async () => ["127.0.0.1"],
        fetch: async (input) => {
          const url = new URL(String(input));
          requestedPaths.push(url.pathname);
          if (url.pathname.endsWith("/prompt")) return Response.json({ prompt_id: "job_123" });
          return Response.json({
            job_123: {
              status: { completed: true, status_str: "error" },
              outputs: {},
            },
          });
        },
      },
      async () => "running"
    ),
    /workflow execution failed/
  );
  assert.deepEqual(requestedPaths, ["/prompt", "/history/job_123"]);
});

test("projects oversized Ollama output below the gateway result limit", async () => {
  const result = await executeLocalCapability(
    { ollamaUrl: "http://127.0.0.1:11434" },
    discovery,
    {
      capability: "ollama:chat:qwen2.5:7b",
      payload: { messages: [{ role: "user", content: "hello" }] },
    },
    {
      resolveHost: async () => ["127.0.0.1"],
      fetch: async () =>
        Response.json({
          model: "qwen2.5:7b",
          message: { role: "assistant", content: '😀\\"'.repeat(30_000) },
          done: true,
          eval_count: 42,
        }),
    }
  );

  const serialized = JSON.stringify({
    version: 1,
    requestId: "r".repeat(128),
    outcome: { ok: true, value: result },
  });
  assert.ok(new TextEncoder().encode(serialized).byteLength <= 64 * 1024);
  assert.equal((result as { truncated?: boolean }).truncated, true);
  assert.ok(
    (result as { message: { content: string } }).message.content.endsWith(
      "[local agent result truncated]"
    )
  );
});
