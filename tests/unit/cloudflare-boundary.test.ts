import test from "node:test";
import assert from "node:assert/strict";
import { createCloudRuntime } from "../../src/cloud/runtime";

test("cloud runtime exposes a Worker-safe health endpoint", async () => {
  const runtime = createCloudRuntime({
    env: { OMNIROUTE_ENV: "test", OMNIROUTE_BUILD_SHA: "test-sha" },
    now: () => new Date("2026-10-07T00:00:00.000Z"),
  });

  const response = await runtime.fetch(new Request("https://omniroute.test/__cloud/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    runtime: "cloudflare",
    timestamp: "2026-10-07T00:00:00.000Z",
  });
});

test("cloud runtime reports an unconfigured D1 binding safely", async () => {
  const runtime = createCloudRuntime({ now: () => new Date("2026-10-07T00:00:00.000Z") });
  const response = await runtime.fetch(new Request("https://omniroute.test/__cloud/db"));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "unconfigured",
    runtime: "cloudflare",
    database: "d1",
  });
});

test("cloud runtime reports a healthy D1 binding", async () => {
  const runtime = createCloudRuntime({
    env: {
      DB: {
        prepare: () => ({
          bind() {
            return this;
          },
          async first() {
            return { ok: 1 };
          },
          async all() {
            return { results: [], success: true };
          },
          async run() {
            return { success: true };
          },
        }),
        async batch() {
          return [];
        },
        async exec() {
          return undefined;
        },
      },
    },
  });
  const response = await runtime.fetch(new Request("https://omniroute.test/__cloud/db"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    runtime: "cloudflare",
    database: "d1",
  });
});

test("cloud runtime exposes build/runtime metadata without Node dependencies", async () => {
  const runtime = createCloudRuntime({
    env: { OMNIROUTE_ENV: "staging", OMNIROUTE_BUILD_SHA: "abc123" },
  });

  const response = await runtime.fetch(new Request("https://omniroute.test/__cloud/runtime"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    runtime: "cloudflare",
    environment: "staging",
    buildSha: "abc123",
  });
});
