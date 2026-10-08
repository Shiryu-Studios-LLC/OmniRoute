import test from "node:test";
import assert from "node:assert/strict";
import type { GatewayCoordinatorStub } from "../../src/cloud/connectorGatewayDurableObject";
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

test("cloud runtime readiness requires D1 and Durable Object storage", async () => {
  let doProbeCount = 0;
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
      GATEWAY_SESSIONS: {
        idFromName: (name) => name,
        get: () =>
          ({
            async checkReadiness() {
              doProbeCount += 1;
            },
          }) as GatewayCoordinatorStub,
      },
    },
  });

  const response = await runtime.fetch(new Request("https://omniroute.test/__cloud/readiness"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ready",
    runtime: "cloudflare",
    checks: { database: "ok", gateway: "ok" },
  });
  assert.equal(doProbeCount, 1);
});

test("cloud runtime readiness fails closed for missing or failing dependencies", async () => {
  const unconfigured = createCloudRuntime();
  const unconfiguredResponse = await unconfigured.fetch(
    new Request("https://omniroute.test/__cloud/readiness")
  );
  assert.equal(unconfiguredResponse.status, 503);
  assert.deepEqual(await unconfiguredResponse.json(), {
    status: "not_ready",
    runtime: "cloudflare",
    checks: { database: "unconfigured", gateway: "unconfigured" },
  });

  const failing = createCloudRuntime({
    env: {
      DB: {
        prepare: () => ({
          bind() {
            return this;
          },
          async first() {
            throw new Error("internal database details");
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
      GATEWAY_SESSIONS: {
        idFromName: (name) => name,
        get: () =>
          ({
            async checkReadiness() {
              throw new Error("internal Durable Object details");
            },
          }) as GatewayCoordinatorStub,
      },
    },
  });
  const failingResponse = await failing.fetch(
    new Request("https://omniroute.test/__cloud/readiness")
  );
  assert.equal(failingResponse.status, 503);
  const failingBody = await failingResponse.text();
  assert.match(failingBody, /"database":"error"/);
  assert.match(failingBody, /"gateway":"error"/);
  assert.doesNotMatch(failingBody, /internal database details|internal Durable Object details/);
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
