import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHttpLocalAgentGatewayTransport } from "../../src/lib/localAgent/httpGatewayTransport.js";

const enabled = process.env.RUN_CLOUDFLARE_LOCAL_INT === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const adminToken = "local-integration-admin-token-only";
const capability = "ollama:chat:integration-test";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getUnusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
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
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
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
      const response = await fetch(`${baseUrl}/__cloud/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
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

test(
  "local Wrangler Worker completes and replays a tenant gateway invocation through D1 and a Durable Object",
  { skip: !enabled && "Set RUN_CLOUDFLARE_LOCAL_INT=1 to run the local Wrangler integration." },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "omniroute-cloudflare-local-int-"));
    const homeDir = path.join(tempDir, "home");
    const persistDir = path.join(tempDir, "wrangler-state");
    await mkdir(homeDir, { recursive: true });

    const workerName = `omniroute-local-int-${process.pid}-${randomUUID().slice(0, 8)}`;
    const wranglerConfigPath = path.join(tempDir, "wrangler.jsonc");
    const safeEnvPath = path.join(tempDir, "local.env");
    const baseUrl = `http://127.0.0.1:${await getUnusedPort()}`;
    const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
    const workerEntry = path.join(repoRoot, "cloudflare", "worker.ts");
    const migrationsDir = path.join(repoRoot, "cloudflare", "migrations");

    // Wrangler loads .env from its project root. Run it from this temporary root
    // and put only a throwaway control-plane token in the explicitly selected env.
    await writeFile(path.join(tempDir, ".env"), `OMNIROUTE_CLOUD_ADMIN_TOKEN=${adminToken}\n`, {
      mode: 0o600,
    });
    await writeFile(path.join(tempDir, ".dev.vars"), "", { mode: 0o600 });
    await writeFile(safeEnvPath, `OMNIROUTE_CLOUD_ADMIN_TOKEN=${adminToken}\n`, { mode: 0o600 });
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

    // Local D1 migrations are an explicit Wrangler operation; `wrangler dev`
    // binds the database but does not apply its migration directory for us.
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
        env: {
          PATH: process.env.PATH ?? "",
          HOME: homeDir,
          TMPDIR: tempDir,
          NODE_ENV: "test",
          NO_COLOR: "1",
          CI: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    assert.equal(
      migrationResult.status,
      0,
      `local D1 migrations failed:\n${migrationResult.stdout}\n${migrationResult.stderr}`
    );

    const child = spawn(
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
        env: {
          PATH: process.env.PATH ?? "",
          HOME: homeDir,
          TMPDIR: tempDir,
          NODE_ENV: "test",
          NO_COLOR: "1",
          CI: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
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
    assert.equal(health.body.status, "ok");
    const database = await requestJson(`${baseUrl}/__cloud/db`);
    assert.equal(database.response.status, 200);
    assert.equal(database.body.database, "d1");

    const tenantId = `local-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const tenantResult = await requestJson(`${baseUrl}/__cloud/v1/tenants`, {
      token: adminToken,
      body: { id: tenantId, name: "Local Integration Tenant", slug: tenantId },
    });
    assert.equal(
      tenantResult.response.status,
      201,
      `tenant provisioning failed: ${JSON.stringify(tenantResult.body)}\n${output}`
    );
    const membershipResult = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/${tenantId}/memberships`,
      { token: adminToken, body: { principalId: `principal-${tenantId}`, role: "owner" } }
    );
    assert.equal(membershipResult.response.status, 201);
    const membershipId = String(membershipResult.body.id);
    const keyResult = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/${tenantId}/memberships/${membershipId}/api-keys`,
      { token: adminToken, body: {} }
    );
    assert.equal(keyResult.response.status, 201);
    const customerKey = String(keyResult.body.token);
    assert.match(customerKey, /^orc_live_/);

    const deviceId = `device-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const credential = `local-device-${randomUUID().replaceAll("-", "")}`.padEnd(43, "x");
    const credentialHash = createHash("sha256").update(credential).digest("hex");
    const deviceResult = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/${tenantId}/gateway-devices`,
      {
        token: adminToken,
        body: { id: deviceId, credentialHash, capabilities: [capability] },
      }
    );
    assert.equal(deviceResult.response.status, 201);

    const deviceTransport = createHttpLocalAgentGatewayTransport(baseUrl, {
      fetch,
      requestTimeoutMs: 5_000,
    });
    const session = await deviceTransport.connect(deviceId, credential);
    assert.ok(session, "device credential should authenticate through the Worker and D1");
    assert.equal(await deviceTransport.heartbeat(session, [capability]), true);

    const invocationBody = {
      deviceId,
      capability,
      payload: { prompt: "local Worker integration payload" },
      timeoutMs: 10_000,
    };
    const idempotencyKey = `local-replay-${randomUUID()}`;
    const invoke = () =>
      requestJson(`${baseUrl}/__gateway/v1/customer/invoke`, {
        token: customerKey,
        headers: { "Idempotency-Key": idempotencyKey },
        body: invocationBody,
      });
    const firstInvocation = invoke();

    let deviceRequests: Awaited<ReturnType<typeof deviceTransport.poll>> = null;
    const pollDeadline = Date.now() + 5_000;
    while (!deviceRequests?.length && Date.now() < pollDeadline) {
      deviceRequests = await deviceTransport.poll(session);
      if (!deviceRequests?.length) await delay(25);
    }
    assert.equal(
      deviceRequests?.length,
      1,
      "invocation should be enqueued in the real Durable Object"
    );
    const requestId = deviceRequests![0]!.requestId;
    assert.equal(
      await deviceTransport.submitResult(session, {
        version: 1,
        requestId,
        outcome: { ok: true, value: { answer: "handled by local device fixture" } },
      }),
      true
    );

    const firstResult = await firstInvocation;
    assert.equal(firstResult.response.status, 200);
    assert.equal(firstResult.body.requestId, requestId);
    assert.deepEqual(firstResult.body.result, {
      version: 1,
      outcome: { ok: true, value: { answer: "handled by local device fixture" } },
    });

    const replayResult = await invoke();
    assert.equal(replayResult.response.status, 200);
    assert.deepEqual(replayResult.body, firstResult.body);
    assert.equal((await deviceTransport.poll(session))?.length, 0, "replay must not enqueue again");

    // The local worker config and environment were generated under tempDir, not
    // the repository; assert this invariant to guard against future test changes.
    const localEnv = await readFile(path.join(tempDir, ".env"), "utf8");
    assert.equal(localEnv, `OMNIROUTE_CLOUD_ADMIN_TOKEN=${adminToken}\n`);
  }
);
