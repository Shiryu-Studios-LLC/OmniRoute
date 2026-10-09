import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const enabled = process.env.RUN_CLOUDFLARE_LOCAL_INT === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const adminToken = "local-inference-integration-admin-token-only";
const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)));
const idempotencyKeySecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(23)));
const mockProviderKey = "sk-cloudflare-local-inference-fixture";
const model = "gpt-4o-mini-2024-07-18";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getUnusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function requestJson(
  url: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    assert.fail(
      `Expected JSON from ${url}; received HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }
  assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
  return { response, body: body as Record<string, unknown> };
}

async function waitForWorker(
  baseUrl: string,
  child: ChildProcess,
  logs: () => string,
  timeoutMs = 45_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      assert.fail(`Wrangler exited before becoming ready (code ${child.exitCode}):\n${logs()}`);
    }
    try {
      if ((await fetch(`${baseUrl}/__cloud/health`, { signal: AbortSignal.timeout(1_000) })).ok) {
        return;
      }
    } catch {
      // Wrangler may still be bundling or starting its local workerd process.
    }
    await delay(250);
  }
  assert.fail(`Wrangler did not become ready within ${timeoutMs}ms:\n${logs()}`);
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

function decodeSseFrames(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return data;
    });
}

test(
  "local Wrangler streams customer inference through D1 and replays without another provider dispatch",
  {
    skip:
      !enabled && "Set RUN_CLOUDFLARE_LOCAL_INT=1 to run the local Wrangler inference integration.",
    timeout: 120_000,
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "omniroute-cloudflare-inference-int-"));
    const homeDir = path.join(tempDir, "home");
    const persistDir = path.join(tempDir, "wrangler-state");
    await mkdir(homeDir, { recursive: true });

    const workerName = `omniroute-inference-int-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const wranglerConfigPath = path.join(tempDir, "wrangler.jsonc");
    const safeEnvPath = path.join(tempDir, "local.env");
    const baseUrl = `http://127.0.0.1:${await getUnusedPort()}`;
    const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
    const workerEntry = path.join(
      repoRoot,
      "tests",
      "fixtures",
      "cloudflare-inference-mock-worker.ts"
    );
    const migrationsDir = path.join(repoRoot, "cloudflare", "migrations");
    const vars = [
      `OMNIROUTE_CLOUD_ADMIN_TOKEN=${adminToken}`,
      `OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY=${encryptionKey}`,
      `OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY=${idempotencyKeySecret}`,
      "OMNIROUTE_ENV=local-integration",
    ].join("\n");
    await writeFile(path.join(tempDir, ".dev.vars"), `${vars}\n`, { mode: 0o600 });
    await writeFile(path.join(tempDir, ".env"), `${vars}\n`, { mode: 0o600 });
    await writeFile(safeEnvPath, `${vars}\n`, { mode: 0o600 });
    await writeFile(
      wranglerConfigPath,
      JSON.stringify(
        {
          name: workerName,
          main: workerEntry,
          compatibility_date: "2026-10-08",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: workerName,
              migrations_dir: migrationsDir,
            },
          ],
          durable_objects: {
            bindings: [{ name: "GATEWAY_SESSIONS", class_name: "GatewaySessionObject" }],
          },
          migrations: [{ tag: "v1", new_sqlite_classes: ["GatewaySessionObject"] }],
        },
        null,
        2
      ) + "\n",
      { mode: 0o600 }
    );

    const commandEnv = {
      PATH: process.env.PATH ?? "",
      HOME: homeDir,
      TMPDIR: tempDir,
      NODE_ENV: "test",
      NO_COLOR: "1",
      CI: "1",
    };
    const migrationResult = spawnSync(
      process.execPath,
      [
        wranglerBin,
        "d1",
        "migrations",
        "apply",
        workerName,
        "--local",
        "--persist-to",
        persistDir,
        "--config",
        wranglerConfigPath,
        "--env-file",
        safeEnvPath,
      ],
      {
        cwd: tempDir,
        env: commandEnv,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    assert.equal(
      migrationResult.status,
      0,
      `local D1 migrations failed:\n${migrationResult.stdout}\n${migrationResult.stderr}`
    );

    const fixtureSchemaResult = spawnSync(
      process.execPath,
      [
        wranglerBin,
        "d1",
        "execute",
        workerName,
        "--local",
        "--persist-to",
        persistDir,
        "--config",
        wranglerConfigPath,
        "--env-file",
        safeEnvPath,
        "--yes",
        "--command",
        "CREATE TABLE cloud_test_mock_provider_calls (id TEXT PRIMARY KEY, call_count INTEGER NOT NULL, last_error TEXT, fail_generation_count INTEGER NOT NULL DEFAULT 0); INSERT INTO cloud_test_mock_provider_calls (id, call_count, last_error, fail_generation_count) VALUES ('inference', 0, NULL, 0);",
      ],
      {
        cwd: tempDir,
        env: commandEnv,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      }
    );
    assert.equal(
      fixtureSchemaResult.status,
      0,
      `local mock-provider fixture setup failed:\n${fixtureSchemaResult.stdout}\n${fixtureSchemaResult.stderr}`
    );

    const startWorker = () =>
      spawn(
        process.execPath,
        [
          wranglerBin,
          "dev",
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          new URL(baseUrl).port,
          "--persist-to",
          persistDir,
          "--config",
          wranglerConfigPath,
          "--env-file",
          safeEnvPath,
          "--show-interactive-dev-session=false",
        ],
        {
          cwd: tempDir,
          env: commandEnv,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
    let child = startWorker();
    let output = "";
    const appendOutput = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-30_000);
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    t.after(async () => {
      await stopWorker(child);
      await rm(tempDir, { recursive: true, force: true });
    });

    await waitForWorker(baseUrl, child, () => output);
    const health = await requestJson(`${baseUrl}/__cloud/health`);
    assert.equal(health.response.status, 200);
    const database = await requestJson(`${baseUrl}/__cloud/db`);
    assert.equal(database.response.status, 200);

    const tenantId = `inference-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const tenant = await requestJson(`${baseUrl}/__cloud/v1/tenants`, {
      token: adminToken,
      body: {
        id: tenantId,
        name: "Local Inference Integration",
        slug: tenantId,
        ownerPrincipalId: `principal-${tenantId}`,
      },
    });
    assert.equal(tenant.response.status, 201, JSON.stringify(tenant.body));
    const customerKey = String(tenant.body.ownerApiKey.token);
    assert.match(customerKey, /^orc_live_/);

    const entitlement = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/${tenantId}/inference-entitlements`,
      {
        method: "PUT",
        token: adminToken,
        body: {
          provider: "openai",
          model,
          enabled: true,
          maxInputTokens: 100,
          maxOutputTokens: 40,
        },
      }
    );
    assert.equal(entitlement.response.status, 200, JSON.stringify(entitlement.body));
    const budget = await requestJson(`${baseUrl}/__cloud/v1/tenants/${tenantId}/inference-budget`, {
      method: "PUT",
      token: adminToken,
      body: { monthlyTokenLimit: 1000 },
    });
    assert.equal(budget.response.status, 200, JSON.stringify(budget.body));
    const connection = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/${tenantId}/provider-connections`,
      {
        token: adminToken,
        body: { id: "mock-openai", provider: "openai", apiKey: mockProviderKey },
      }
    );
    assert.equal(connection.response.status, 201, JSON.stringify(connection.body));

    const idempotencyKey = `cloud-local-inference-${crypto.randomUUID()}`;
    const inferenceRequest = (requestIdempotencyKey = idempotencyKey, bearerToken = customerKey) =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
          "idempotency-key": requestIdempotencyKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hello from the local inference integration" }],
          stream: true,
        }),
        signal: AbortSignal.timeout(20_000),
      });

    const firstResponse = await inferenceRequest();
    const mockState = await requestJson(`${baseUrl}/__test/mock-provider/stats`, {
      token: adminToken,
    });
    assert.equal(
      firstResponse.status,
      200,
      `${await firstResponse.clone().text()}\nmock=${JSON.stringify(mockState.body)}\n${output}`
    );
    assert.match(firstResponse.headers.get("content-type") ?? "", /^text\/event-stream/);
    const requestId = firstResponse.headers.get("x-request-id");
    assert.ok(requestId);
    const firstText = await firstResponse.text();
    const frames = decodeSseFrames(firstText);
    assert.equal(frames.at(-1), "[DONE]");
    const payloads = frames
      .slice(0, -1)
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
    const deltas = payloads.flatMap((payload) => {
      const choices = payload.choices;
      if (!Array.isArray(choices)) return [];
      const choice = choices[0] as { delta?: { content?: unknown } } | undefined;
      return typeof choice?.delta?.content === "string" ? [choice.delta.content] : [];
    });
    assert.deepEqual(
      deltas,
      ["Hello from the ", "local mock provider."],
      "the customer response should preserve separate upstream SSE deltas"
    );
    assert.ok(
      payloads.some((payload) => {
        const choices = payload.choices;
        return (
          Array.isArray(choices) &&
          (choices[0] as { delta?: { role?: string } })?.delta?.role === "assistant"
        );
      })
    );
    assert.equal(firstText.includes(mockProviderKey), false);
    assert.equal(firstText.includes("hello from the local inference integration"), false);

    assert.equal(mockState.response.status, 200);
    assert.equal(
      mockState.body.callCount,
      2,
      "one count plus one generation dispatch should occur"
    );
    assert.equal(
      mockState.body.lastError,
      null,
      "both fixed mock upstream calls should be accepted"
    );

    const state = await requestJson(
      `${baseUrl}/__test/inference/state?tenantId=${encodeURIComponent(tenantId)}`,
      { token: adminToken }
    );
    assert.equal(state.response.status, 200);
    const usage = state.body.usage as Array<Record<string, unknown>>;
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.tokens_input, 5);
    assert.equal(usage[0]?.tokens_output, 6);
    assert.equal(usage[0]?.status, "success");
    assert.equal(usage[0]?.success, 1);
    assert.equal(usage[0]?.endpoint, "/v1/chat/completions");
    const reservations = state.body.reservations as Array<Record<string, unknown>>;
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0]?.reservation_id, requestId);
    assert.equal(reservations[0]?.input_tokens, 5);
    assert.equal(reservations[0]?.output_tokens_reserved, 40);
    assert.equal(reservations[0]?.actual_input_tokens, 5);
    assert.equal(reservations[0]?.actual_output_tokens, 6);
    assert.equal(reservations[0]?.status, "settled");
    const audits = state.body.audits as Array<Record<string, unknown>>;
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, "cloud.inference.chat.completions");
    assert.equal(audits[0]?.status, "success");
    assert.equal(String(audits[0]?.metadata_json).includes(mockProviderKey), false);
    assert.equal(
      String(audits[0]?.metadata_json).includes("hello from the local inference integration"),
      false
    );

    // The idempotency record and streamed transcript live in D1, so a Worker
    // restart must not turn a completed request into a second provider call.
    await stopWorker(child);
    child = startWorker();
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    await waitForWorker(baseUrl, child, () => output);

    const replayResponse = await inferenceRequest();
    assert.equal(replayResponse.status, 200);
    assert.match(replayResponse.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(replayResponse.headers.get("x-request-id"), requestId);
    assert.equal(
      await replayResponse.text(),
      firstText,
      "replay should return the exact stored SSE transcript"
    );
    const replayState = await requestJson(`${baseUrl}/__test/mock-provider/stats`, {
      token: adminToken,
    });
    assert.equal(replayState.body.callCount, 2, "idempotent replay must not redispatch upstream");
    const finalState = await requestJson(
      `${baseUrl}/__test/inference/state?tenantId=${encodeURIComponent(tenantId)}`,
      { token: adminToken }
    );
    assert.equal((finalState.body.usage as unknown[]).length, 1);
    assert.equal((finalState.body.reservations as unknown[]).length, 1);
    assert.equal((finalState.body.audits as unknown[]).length, 1);

    // Idempotency identity is tenant-scoped. A second customer can use the
    // same client key without replaying tenant A's transcript or request ID.
    const tenantBId = `inference-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const tenantB = await requestJson(`${baseUrl}/__cloud/v1/tenants`, {
      token: adminToken,
      body: {
        id: tenantBId,
        name: "Local Inference Integration B",
        slug: tenantBId,
        ownerPrincipalId: `principal-${tenantBId}`,
      },
    });
    assert.equal(tenantB.response.status, 201, JSON.stringify(tenantB.body));
    const customerBKey = String(tenantB.body.ownerApiKey.token);
    assert.match(customerBKey, /^orc_live_/);
    const tenantBEntitlement = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/${tenantBId}/inference-entitlements`,
      {
        method: "PUT",
        token: adminToken,
        body: {
          provider: "openai",
          model,
          enabled: true,
          maxInputTokens: 100,
          maxOutputTokens: 40,
        },
      }
    );
    assert.equal(tenantBEntitlement.response.status, 200, JSON.stringify(tenantBEntitlement.body));
    const tenantBBudget = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/${tenantBId}/inference-budget`,
      {
        method: "PUT",
        token: adminToken,
        body: { monthlyTokenLimit: 1000 },
      }
    );
    assert.equal(tenantBBudget.response.status, 200, JSON.stringify(tenantBBudget.body));
    const tenantBConnection = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/${tenantBId}/provider-connections`,
      {
        token: adminToken,
        body: { id: "mock-openai", provider: "openai", apiKey: mockProviderKey },
      }
    );
    assert.equal(tenantBConnection.response.status, 201, JSON.stringify(tenantBConnection.body));

    const tenantBResponse = await inferenceRequest(idempotencyKey, customerBKey);
    assert.equal(
      tenantBResponse.status,
      200,
      `tenant B should dispatch its own request for the same idempotency key:\n${await tenantBResponse
        .clone()
        .text()}\n${output}`
    );
    const tenantBRequestId = tenantBResponse.headers.get("x-request-id");
    assert.ok(tenantBRequestId);
    assert.notEqual(tenantBRequestId, requestId);
    assert.equal(
      (await tenantBResponse.text()).includes("local mock provider."),
      true,
      "tenant B must receive its own provider result instead of tenant A's replay"
    );
    const tenantBState = await requestJson(
      `${baseUrl}/__test/inference/state?tenantId=${encodeURIComponent(tenantBId)}`,
      { token: adminToken }
    );
    assert.equal(tenantBState.response.status, 200);
    assert.equal((tenantBState.body.usage as unknown[]).length, 1);
    assert.equal(
      (tenantBState.body.reservations as Array<Record<string, unknown>>)[0]?.reservation_id,
      tenantBRequestId
    );
    const afterTenantBStats = await requestJson(`${baseUrl}/__test/mock-provider/stats`, {
      token: adminToken,
    });
    assert.equal(
      afterTenantBStats.body.callCount,
      4,
      "tenant B should make its own count and generation calls"
    );

    const tenantAReplayAfterB = await inferenceRequest(idempotencyKey, customerKey);
    assert.equal(tenantAReplayAfterB.status, 200);
    assert.equal(tenantAReplayAfterB.headers.get("x-request-id"), requestId);
    assert.equal(await tenantAReplayAfterB.text(), firstText);
    const afterTenantAReplayStats = await requestJson(`${baseUrl}/__test/mock-provider/stats`, {
      token: adminToken,
    });
    assert.equal(
      afterTenantAReplayStats.body.callCount,
      4,
      "tenant A replay must remain isolated from B"
    );

    const armFailure = spawnSync(
      process.execPath,
      [
        wranglerBin,
        "d1",
        "execute",
        workerName,
        "--local",
        "--persist-to",
        persistDir,
        "--config",
        wranglerConfigPath,
        "--env-file",
        safeEnvPath,
        "--yes",
        "--command",
        "UPDATE cloud_test_mock_provider_calls SET fail_generation_count = 1 WHERE id = 'inference';",
      ],
      {
        cwd: tempDir,
        env: commandEnv,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      }
    );
    assert.equal(armFailure.status, 0, `failed to arm upstream fixture:\n${armFailure.stderr}`);

    const failedKey = `cloud-local-inference-failure-${crypto.randomUUID()}`;
    const failedResponse = await inferenceRequest(failedKey);
    assert.equal(
      failedResponse.status,
      502,
      `a provider failure should fail closed:\n${await failedResponse.text()}\n${output}`
    );
    const afterFailureStats = await requestJson(`${baseUrl}/__test/mock-provider/stats`, {
      token: adminToken,
    });
    assert.equal(
      afterFailureStats.body.callCount,
      6,
      "count and failed generation each dispatch once"
    );
    assert.equal(afterFailureStats.body.lastError, "simulated upstream generation failure");

    const failedReplay = await inferenceRequest(failedKey);
    assert.equal(failedReplay.status, 503, "an uncertain failure must not redispatch on same key");
    const afterFailedReplayStats = await requestJson(`${baseUrl}/__test/mock-provider/stats`, {
      token: adminToken,
    });
    assert.equal(afterFailedReplayStats.body.callCount, 6, "failure replay must not call upstream");

    const recoveredKey = `cloud-local-inference-recovery-${crypto.randomUUID()}`;
    const recoveredResponse = await inferenceRequest(recoveredKey);
    assert.equal(
      recoveredResponse.status,
      200,
      `a new request should succeed after the provider recovers:\n${await recoveredResponse
        .clone()
        .text()}\n${output}`
    );
    assert.equal((await recoveredResponse.text()).includes("local mock provider."), true);
    const recoveredStats = await requestJson(`${baseUrl}/__test/mock-provider/stats`, {
      token: adminToken,
    });
    assert.equal(
      recoveredStats.body.callCount,
      8,
      "recovery should dispatch one count and generation"
    );
    assert.equal(recoveredStats.body.lastError, null);
  }
);
