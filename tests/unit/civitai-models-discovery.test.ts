import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-civitai-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsRoute = await import("../../src/app/api/providers/[id]/models/route.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("civitai model import fetches the live civitai.red catalog even when auto-fetch is not enabled", async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const connection = await providersDb.createProviderConnection({
    provider: "civitai",
    authType: "apikey",
    name: "civitai-live",
    apiKey: "civitai-test-key",
  });

  const requested: Array<{ url: string; authorization?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    requested.push({
      url: String(url),
      authorization: headers.get("authorization") ?? undefined,
    });

    return Response.json({
      items: [
        { id: 257749, name: "Pony Diffusion V6 XL", type: "Checkpoint" },
        { id: 332111, name: "Styles of Models for Pony Diffusion V6 XL", type: "LORA" },
      ],
      metadata: { currentPage: 1, pageSize: 100 },
    });
  };

  try {
    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models?chatOnly=true`),
      { params: { id: connection.id } }
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      provider: string;
      source: string;
      catalogMode?: string;
      models: Array<{ id: string; name: string; supportedEndpoints?: string[] }>;
    };

    assert.equal(body.provider, "civitai");
    assert.equal(body.source, "api");
    assert.equal(body.catalogMode, "civitai_models");
    assert.deepEqual(
      body.models.map((model) => [model.id, model.name]),
      [
        ["257749", "Pony Diffusion V6 XL"],
        ["332111", "Styles of Models for Pony Diffusion V6 XL"],
      ]
    );
    assert.deepEqual(body.models[0]?.supportedEndpoints, ["images"]);
    assert.equal(requested.length, 1);
    assert.equal(
      requested[0]?.url,
      "https://civitai.red/api/v1/models?limit=100",
      "Civitai discovery must use civitai.red"
    );
    assert.equal(requested[0]?.authorization, "Bearer civitai-test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("civitai supports cursor pagination and search without replacing the synced catalog", async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const connection = await providersDb.createProviderConnection({
    provider: "civitai",
    authType: "apikey",
    name: "civitai-search",
    apiKey: "civitai-test-key",
  });

  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return Response.json({
      items: [{ id: 372465, name: "Pony Realism" }],
      metadata: {
        nextCursor: "2",
        nextPage: "https://civitai.red/api/v1/models?limit=1&query=Pony&cursor=2",
      },
    });
  };

  try {
    const response = await modelsRoute.GET(
      new Request(
        `http://localhost/api/providers/${connection.id}/models?query=Pony&limit=1&cursor=1`
      ),
      { params: { id: connection.id } }
    );
    const body = (await response.json()) as {
      catalogScope?: string;
      nextCursor?: string;
      nextPage?: string;
      models?: Array<{ id: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.catalogScope, "on_demand");
    assert.equal(body.nextCursor, "2");
    assert.equal(body.nextPage, "https://civitai.red/api/v1/models?limit=1&query=Pony&cursor=2");
    assert.deepEqual(
      body.models?.map((m) => m.id),
      ["372465"]
    );
    assert.equal(requested.length, 1);
    assert.match(requested[0], /https:\/\/civitai\.red\/api\/v1\/models\?/);
    assert.match(requested[0], /limit=1/);
    assert.match(requested[0], /query=Pony/);
    assert.match(requested[0], /cursor=1/);

    const persisted = await import("../../src/lib/db/models.ts");
    const synced = await persisted.getSyncedAvailableModels("civitai");
    assert.equal(synced.length, 0, "on-demand search must not replace the synced catalog");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("civitai can look up an exact model id outside the first 100 results", async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const connection = await providersDb.createProviderConnection({
    provider: "civitai",
    authType: "apikey",
    name: "civitai-lookup",
    apiKey: "civitai-test-key",
  });

  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return Response.json({ id: 999999, name: "A Model Beyond The First Page", type: "Checkpoint" });
  };

  try {
    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models?modelId=999999`),
      { params: { id: connection.id } }
    );
    const body = (await response.json()) as {
      catalogMode?: string;
      catalogScope?: string;
      models?: Array<{
        id: string;
        name: string;
        owned_by: string;
        modelType: string;
        supportedEndpoints: string[];
      }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.catalogMode, "civitai_model_lookup");
    assert.equal(body.catalogScope, "on_demand");
    assert.deepEqual(body.models, [
      {
        id: "999999",
        name: "A Model Beyond The First Page",
        owned_by: "civitai",
        modelType: "Checkpoint",
        supportedEndpoints: ["images"],
      },
    ]);
    assert.equal(
      requested[0],
      "https://civitai.red/api/v1/models/999999",
      "exact lookup must stay on civitai.red"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("civitai model import falls back to the local catalog when civitai.red is unavailable", async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const connection = await providersDb.createProviderConnection({
    provider: "civitai",
    authType: "apikey",
    name: "civitai-fallback",
    apiKey: "",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });

  try {
    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models`),
      { params: { id: connection.id } }
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      provider: string;
      source: string;
      models: Array<{ id: string }>;
    };

    assert.equal(body.provider, "civitai");
    assert.equal(body.source, "local_catalog");
    assert.ok(body.models.some((model) => model.id === "Checkpoint"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
