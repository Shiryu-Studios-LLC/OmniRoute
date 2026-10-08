import assert from "node:assert/strict";
import { test } from "node:test";
import { executeLocalCapability } from "../../src/lib/localAgent/capabilityExecutor";
import type { LocalDiscoveryResult } from "../../src/lib/localAgent/localDiscovery";

const discovery: LocalDiscoveryResult = {
  heartbeat: {
    status: "online",
    capabilities: ["ollama:chat:qwen2.5:7b", "comfyui:image"],
  },
  services: [
    { service: "ollama", reachable: true, models: ["qwen2.5:7b"] },
    { service: "comfyui", reachable: true, models: ["sdxl.safetensors"] },
  ],
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

test("polls a bounded ComfyUI workflow and retrieves its completed image output", async () => {
  const requestedUrls: string[] = [];
  let requestedBody: Record<string, unknown> | null = null;
  let historyCalls = 0;
  const result = await executeLocalCapability(
    { comfyUiUrl: "http://127.0.0.1:8188" },
    discovery,
    { capability: "comfyui:image", payload: { workflow: { "1": { class_type: "SaveImage" } } } },
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
          historyCalls += 1;
          return Response.json(
            historyCalls === 1
              ? {}
              : {
                  job_123: {
                    outputs: {
                      "9": {
                        images: [{ filename: "result.png", subfolder: "", type: "output" }],
                      },
                    },
                  },
                }
          );
        }
        assert.equal(url.pathname, "/view");
        assert.equal(url.searchParams.get("filename"), "result.png");
        assert.equal(url.searchParams.get("type"), "output");
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      },
    }
  );

  assert.equal(requestedUrls[0], "http://127.0.0.1:8188/prompt");
  assert.deepEqual(requestedBody, { prompt: { "1": { class_type: "SaveImage" } } });
  assert.equal(historyCalls, 2);
  assert.deepEqual(result, {
    promptId: "job_123",
    images: [{ filename: "result.png", contentType: "image/png", data: "AQID" }],
  });
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

test("rejects unsupported Ollama fields and invalid ComfyUI responses", async () => {
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
    /invalid prompt identifier/
  );
});

test("rejects unsafe ComfyUI output metadata and image payloads above the gateway bound", async () => {
  const common = {
    capability: "comfyui:image",
    payload: { workflow: { "1": { class_type: "SaveImage" } } },
  };
  await assert.rejects(
    executeLocalCapability({ comfyUiUrl: "http://127.0.0.1:8188" }, discovery, common, {
      resolveHost: async () => ["127.0.0.1"],
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/prompt")) return Response.json({ prompt_id: "job_123" });
        return Response.json({
          job_123: {
            outputs: { "9": { images: [{ filename: "../x.png", subfolder: "", type: "output" }] } },
          },
        });
      },
    }),
    /no safe image output metadata/
  );

  await assert.rejects(
    executeLocalCapability({ comfyUiUrl: "http://127.0.0.1:8188" }, discovery, common, {
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
        return new Response(new Uint8Array(40 * 1024 + 1), {
          headers: { "content-type": "image/png" },
        });
      },
    }),
    /exceeds the size limit/
  );
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
