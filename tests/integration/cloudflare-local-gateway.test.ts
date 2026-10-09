import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { LocalAgentGatewaySession } from "../../src/lib/localAgent/gatewayProtocol.js";
import { createHttpLocalAgentGatewayTransport } from "../../src/lib/localAgent/httpGatewayTransport.js";
import {
  discoverLocalCapabilities,
  type LocalDiscoveryResult,
} from "../../src/lib/localAgent/localDiscovery.js";
import { runLocalAgentGatewayCycle } from "../../src/lib/localAgent/runner.js";

const enabled = process.env.RUN_CLOUDFLARE_LOCAL_INT === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const adminToken = "local-integration-admin-token-only";
const maintenanceToken = "local-integration-maintenance-token-only";
const frontDeskConfigToken = "local-integration-front-desk-config-token-only";
const credentialEncryptionKey = Buffer.alloc(32, 17).toString("base64");
const idempotencyHmacKey = Buffer.alloc(32, 29).toString("base64");
const capability = "ollama:chat:integration-test";
const localOllamaBaseUrl = "http://127.0.0.1:11434";

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
    timeoutMs?: number;
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
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
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

async function requestHostJson(
  port: number,
  host: string,
  pathname: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const serializedBody = body === undefined ? "" : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: body === undefined ? "GET" : "POST",
        headers: {
          host,
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(serializedBody),
              }),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (responseBody += chunk));
        response.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(responseBody);
            assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
            resolve({ status: response.statusCode ?? 0, body: parsed as Record<string, unknown> });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.setTimeout(20_000, () => request.destroy(new Error("Front Desk request timed out")));
    request.once("error", reject);
    if (serializedBody) request.write(serializedBody);
    request.end();
  });
}

async function requestHostBytes(
  port: number,
  host: string,
  pathname: string,
  timeoutMs = 30_000
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port, path: pathname, method: "GET", headers: { host } },
      (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.from(chunk);
          totalBytes += bytes.byteLength;
          if (totalBytes > 10 * 1024 * 1024) {
            request.destroy(new Error("Front Desk image exceeded 10 MiB"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks, totalBytes),
          });
        });
      }
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error("Front Desk image request timed out"))
    );
    request.once("error", reject);
    request.end();
  });
}

async function requestHostStream(
  port: number,
  host: string,
  pathname: string,
  body: unknown,
  timeoutMs = 40_000
): Promise<{ status: number; contentType: string; body: string }> {
  const serializedBody = JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(serializedBody),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > 128 * 1024) {
            request.destroy(new Error("Front Desk stream exceeded 128 KiB"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Front Desk stream timed out")));
    request.once("error", reject);
    request.end(serializedBody);
  });
}

function parseOpenAiSseFrames(stream: string): string[] {
  return stream.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    return data.length > 0 ? [data.join("\n")] : [];
  });
}

async function startComfyUiFixture(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    if (request.url?.startsWith("/object_info/")) {
      response.writeHead(200, { "content-type": "application/json" });
      const nodeType = request.url.slice("/object_info/".length);
      const nodes: Record<string, unknown> = {
        KSampler: {},
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [["fixture.safetensors"]] } } },
        SaveImage: {},
      };
      response.end(JSON.stringify({ [nodeType]: nodes[nodeType] }));
      return;
    }
    if (request.url === "/prompt" && request.method === "POST") {
      const submitted = JSON.parse(body) as { prompt?: unknown };
      if (!submitted.prompt || typeof submitted.prompt !== "object") {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt_id: "fixture_job_1" }));
      return;
    }
    if (request.url === "/history/fixture_job_1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          fixture_job_1: {
            outputs: {
              "9": { images: [{ filename: "result.png", subfolder: "", type: "output" }] },
            },
          },
        })
      );
      return;
    }
    if (
      request.url?.startsWith("/view?") &&
      new URL(request.url, "http://127.0.0.1").searchParams.get("filename") === "result.png"
    ) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

async function discoverInstalledOllamaModel(): Promise<string> {
  const response = await fetch(`${localOllamaBaseUrl}/api/tags`, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.ok, true, "local Ollama /api/tags should respond successfully");
  const bodyText = await response.text();
  assert.ok(Buffer.byteLength(bodyText) <= 64 * 1024, "Ollama model list exceeds 64 KiB");
  const body: unknown = JSON.parse(bodyText);
  assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
  const models = (body as { models?: unknown }).models;
  assert.ok(Array.isArray(models) && models.length > 0, "Ollama must have an installed model");
  const installedModels = models.flatMap((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test((entry as { name: string }).name) ||
      !Number.isSafeInteger((entry as { size?: unknown }).size) ||
      (entry as { size: number }).size < 1
    ) {
      return [];
    }
    return [{ name: (entry as { name: string }).name, size: (entry as { size: number }).size }];
  });
  assert.ok(installedModels.length > 0, "Ollama returned no valid installed model entries");
  installedModels.sort((left, right) => left.size - right.size);
  return installedModels[0]!.name;
}

async function runLocalOllamaChat(
  model: string,
  messages: unknown,
  options: unknown,
  limits: { keepAlive: number | string; maxTokens: number } = { keepAlive: 0, maxTokens: 64 }
): Promise<Record<string, unknown>> {
  const response = await fetch(`${localOllamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      keep_alive: limits.keepAlive,
      options: {
        ...(options && typeof options === "object" ? options : {}),
        num_predict: limits.maxTokens,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const responseText = await response.text();
  assert.ok(Buffer.byteLength(responseText) <= 128 * 1024, "Ollama chat response exceeds 128 KiB");
  assert.equal(response.ok, true, `local Ollama chat failed: HTTP ${response.status}`);
  const body: unknown = JSON.parse(responseText);
  assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
  const result = body as Record<string, unknown>;
  assert.ok(
    result.message !== null && typeof result.message === "object" && !Array.isArray(result.message),
    "Ollama chat result must include a message object"
  );
  const message = result.message as Record<string, unknown>;
  assert.equal(message.role, "assistant");
  assert.equal(typeof message.content, "string");
  assert.ok(
    (message.content as string).trim().length > 0,
    "Ollama returned empty assistant content"
  );
  return result;
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
    const localSecrets = [
      `OMNIROUTE_CLOUD_ADMIN_TOKEN=${adminToken}`,
      `OMNIROUTE_CLOUD_MAINTENANCE_TOKEN=${maintenanceToken}`,
      `OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY=${credentialEncryptionKey}`,
      `OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY=${idempotencyHmacKey}`,
      `OMNIROUTE_FRONT_DESK_CONFIG_TOKEN=${frontDeskConfigToken}`,
    ].join("\n");
    await writeFile(path.join(tempDir, ".env"), `${localSecrets}\n`, { mode: 0o600 });
    await writeFile(path.join(tempDir, ".dev.vars"), `${localSecrets}\n`, { mode: 0o600 });
    await writeFile(safeEnvPath, `${localSecrets}\n`, { mode: 0o600 });
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
          r2_buckets: [
            {
              binding: "GATEWAY_ARTIFACTS",
              bucket_name: `${workerName}-artifacts`,
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
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    assert.equal(
      migrationResult.status,
      0,
      `local D1 migrations failed:\n${migrationResult.stdout}\n${migrationResult.stderr}`
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
    assert.equal(health.body.status, "ok");
    const database = await requestJson(`${baseUrl}/__cloud/db`);
    assert.equal(database.response.status, 200);
    assert.equal(database.body.database, "d1");
    const readiness = await requestJson(`${baseUrl}/__cloud/readiness`);
    assert.equal(readiness.response.status, 200);
    assert.deepEqual(readiness.body.checks, {
      database: "ok",
      gateway: "ok",
      artifacts: "ok",
    });
    const unauthorizedAdminRequest = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/__smoke_missing__/status`
    );
    assert.equal(unauthorizedAdminRequest.response.status, 401);
    const authorizedAdminRequest = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/__smoke_missing__/status`,
      { token: adminToken }
    );
    assert.equal(authorizedAdminRequest.response.status, 404);

    const deviceTransport = createHttpLocalAgentGatewayTransport(baseUrl, {
      fetch,
      requestTimeoutMs: 5_000,
    });

    const provisionCustomer = async (
      label: string,
      connectDevice = true,
      capabilities: string[] = [capability]
    ) => {
      const tenantId = `local-${label}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const tenantResult = await requestJson(`${baseUrl}/__cloud/v1/tenants`, {
        token: adminToken,
        body: {
          id: tenantId,
          name: `Local Integration ${label}`,
          slug: tenantId,
          ownerPrincipalId: `principal-${tenantId}`,
        },
      });
      assert.equal(
        tenantResult.response.status,
        201,
        `${label} tenant provisioning failed: ${JSON.stringify(tenantResult.body)}\n${output}`
      );
      const customerKey = String(tenantResult.body.ownerApiKey.token);
      assert.match(customerKey, /^orc_live_/);
      const settingsResult = await requestJson(`${baseUrl}/__cloud/v1/customer/settings`, {
        method: "PUT",
        token: customerKey,
        body: { localAiEnabled: true, mcpEnabled: false },
      });
      assert.equal(
        settingsResult.response.status,
        200,
        `${label} local AI setting failed: ${JSON.stringify(settingsResult.body)}\n${output}`
      );

      const deviceId = `device-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const credential = `local-device-${randomUUID().replaceAll("-", "")}`.padEnd(43, "x");
      const credentialHash = createHash("sha256").update(credential).digest("hex");
      const deviceResult = await requestJson(
        `${baseUrl}/__cloud/v1/tenants/${tenantId}/gateway-devices`,
        {
          token: adminToken,
          body: { id: deviceId, credentialHash, capabilities },
        }
      );
      assert.equal(deviceResult.response.status, 201);

      const session = connectDevice ? await deviceTransport.connect(deviceId, credential) : null;
      if (connectDevice) {
        assert.ok(session, `${label} device credential should authenticate through Worker and D1`);
        assert.equal(await deviceTransport.heartbeat(session!, capabilities), true);
      }
      return { tenantId, customerKey, deviceId, credential, session };
    };

    const customerA = await provisionCustomer("a");
    const customerB = await provisionCustomer("b");
    assert.notEqual(customerA.tenantId, customerB.tenantId);
    assert.notEqual(customerA.customerKey, customerB.customerKey);
    assert.notEqual(customerA.deviceId, customerB.deviceId);
    assert.notEqual(customerA.credential, customerB.credential);

    await t.test(
      "D1 customer hosts resolve exact tenants without disclosing credentials",
      async () => {
        const hostA = "tenant-a.frontdesk.integration.test";
        const hostB = "tenant-b.frontdesk.integration.test";
        const unauthorized = await requestJson(`${baseUrl}/__cloud/v1/tenant-hosts`, {
          body: { tenantId: customerA.tenantId, hostname: hostA },
        });
        assert.equal(unauthorized.response.status, 401);

        for (const [tenantId, hostname] of [
          [customerA.tenantId, hostA],
          [customerB.tenantId, hostB],
        ]) {
          const registration = await requestJson(`${baseUrl}/__cloud/v1/tenant-hosts`, {
            token: adminToken,
            body: { tenantId, hostname },
          });
          assert.equal(registration.response.status, 201, JSON.stringify(registration.body));
        }

        const resolvedA = await requestJson(
          `${baseUrl}/__cloud/v1/tenant-hosts/resolve?hostname=${encodeURIComponent(hostA.toUpperCase())}`
        );
        assert.equal(resolvedA.response.status, 200);
        assert.equal((resolvedA.body.tenant as Record<string, unknown>).id, customerA.tenantId);
        assert.ok(resolvedA.body.businessProfile);
        assert.equal(JSON.stringify(resolvedA.body).includes(customerA.customerKey), false);
        assert.equal(JSON.stringify(resolvedA.body).includes(customerB.customerKey), false);
        assert.equal(JSON.stringify(resolvedA.body).includes(customerA.credential), false);
        assert.equal(JSON.stringify(resolvedA.body).includes(customerB.credential), false);

        const lookalike = await requestJson(
          `${baseUrl}/__cloud/v1/tenant-hosts/resolve?hostname=${encodeURIComponent(`${hostA}.evil.test`)}`
        );
        assert.equal(lookalike.response.status, 404);

        const crossTenantDelete = await requestJson(
          `${baseUrl}/__cloud/v1/tenant-hosts/${hostA}?tenantId=${customerB.tenantId}`,
          { method: "DELETE", token: adminToken }
        );
        assert.equal(crossTenantDelete.response.status, 404);
        const retainedA = await requestJson(
          `${baseUrl}/__cloud/v1/tenant-hosts/resolve?hostname=${hostA}`
        );
        assert.equal(retainedA.response.status, 200);

        const removedA = await requestJson(
          `${baseUrl}/__cloud/v1/tenant-hosts/${hostA}?tenantId=${customerA.tenantId}`,
          { method: "DELETE", token: adminToken }
        );
        assert.equal(removedA.response.status, 200);
        const noLongerResolved = await requestJson(
          `${baseUrl}/__cloud/v1/tenant-hosts/resolve?hostname=${hostA}`
        );
        assert.equal(noLongerResolved.response.status, 404);
        const retainedB = await requestJson(
          `${baseUrl}/__cloud/v1/tenant-hosts/resolve?hostname=${hostB}`
        );
        assert.equal(retainedB.response.status, 200);
        assert.equal((retainedB.body.tenant as Record<string, unknown>).id, customerB.tenantId);
      }
    );

    await t.test("device session and D1 state survive a local Worker restart", async () => {
      await stopWorker(child);
      child = startWorker();
      child.stdout?.on("data", appendOutput);
      child.stderr?.on("data", appendOutput);
      await waitForWorker(baseUrl, child, () => output);

      const restartedHealth = await requestJson(`${baseUrl}/__cloud/health`);
      assert.equal(restartedHealth.response.status, 200);
      const restartedDevice = await requestJson(
        `${baseUrl}/__cloud/v1/tenants/${customerA.tenantId}/gateway-devices/${customerA.deviceId}`,
        { token: adminToken }
      );
      assert.equal(restartedDevice.response.status, 200);
      assert.equal(restartedDevice.body.id, customerA.deviceId);
      assert.equal(
        await deviceTransport.heartbeat(customerA.session!, [capability]),
        true,
        "the pre-restart session should remain valid in persistent Durable Object storage"
      );
      assert.deepEqual(
        await deviceTransport.poll(customerA.session!),
        [],
        "the reconnected session should poll successfully without stale queued work"
      );

      const staleSession = customerA.session!;
      assert.ok(await deviceTransport.connect(customerA.deviceId, customerA.credential));
      const recovered = await runLocalAgentGatewayCycle(
        {
          gatewayUrl: baseUrl,
          deviceId: customerA.deviceId,
          credential: customerA.credential,
        },
        {
          fetch,
          gateway: deviceTransport,
          discover: async (): Promise<LocalDiscoveryResult> => ({
            heartbeat: {
              status: "online",
              capabilities: [capability],
              serviceHealth: { ollama: false, comfyui: false },
            },
            services: [
              { service: "ollama", reachable: false, models: [] },
              { service: "comfyui", reachable: false, models: [] },
            ],
          }),
        },
        staleSession
      );
      assert.equal(recovered.processed, 0);
      assert.equal(
        await deviceTransport.heartbeat(staleSession, [capability]),
        false,
        "the session replaced during recovery must remain invalid"
      );
      customerA.session = recovered.session;
    });

    await t.test(
      "Front Desk routes a host-scoped chat through the local Worker gateway to tenant A's device",
      {
        skip:
          !process.env.FRONT_DESK_REPO &&
          "Set FRONT_DESK_REPO to the Front Desk checkout to run the cross-repository fixture.",
      },
      async (frontDeskTest) => {
        const frontDeskRepo = path.resolve(process.env.FRONT_DESK_REPO!);
        const frontDeskTempDir = await mkdtemp(path.join(tempDir, "front-desk-"));
        const frontDeskHome = path.join(frontDeskTempDir, "home");
        await mkdir(frontDeskHome, { recursive: true });
        for (const filename of [
          "server.js",
          "omnirouteConfig.js",
          "businessProfileClient.js",
          "leadStore.js",
          "chatRateLimit.js",
        ]) {
          await copyFile(path.join(frontDeskRepo, filename), path.join(frontDeskTempDir, filename));
        }
        await writeFile(path.join(frontDeskTempDir, "leads.json"), "[]\n", { mode: 0o600 });

        const frontDeskHost = "tenant-a.frontdesk.test";
        const frontDeskPort = await getUnusedPort();
        const frontDeskBHost = "tenant-b.frontdesk.test";

        for (const [tenantId, hostname] of [
          [customerA.tenantId, frontDeskHost],
          [customerB.tenantId, frontDeskBHost],
        ]) {
          const registration = await requestJson(`${baseUrl}/__cloud/v1/tenant-hosts`, {
            token: adminToken,
            body: { tenantId, hostname },
          });
          assert.equal(
            registration.response.status,
            201,
            `platform admin should register ${hostname} in D1: ${JSON.stringify(registration.body)}`
          );
        }

        for (const [tenant, hostname, dashboardToken] of [
          [customerA, frontDeskHost, "local-frontdesk-dashboard-token-a"],
          [customerB, frontDeskBHost, "local-frontdesk-dashboard-token-b"],
        ] as const) {
          const savedConfig = await requestJson(`${baseUrl}/__cloud/v1/front-desk/configs`, {
            method: "PUT",
            token: adminToken,
            body: {
              hostname,
              customerApiKey: tenant.customerKey,
              dashboardToken,
              gateway: {
                baseUrl,
                deviceId: tenant.deviceId,
                ollamaModel: "integration-test",
                imageGeneration: null,
              },
            },
          });
          assert.equal(
            savedConfig.response.status,
            200,
            `tenant-owned Front Desk config should save through D1: ${JSON.stringify(savedConfig.body)}`
          );
          assert.equal(JSON.stringify(savedConfig.body).includes(tenant.customerKey), false);
          assert.equal(JSON.stringify(savedConfig.body).includes(dashboardToken), false);
        }
        const frontDeskChild = spawn(process.execPath, ["server.js"], {
          cwd: frontDeskTempDir,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: frontDeskHome,
            NODE_ENV: "test",
            NO_COLOR: "1",
            PORT: String(frontDeskPort),
            FRONT_DESK_HOST_REGISTRY_URL: baseUrl,
            FRONT_DESK_CONFIG_TOKEN: frontDeskConfigToken,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let frontDeskOutput = "";
        const appendFrontDeskOutput = (chunk: Buffer) => {
          frontDeskOutput = `${frontDeskOutput}${chunk.toString("utf8")}`.slice(-10_000);
        };
        frontDeskChild.stdout?.on("data", appendFrontDeskOutput);
        frontDeskChild.stderr?.on("data", appendFrontDeskOutput);
        frontDeskTest.after(async () => {
          await stopWorker(frontDeskChild);
          await rm(frontDeskTempDir, { recursive: true, force: true });
        });

        let frontDeskReady = false;
        const frontDeskDeadline = Date.now() + 10_000;
        while (Date.now() < frontDeskDeadline) {
          if (frontDeskChild.exitCode !== null) {
            assert.fail(
              `Front Desk exited before becoming ready (code ${frontDeskChild.exitCode}):\n${frontDeskOutput}`
            );
          }
          try {
            const response = await requestHostJson(frontDeskPort, frontDeskHost, "/api/health");
            if (response.status === 200) {
              frontDeskReady = true;
              break;
            }
          } catch {
            // The temporary Front Desk process may still be starting.
          }
          await delay(50);
        }
        assert.equal(frontDeskReady, true, `Front Desk did not become ready:\n${frontDeskOutput}`);

        const registeredProfile = await requestJson(
          `${baseUrl}/__cloud/v1/tenant-hosts/resolve?hostname=${encodeURIComponent(frontDeskHost)}`
        );
        assert.equal(registeredProfile.response.status, 200);
        const frontDeskBusiness = await requestHostJson(
          frontDeskPort,
          frontDeskHost,
          "/business.json"
        );
        assert.equal(frontDeskBusiness.status, 200);
        assert.equal(
          frontDeskBusiness.body.name,
          (registeredProfile.body.businessProfile as Record<string, unknown>).name,
          "Front Desk should use the tenant business profile resolved from Worker D1"
        );

        const chatRequest = requestHostJson(frontDeskPort, frontDeskHost, "/api/chat", {
          model: "ignored-by-gateway-fixture",
          messages: [{ role: "user", content: "Please handle the local gateway test." }],
        });
        let gatewayRequests: Awaited<ReturnType<typeof deviceTransport.poll>> = null;
        const gatewayPollDeadline = Date.now() + 10_000;
        while (!gatewayRequests?.length && Date.now() < gatewayPollDeadline) {
          gatewayRequests = await deviceTransport.poll(customerA.session!);
          if (!gatewayRequests?.length) await delay(25);
        }
        assert.equal(
          gatewayRequests?.length,
          1,
          `Front Desk chat should reach tenant A's real local gateway device. Front Desk logs:\n${frontDeskOutput}`
        );
        const gatewayRequest = gatewayRequests![0]!;
        assert.equal(gatewayRequest.capability, capability);
        assert.deepEqual(gatewayRequest.payload, {
          messages: [{ role: "user", content: "Please handle the local gateway test." }],
          options: { temperature: 0.2 },
        });
        assert.equal(
          await deviceTransport.submitResult(customerA.session!, {
            version: 1,
            requestId: gatewayRequest.requestId,
            outcome: {
              ok: true,
              value: {
                message: { role: "assistant", content: "Completed through the local device." },
                done_reason: "stop",
                prompt_eval_count: 9,
                eval_count: 6,
              },
            },
          }),
          true
        );

        const frontDeskResponse = await chatRequest;
        assert.equal(
          frontDeskResponse.status,
          200,
          `Front Desk should translate the Worker result into a chat completion: ${JSON.stringify(frontDeskResponse.body)}`
        );
        assert.equal(frontDeskResponse.body.object, "chat.completion");
        assert.equal(frontDeskResponse.body.model, "integration-test");
        assert.deepEqual(frontDeskResponse.body.choices, [
          {
            index: 0,
            message: { role: "assistant", content: "Completed through the local device." },
            finish_reason: "stop",
          },
        ]);
        assert.deepEqual(frontDeskResponse.body.usage, {
          prompt_tokens: 9,
          completion_tokens: 6,
          total_tokens: 15,
        });
        assert.equal(
          JSON.stringify(frontDeskResponse.body).includes(customerA.customerKey),
          false,
          "Front Desk chat response must not expose the tenant API key"
        );

        const chatB = requestHostJson(frontDeskPort, frontDeskBHost, "/api/chat", {
          messages: [{ role: "user", content: "Please handle tenant B's gateway test." }],
        });
        let gatewayRequestsB: Awaited<ReturnType<typeof deviceTransport.poll>> = null;
        const gatewayPollDeadlineB = Date.now() + 10_000;
        while (!gatewayRequestsB?.length && Date.now() < gatewayPollDeadlineB) {
          gatewayRequestsB = await deviceTransport.poll(customerB.session!);
          if (!gatewayRequestsB?.length) await delay(25);
        }
        assert.equal(
          gatewayRequestsB?.length,
          1,
          `Front Desk host B should reach tenant B's device. Front Desk logs:\n${frontDeskOutput}`
        );
        const gatewayRequestB = gatewayRequestsB![0]!;
        assert.equal(gatewayRequestB.capability, capability);
        assert.deepEqual(gatewayRequestB.payload, {
          messages: [{ role: "user", content: "Please handle tenant B's gateway test." }],
          options: { temperature: 0.2 },
        });
        assert.equal(
          await deviceTransport.submitResult(customerB.session!, {
            version: 1,
            requestId: gatewayRequestB.requestId,
            outcome: {
              ok: true,
              value: { message: { role: "assistant", content: "Completed for tenant B." } },
            },
          }),
          true
        );
        const frontDeskResponseB = await chatB;
        assert.equal(
          frontDeskResponseB.status,
          200,
          `Front Desk should route host B to tenant B's Worker identity: ${JSON.stringify(frontDeskResponseB.body)}`
        );
        assert.deepEqual(frontDeskResponseB.body.choices, [
          {
            index: 0,
            message: { role: "assistant", content: "Completed for tenant B." },
            finish_reason: "stop",
          },
        ]);
        assert.equal(
          JSON.stringify(frontDeskResponseB.body).includes(customerB.customerKey),
          false,
          "Front Desk tenant B response must not expose its API key"
        );

        await frontDeskTest.test(
          "overlapping A/B chats stay tenant-bound when gateway B completes first",
          async () => {
            const messageA = "Concurrent request for tenant A.";
            const messageB = "Concurrent request for tenant B.";
            const concurrentChatA = requestHostJson(frontDeskPort, frontDeskHost, "/api/chat", {
              messages: [{ role: "user", content: messageA }],
            });
            const concurrentChatB = requestHostJson(frontDeskPort, frontDeskBHost, "/api/chat", {
              messages: [{ role: "user", content: messageB }],
            });

            const pollForRequest = async (
              session: NonNullable<typeof customerA.session>,
              tenantLabel: string
            ) => {
              const deadline = Date.now() + 10_000;
              while (Date.now() < deadline) {
                const requests = await deviceTransport.poll(session);
                if (requests?.length) return requests[0]!;
                await delay(25);
              }
              assert.fail(
                `Concurrent Front Desk chat did not reach tenant ${tenantLabel}'s device. Front Desk logs:\n${frontDeskOutput}`
              );
            };

            const [requestA, requestB] = await Promise.all([
              pollForRequest(customerA.session!, "A"),
              pollForRequest(customerB.session!, "B"),
            ]);
            assert.equal(requestA.capability, capability);
            assert.equal(requestB.capability, capability);
            assert.deepEqual(requestA.payload, {
              messages: [{ role: "user", content: messageA }],
              options: { temperature: 0.2 },
            });
            assert.deepEqual(requestB.payload, {
              messages: [{ role: "user", content: messageB }],
              options: { temperature: 0.2 },
            });

            assert.equal(
              await deviceTransport.submitResult(customerB.session!, {
                version: 1,
                requestId: requestB.requestId,
                outcome: {
                  ok: true,
                  value: { message: { role: "assistant", content: "Concurrent result for B." } },
                },
              }),
              true
            );
            const responseB = await concurrentChatB;
            assert.equal(responseB.status, 200, JSON.stringify(responseB.body));
            assert.deepEqual(responseB.body.choices, [
              {
                index: 0,
                message: { role: "assistant", content: "Concurrent result for B." },
                finish_reason: "stop",
              },
            ]);

            assert.equal(
              await deviceTransport.submitResult(customerA.session!, {
                version: 1,
                requestId: requestA.requestId,
                outcome: {
                  ok: true,
                  value: { message: { role: "assistant", content: "Concurrent result for A." } },
                },
              }),
              true
            );
            const responseA = await concurrentChatA;
            assert.equal(responseA.status, 200, JSON.stringify(responseA.body));
            assert.deepEqual(responseA.body.choices, [
              {
                index: 0,
                message: { role: "assistant", content: "Concurrent result for A." },
                finish_reason: "stop",
              },
            ]);
            assert.equal(JSON.stringify(responseA.body).includes(customerB.customerKey), false);
            assert.equal(JSON.stringify(responseB.body).includes(customerA.customerKey), false);
          }
        );
      }
    );

    await t.test(
      "Front Desk completes a local Ollama model chat through the Worker and Durable Object",
      {
        timeout: 180_000,
        skip:
          process.env.RUN_CLOUDFLARE_LOCAL_OLLAMA_INT !== "1"
            ? "Set RUN_CLOUDFLARE_LOCAL_OLLAMA_INT=1 to run the loopback-only Ollama integration."
            : !process.env.FRONT_DESK_REPO
              ? "Set FRONT_DESK_REPO to run the Front Desk plus local Ollama integration."
              : false,
      },
      async (ollamaTest) => {
        const model = await discoverInstalledOllamaModel();
        await runLocalOllamaChat(
          model,
          [{ role: "user", content: "Reply with one short word." }],
          { temperature: 0 },
          { keepAlive: "5m", maxTokens: 1 }
        );
        const modelCapability = `ollama:chat:${model}`;
        const ollamaCustomer = await provisionCustomer("ollama", false, [modelCapability]);
        const frontDeskRepo = path.resolve(process.env.FRONT_DESK_REPO!);
        const frontDeskTempDir = await mkdtemp(path.join(tempDir, "front-desk-ollama-"));
        const frontDeskHome = path.join(frontDeskTempDir, "home");
        await mkdir(frontDeskHome, { recursive: true });
        for (const filename of [
          "server.js",
          "omnirouteConfig.js",
          "businessProfileClient.js",
          "leadStore.js",
          "chatRateLimit.js",
        ]) {
          await copyFile(path.join(frontDeskRepo, filename), path.join(frontDeskTempDir, filename));
        }
        await writeFile(path.join(frontDeskTempDir, "leads.json"), "[]\n", { mode: 0o600 });

        const frontDeskHost = "tenant-ollama.frontdesk.test";
        const frontDeskPort = await getUnusedPort();
        const frontDeskKeyEnv = "FRONT_DESK_LOCAL_OLLAMA_KEY";
        const frontDeskDashboardEnv = "FRONT_DESK_LOCAL_OLLAMA_DASHBOARD";
        const frontDeskTenants = [
          {
            host: frontDeskHost,
            tenantId: ollamaCustomer.tenantId,
            dashboardTokenEnv: frontDeskDashboardEnv,
            gateway: {
              baseUrl,
              customerApiKeyEnv: frontDeskKeyEnv,
              deviceId: ollamaCustomer.deviceId,
              ollamaModel: model,
            },
            business: {
              name: "Loopback Ollama Integration",
              description: "Isolated local model test",
              hours: "Always",
              services: [],
              assistant: {
                name: "Local model assistant",
                tone: "helpful",
                handoff: "Offer a follow-up.",
              },
            },
          },
        ];
        const frontDeskChild = spawn(process.execPath, ["server.js"], {
          cwd: frontDeskTempDir,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: frontDeskHome,
            NODE_ENV: "test",
            NO_COLOR: "1",
            PORT: String(frontDeskPort),
            FRONT_DESK_TENANTS_JSON: JSON.stringify(frontDeskTenants),
            [frontDeskKeyEnv]: ollamaCustomer.customerKey,
            [frontDeskDashboardEnv]: "local-ollama-dashboard-token",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let frontDeskOutput = "";
        const appendFrontDeskOutput = (chunk: Buffer) => {
          frontDeskOutput = `${frontDeskOutput}${chunk.toString("utf8")}`.slice(-10_000);
        };
        frontDeskChild.stdout?.on("data", appendFrontDeskOutput);
        frontDeskChild.stderr?.on("data", appendFrontDeskOutput);
        ollamaTest.after(async () => {
          await stopWorker(frontDeskChild);
          await rm(frontDeskTempDir, { recursive: true, force: true });
        });

        let frontDeskReady = false;
        const frontDeskDeadline = Date.now() + 10_000;
        while (Date.now() < frontDeskDeadline) {
          if (frontDeskChild.exitCode !== null) {
            assert.fail(
              `Front Desk exited before becoming ready (code ${frontDeskChild.exitCode}):\n${frontDeskOutput}`
            );
          }
          try {
            const response = await requestHostJson(frontDeskPort, frontDeskHost, "/api/health");
            if (response.status === 200) {
              frontDeskReady = true;
              break;
            }
          } catch {
            // The temporary Front Desk process may still be starting.
          }
          await delay(50);
        }
        assert.equal(frontDeskReady, true, `Front Desk did not become ready:\n${frontDeskOutput}`);

        const agentDataDir = path.join(frontDeskTempDir, "local-agent-data");
        await mkdir(agentDataDir, { recursive: true });
        const agentCredentialEnv = "LOCAL_OLLAMA_AGENT_CREDENTIAL";
        const agentChild = spawn(
          process.execPath,
          [
            path.join(repoRoot, "bin", "omniroute.mjs"),
            "local-agent",
            "run",
            "--gateway-url",
            baseUrl,
            "--device-id",
            ollamaCustomer.deviceId,
            "--credential-env",
            agentCredentialEnv,
            "--ollama-url",
            localOllamaBaseUrl,
            "--heartbeat-interval-ms",
            "250",
          ],
          {
            cwd: tempDir,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: frontDeskHome,
              DATA_DIR: agentDataDir,
              NODE_ENV: "test",
              NO_COLOR: "1",
              CI: "1",
              OMNIROUTE_CLI_SKIP_REPO_ENV: "1",
              OMNIROUTE_NO_UPDATE_NOTIFIER: "1",
              [agentCredentialEnv]: ollamaCustomer.credential,
            },
            stdio: ["ignore", "pipe", "pipe"],
          }
        );
        let agentOutput = "";
        const appendAgentOutput = (chunk: Buffer) => {
          agentOutput = `${agentOutput}${chunk.toString("utf8")}`.slice(-10_000);
        };
        agentChild.stdout?.on("data", appendAgentOutput);
        agentChild.stderr?.on("data", appendAgentOutput);
        ollamaTest.after(async () => stopWorker(agentChild));

        let agentReady = false;
        const agentDeadline = Date.now() + 15_000;
        while (Date.now() < agentDeadline) {
          if (agentChild.exitCode !== null) {
            assert.fail(
              `Local Agent exited before its first heartbeat (code ${agentChild.exitCode}):\n${agentOutput}`
            );
          }
          const deviceStatus = await requestJson(
            `${baseUrl}/__cloud/v1/tenants/${ollamaCustomer.tenantId}/gateway-devices/${ollamaCustomer.deviceId}`,
            { token: adminToken }
          );
          const serviceHealth = deviceStatus.body.serviceHealth as { ollama?: unknown } | undefined;
          if (serviceHealth?.ollama === true) {
            agentReady = true;
            break;
          }
          await delay(100);
        }
        assert.equal(
          agentReady,
          true,
          `Local Agent did not report Ollama health through Worker/D1:\n${agentOutput}`
        );

        const chatRequest = requestHostJson(frontDeskPort, frontDeskHost, "/api/chat", {
          messages: [
            {
              role: "user",
              content: "Reply with the exact token LOCAL_OLLAMA_GATEWAY_OK and nothing else.",
            },
          ],
        });
        const frontDeskResponse = await chatRequest;
        assert.equal(
          frontDeskResponse.status,
          200,
          `Front Desk should return the local model completion: ${JSON.stringify(frontDeskResponse.body)}. Local Agent output: ${agentOutput}`
        );
        assert.equal(frontDeskResponse.body.object, "chat.completion");
        assert.equal(frontDeskResponse.body.model, model);
        const choices = frontDeskResponse.body.choices;
        assert.ok(Array.isArray(choices) && choices.length === 1);
        const firstChoice = choices[0] as {
          message?: { role?: unknown; content?: unknown };
          finish_reason?: unknown;
        };
        assert.equal(firstChoice.message?.role, "assistant");
        assert.equal(typeof firstChoice.message?.content, "string");
        assert.ok((firstChoice.message.content as string).trim().length > 0);
        assert.equal(
          JSON.stringify(frontDeskResponse.body).includes(ollamaCustomer.customerKey),
          false,
          "Front Desk chat response must not expose the local tenant API key"
        );

        const streamedResponse = await requestHostStream(
          frontDeskPort,
          frontDeskHost,
          "/api/chat",
          {
            messages: [{ role: "user", content: "Reply with one short word." }],
            stream: true,
          }
        );
        assert.equal(
          streamedResponse.status,
          200,
          `Front Desk should return the local model stream: ${streamedResponse.body.slice(0, 500)}. Local Agent output: ${agentOutput}`
        );
        assert.match(streamedResponse.contentType, /text\/event-stream/i);
        const frames = parseOpenAiSseFrames(streamedResponse.body);
        assert.equal(frames.at(-1), "[DONE]", "OpenAI SSE stream should end with [DONE]");
        const contentDeltas = frames
          .filter((frame) => frame !== "[DONE]")
          .map((frame) => {
            const chunk: unknown = JSON.parse(frame);
            assert.ok(chunk !== null && typeof chunk === "object");
            const choices = (chunk as { choices?: unknown }).choices;
            assert.ok(
              Array.isArray(choices),
              `Expected an OpenAI chat chunk: ${frame.slice(0, 500)}`
            );
            if (choices.length === 0) {
              assert.ok(
                (chunk as { usage?: unknown }).usage !== undefined,
                `An empty choices array is valid only for a usage chunk: ${frame.slice(0, 500)}`
              );
              return "";
            }
            return choices
              .map((choice) => {
                const delta = (choice as { delta?: unknown }).delta;
                assert.ok(delta !== null && typeof delta === "object");
                const content = (delta as { content?: unknown }).content;
                return typeof content === "string" ? content : "";
              })
              .join("");
          })
          .join("");
        assert.ok(
          contentDeltas.trim().length > 0,
          "OpenAI SSE stream should include a content delta"
        );
        assert.equal(
          streamedResponse.body.includes(ollamaCustomer.customerKey),
          false,
          "Front Desk stream must not expose the local tenant API key"
        );
        await stopWorker(agentChild);
      }
    );

    const invoke = (
      customerKey: string,
      deviceId: string,
      idempotencyKey: string,
      requestedCapability = capability
    ) =>
      requestJson(`${baseUrl}/__gateway/v1/customer/invoke`, {
        token: customerKey,
        headers: { "Idempotency-Key": idempotencyKey },
        body: {
          deviceId,
          capability: requestedCapability,
          payload: { prompt: "local Worker integration payload" },
          timeoutMs: 10_000,
        },
      });

    const invokeAndComplete = async (
      customer: typeof customerA,
      expectedAnswer: string,
      requestedCapability = capability
    ) => {
      const idempotencyKey = `local-replay-${randomUUID()}`;
      const invocation = invoke(
        customer.customerKey,
        customer.deviceId,
        idempotencyKey,
        requestedCapability
      );
      let deviceRequests: Awaited<ReturnType<typeof deviceTransport.poll>> = null;
      const pollDeadline = Date.now() + 5_000;
      while (!deviceRequests?.length && Date.now() < pollDeadline) {
        deviceRequests = await deviceTransport.poll(customer.session!);
        if (!deviceRequests?.length) await delay(25);
      }
      assert.equal(
        deviceRequests?.length,
        1,
        "invocation should be enqueued in the real Durable Object"
      );
      const requestId = deviceRequests![0]!.requestId;
      assert.equal(
        await deviceTransport.submitResult(customer.session!, {
          version: 1,
          requestId,
          outcome: { ok: true, value: { answer: expectedAnswer } },
        }),
        true
      );

      const firstResult = await invocation;
      assert.equal(firstResult.response.status, 200);
      assert.equal(firstResult.body.requestId, requestId);
      assert.deepEqual(firstResult.body.result, {
        version: 1,
        outcome: { ok: true, value: { answer: expectedAnswer } },
      });

      const replayResult = await invoke(
        customer.customerKey,
        customer.deviceId,
        idempotencyKey,
        requestedCapability
      );
      assert.equal(replayResult.response.status, 200);
      assert.deepEqual(replayResult.body, firstResult.body);
      const requestsAfterReplay = await deviceTransport.poll(customer.session!);
      assert.ok(requestsAfterReplay, "replay must leave the device session authorized");
      assert.equal(requestsAfterReplay.length, 0, "replay must not enqueue again");
      return firstResult.body;
    };

    await t.test(
      "tenant-local device catalogs reject another tenant's advertised model",
      async () => {
        const modelA = "ollama:chat:tenant-a-model";
        const modelB = "ollama:chat:tenant-b-model";
        const catalogA = await provisionCustomer("catalog-a", true, [modelA]);
        const catalogB = await provisionCustomer("catalog-b", true, [modelB]);

        const [deviceA, deviceB] = await Promise.all([
          requestJson(
            `${baseUrl}/__cloud/v1/tenants/${catalogA.tenantId}/gateway-devices/${catalogA.deviceId}`,
            { token: adminToken }
          ),
          requestJson(
            `${baseUrl}/__cloud/v1/tenants/${catalogB.tenantId}/gateway-devices/${catalogB.deviceId}`,
            { token: adminToken }
          ),
        ]);
        assert.equal(deviceA.response.status, 200);
        assert.deepEqual(deviceA.body.capabilities, [modelA]);
        assert.equal(deviceB.response.status, 200);
        assert.deepEqual(deviceB.body.capabilities, [modelB]);
        assert.equal(JSON.stringify(deviceA.body).includes(modelB), false);
        assert.equal(JSON.stringify(deviceB.body).includes(modelA), false);

        await invokeAndComplete(catalogA, "tenant A model completed", modelA);
        await invokeAndComplete(catalogB, "tenant B model completed", modelB);

        const wrongModelA = await invoke(
          catalogA.customerKey,
          catalogA.deviceId,
          `wrong-model-${randomUUID()}`,
          modelB
        );
        assert.equal(wrongModelA.response.status, 409);
        assert.equal(
          wrongModelA.body.error,
          "Capability is unavailable",
          `tenant A must not invoke tenant B's model: ${JSON.stringify(wrongModelA.body)}`
        );
        assert.deepEqual(
          await deviceTransport.poll(catalogA.session!),
          [],
          "a model absent from tenant A's catalog must not enqueue work"
        );
      }
    );

    await t.test(
      "a ComfyUI capability completes through the local agent executor, Worker, D1, and Durable Object",
      async (comfyTest) => {
        const comfy = await startComfyUiFixture();
        comfyTest.after(comfy.close);
        const comfyCustomer = await provisionCustomer("comfy", true, ["comfyui:image"]);
        const runnerConfig = {
          gatewayUrl: baseUrl,
          deviceId: comfyCustomer.deviceId,
          credential: comfyCustomer.credential,
          comfyUiUrl: comfy.baseUrl,
          requestTimeoutMs: 5_000,
        };
        const discovery = await discoverLocalCapabilities(runnerConfig, {
          fetch,
          resolveHost: async () => ["127.0.0.1"],
        });
        assert.ok(
          discovery.heartbeat.capabilities.includes("comfyui:image"),
          `mock ComfyUI should advertise image generation: ${JSON.stringify(discovery)}`
        );
        const runnerDependencies = {
          fetch,
          resolveHost: async () => ["127.0.0.1"],
          gateway: deviceTransport,
        };
        let session: LocalAgentGatewaySession | undefined;
        const initialCycle = await runLocalAgentGatewayCycle(
          runnerConfig,
          runnerDependencies,
          session
        );
        session = initialCycle.session;
        assert.equal(initialCycle.processed, 0, "the initial agent cycle should only connect");

        const idempotencyKey = `local-comfy-${randomUUID()}`;
        const job = await requestJson(`${baseUrl}/__gateway/v1/customer/image-jobs`, {
          token: comfyCustomer.customerKey,
          headers: { "Idempotency-Key": idempotencyKey },
          body: {
            deviceId: comfyCustomer.deviceId,
            prompt: "a small red apple",
            width: 64,
            height: 64,
            steps: 1,
            cfg: 1,
            seed: 42,
          },
        });
        assert.equal(job.response.status, 202, JSON.stringify(job.body));
        const jobId = String(job.body.jobId);

        let processed = 0;
        const deadline = Date.now() + 5_000;
        while (processed === 0 && Date.now() < deadline) {
          const cycle = await runLocalAgentGatewayCycle(runnerConfig, runnerDependencies, session);
          session = cycle.session;
          processed = cycle.processed;
          if (processed === 0) await delay(25);
        }
        assert.equal(processed, 1, "the local agent should execute the queued ComfyUI request");
        const status = await requestJson(`${baseUrl}/__gateway/v1/customer/image-jobs/${jobId}`, {
          token: comfyCustomer.customerKey,
        });
        assert.equal(status.response.status, 200, JSON.stringify(status.body));
        assert.equal(status.body.status, "succeeded", JSON.stringify(status.body));
        const imageResponse = await fetch(
          `${baseUrl}/__gateway/v1/customer/image-jobs/${jobId}/image`,
          { headers: { authorization: `Bearer ${comfyCustomer.customerKey}` } }
        );
        assert.equal(imageResponse.status, 200);
        assert.equal(imageResponse.headers.get("content-type"), "image/png");
        assert.deepEqual(
          Array.from(new Uint8Array(await imageResponse.arrayBuffer())),
          [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]
        );
      }
    );

    await t.test(
      "real loopback ComfyUI checkpoints reach the authenticated Worker device directory",
      {
        timeout: 90_000,
        skip:
          process.env.RUN_CLOUDFLARE_LOCAL_COMFYUI_INT !== "1"
            ? "Set RUN_CLOUDFLARE_LOCAL_COMFYUI_INT=1 to run the real loopback ComfyUI integration."
            : false,
      },
      async () => {
        const comfyUrl = process.env.OMNIROUTE_LOCAL_COMFYUI_URL ?? "http://127.0.0.1:8188";
        const comfyCustomer = await provisionCustomer("real-comfy", true, ["comfyui:image"]);
        const runnerConfig = {
          gatewayUrl: baseUrl,
          deviceId: comfyCustomer.deviceId,
          credential: comfyCustomer.credential,
          ollamaUrl: "http://user:password@127.0.0.1:11434",
          comfyUiUrl: comfyUrl,
          requestTimeoutMs: 5_000,
        };
        const discovery = await discoverLocalCapabilities(runnerConfig, {
          fetch,
          resolveHost: async () => ["127.0.0.1"],
        });
        assert.ok(
          discovery.heartbeat.capabilities.includes("comfyui:image"),
          `loopback ComfyUI must expose an executable image workflow: ${JSON.stringify(discovery)}`
        );
        assert.equal(discovery.heartbeat.serviceHealth.comfyui, true);
        const comfyService = discovery.services.find((service) => service.service === "comfyui");
        const checkpoints = (comfyService?.models ?? [])
          .filter((model) => model.startsWith("comfyui:checkpoint:"))
          .map((model) => model.slice("comfyui:checkpoint:".length));
        assert.ok(checkpoints.length > 0, "ComfyUI must expose at least one checkpoint");
        const runnerDependencies = {
          fetch,
          resolveHost: async () => ["127.0.0.1"],
          gateway: deviceTransport,
        };
        let session: LocalAgentGatewaySession | undefined;
        const initialCycle = await runLocalAgentGatewayCycle(
          runnerConfig,
          runnerDependencies,
          session
        );
        session = initialCycle.session;
        assert.equal(initialCycle.processed, 0);
        const device = await requestJson(
          `${baseUrl}/__cloud/v1/tenants/${comfyCustomer.tenantId}/gateway-devices/${comfyCustomer.deviceId}`,
          { token: adminToken }
        );
        assert.equal(device.response.status, 200, JSON.stringify(device.body));
        assert.equal((device.body.serviceHealth as { comfyui?: boolean }).comfyui, true);
        assert.ok(
          (device.body.capabilities as string[]).includes("comfyui:image"),
          "the authenticated device heartbeat must persist the actual ComfyUI capability"
        );
      }
    );

    await t.test(
      "a real loopback ComfyUI image completes through the Worker, Durable Object, and local agent",
      {
        timeout: 240_000,
        skip:
          process.env.RUN_CLOUDFLARE_LOCAL_COMFYUI_IMAGE_INT !== "1"
            ? "Set RUN_CLOUDFLARE_LOCAL_COMFYUI_IMAGE_INT=1 to run real loopback image generation."
            : false,
      },
      async (imageTest) => {
        const comfyUrl = process.env.OMNIROUTE_LOCAL_COMFYUI_URL ?? "http://127.0.0.1:8188";
        const comfyCustomer = await provisionCustomer("real-comfy-image", true, ["comfyui:image"]);
        const runnerConfig = {
          gatewayUrl: baseUrl,
          deviceId: comfyCustomer.deviceId,
          credential: comfyCustomer.credential,
          comfyUiUrl: comfyUrl,
          requestTimeoutMs: 5_000,
        };
        const discovery = await discoverLocalCapabilities(runnerConfig, {
          fetch,
          resolveHost: async () => ["127.0.0.1"],
        });
        assert.ok(
          discovery.heartbeat.capabilities.includes("comfyui:image"),
          `loopback ComfyUI must expose image generation: ${JSON.stringify(discovery)}`
        );
        const comfyService = discovery.services.find((service) => service.service === "comfyui");
        const checkpoints = (comfyService?.models ?? [])
          .filter((model) => model.startsWith("comfyui:checkpoint:"))
          .map((model) => model.slice("comfyui:checkpoint:".length));
        assert.ok(checkpoints.length > 0, "ComfyUI must expose an installed checkpoint");

        const runnerDependencies = {
          fetch,
          resolveHost: async () => ["127.0.0.1"],
          gateway: deviceTransport,
        };
        const initialCycle = await runLocalAgentGatewayCycle(runnerConfig, runnerDependencies);
        let session: LocalAgentGatewaySession | undefined = initialCycle.session;
        assert.equal(initialCycle.processed, 0);

        const jobResponse = await requestJson(`${baseUrl}/__gateway/v1/customer/image-jobs`, {
          token: comfyCustomer.customerKey,
          headers: { "Idempotency-Key": `comfy-image-${randomUUID()}` },
          body: {
            deviceId: comfyCustomer.deviceId,
            prompt: "a small red apple on a white background",
            negativePrompt: "blurry, distorted",
            width: 64,
            height: 64,
            steps: 1,
            cfg: 1,
            seed: Number.parseInt(randomUUID().slice(0, 8), 16),
          },
        });
        assert.equal(jobResponse.response.status, 202, JSON.stringify(jobResponse.body));
        assert.equal(jobResponse.body.status, "queued");
        const jobId = String(jobResponse.body.jobId);
        assert.match(jobId, /^[a-f0-9-]{36}$/i);

        let processed = 0;
        const deadline = Date.now() + 90_000;
        while (processed === 0 && Date.now() < deadline) {
          const cycle = await runLocalAgentGatewayCycle(runnerConfig, runnerDependencies, session);
          session = cycle.session;
          processed = cycle.processed;
          if (processed === 0) await delay(25);
        }
        assert.equal(processed, 1, "the local agent should complete the queued ComfyUI image job");

        let status: Record<string, unknown> = {};
        const statusDeadline = Date.now() + 10_000;
        while (Date.now() < statusDeadline) {
          const result = await requestJson(`${baseUrl}/__gateway/v1/customer/image-jobs/${jobId}`, {
            token: comfyCustomer.customerKey,
          });
          assert.equal(result.response.status, 200, JSON.stringify(result.body));
          status = result.body;
          if (status.status === "succeeded" || status.status === "failed") break;
          await delay(100);
        }
        assert.equal(status.status, "succeeded", JSON.stringify(status));
        assert.equal(status.imageAvailable, true);
        const imageResponse = await fetch(
          `${baseUrl}/__gateway/v1/customer/image-jobs/${jobId}/image`,
          {
            headers: { authorization: `Bearer ${comfyCustomer.customerKey}` },
            signal: AbortSignal.timeout(10_000),
          }
        );
        assert.equal(imageResponse.status, 200);
        assert.equal(imageResponse.headers.get("content-type"), "image/png");
        assert.equal(imageResponse.headers.get("x-content-type-options"), "nosniff");
        const bytes = new Uint8Array(await imageResponse.arrayBuffer());
        assert.ok(bytes.byteLength > 8, "the returned image must contain pixel data");
        assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);

        await imageTest.test(
          "Front Desk serves the real local image through its tenant-resolved Worker routes",
          {
            timeout: 120_000,
            skip: !process.env.FRONT_DESK_REPO
              ? "Set FRONT_DESK_REPO to run the Front Desk-to-real-ComfyUI integration."
              : false,
          },
          async (frontDeskTest) => {
            const frontDeskRepo = path.resolve(process.env.FRONT_DESK_REPO!);
            const host = "tenant-real-comfy.frontdesk.test";
            const registered = await requestJson(`${baseUrl}/__cloud/v1/tenant-hosts`, {
              token: adminToken,
              body: { tenantId: comfyCustomer.tenantId, hostname: host },
            });
            assert.equal(registered.response.status, 201, JSON.stringify(registered.body));

            const frontDeskTempDir = await mkdtemp(path.join(tempDir, "front-desk-comfy-image-"));
            const frontDeskHome = path.join(frontDeskTempDir, "home");
            await mkdir(frontDeskHome, { recursive: true });
            for (const filename of [
              "server.js",
              "omnirouteConfig.js",
              "businessProfileClient.js",
              "leadStore.js",
              "chatRateLimit.js",
            ]) {
              await copyFile(
                path.join(frontDeskRepo, filename),
                path.join(frontDeskTempDir, filename)
              );
            }
            await writeFile(path.join(frontDeskTempDir, "leads.json"), "[]\n", { mode: 0o600 });

            const frontDeskPort = await getUnusedPort();
            const customerKeyEnv = "FRONT_DESK_REAL_COMFY_KEY";
            const dashboardTokenEnv = "FRONT_DESK_REAL_COMFY_DASHBOARD";
            const frontDeskTenants = [
              {
                tenantId: comfyCustomer.tenantId,
                dashboardTokenEnv,
                gateway: {
                  baseUrl,
                  customerApiKeyEnv: customerKeyEnv,
                  deviceId: comfyCustomer.deviceId,
                  ollamaModel: "integration-test",
                  imageGeneration: { width: 256, height: 256, steps: 1, cfg: 1 },
                },
                business: {
                  name: "Real ComfyUI Front Desk Integration",
                  description: "Isolated image-job test",
                  hours: "Always",
                  services: [],
                  assistant: {
                    name: "Image assistant",
                    tone: "helpful",
                    handoff: "Offer a follow-up.",
                  },
                },
              },
            ];
            const frontDeskChild = spawn(process.execPath, ["server.js"], {
              cwd: frontDeskTempDir,
              env: {
                PATH: process.env.PATH ?? "",
                HOME: frontDeskHome,
                NODE_ENV: "test",
                NO_COLOR: "1",
                PORT: String(frontDeskPort),
                FRONT_DESK_HOST_REGISTRY_URL: baseUrl,
                FRONT_DESK_TENANTS_JSON: JSON.stringify(frontDeskTenants),
                [customerKeyEnv]: comfyCustomer.customerKey,
                [dashboardTokenEnv]: "local-real-comfy-dashboard-token",
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let frontDeskOutput = "";
            const appendFrontDeskOutput = (chunk: Buffer) => {
              frontDeskOutput = `${frontDeskOutput}${chunk.toString("utf8")}`.slice(-10_000);
            };
            frontDeskChild.stdout?.on("data", appendFrontDeskOutput);
            frontDeskChild.stderr?.on("data", appendFrontDeskOutput);
            frontDeskTest.after(async () => {
              await stopWorker(frontDeskChild);
              await rm(frontDeskTempDir, { recursive: true, force: true });
            });

            let ready = false;
            const readyDeadline = Date.now() + 10_000;
            while (Date.now() < readyDeadline) {
              if (frontDeskChild.exitCode !== null) {
                assert.fail(`Front Desk exited before readiness:\n${frontDeskOutput}`);
              }
              try {
                const health = await requestHostJson(frontDeskPort, host, "/api/health");
                if (health.status === 200) {
                  ready = true;
                  break;
                }
              } catch {
                // Wait for the isolated Front Desk fixture to start.
              }
              await delay(50);
            }
            assert.equal(ready, true, `Front Desk did not become ready:\n${frontDeskOutput}`);

            const created = await requestHostJson(frontDeskPort, host, "/api/image-jobs", {
              prompt: "a small red apple on a white background",
              negativePrompt: "blurry, distorted",
            });
            assert.equal(created.status, 202, JSON.stringify(created.body));
            assert.equal(created.body.status, "queued");
            const frontDeskJobId = String(created.body.jobId);
            assert.match(frontDeskJobId, /^[a-f0-9-]{36}$/i);

            const cycle = await runLocalAgentGatewayCycle(
              runnerConfig,
              runnerDependencies,
              session
            );
            session = cycle.session;
            assert.equal(cycle.processed, 1, "Local Agent should execute the Front Desk image job");

            let frontDeskStatus: Record<string, unknown> = {};
            const statusDeadline = Date.now() + 10_000;
            while (Date.now() < statusDeadline) {
              const response = await requestHostJson(
                frontDeskPort,
                host,
                `/api/image-jobs/${frontDeskJobId}`
              );
              assert.equal(response.status, 200, JSON.stringify(response.body));
              frontDeskStatus = response.body;
              if (["succeeded", "failed"].includes(String(frontDeskStatus.status))) break;
              await delay(100);
            }
            assert.equal(frontDeskStatus.status, "succeeded", JSON.stringify(frontDeskStatus));
            assert.equal(frontDeskStatus.imageAvailable, true);

            const frontDeskImage = await requestHostBytes(
              frontDeskPort,
              host,
              `/api/image-jobs/${frontDeskJobId}/image`
            );
            assert.equal(frontDeskImage.status, 200);
            assert.equal(frontDeskImage.headers["content-type"], "image/png");
            assert.equal(frontDeskImage.headers["x-content-type-options"], "nosniff");
            assert.deepEqual(
              Array.from(frontDeskImage.body.subarray(0, 8)),
              [137, 80, 78, 71, 13, 10, 26, 10]
            );
            assert.ok(frontDeskImage.body.byteLength > 8);
            assert.equal(
              JSON.stringify(created.body).includes(comfyCustomer.customerKey),
              false,
              "Front Desk image-job responses must not expose the tenant API key"
            );
          }
        );
      }
    );

    const resultA = await invokeAndComplete(customerA, "handled by customer A device");
    const resultB = await invokeAndComplete(customerB, "handled by customer B device");
    assert.notEqual(resultA.requestId, resultB.requestId);

    await t.test(
      "maintenance can suspend and restore one tenant with a sanitized audit trail",
      async () => {
        const lifecycleUrl = `${baseUrl}/__cloud/v1/tenants/${customerA.tenantId}/status`;
        const suspended = await requestJson(lifecycleUrl, {
          method: "POST",
          token: maintenanceToken,
          body: { status: "suspended" },
        });
        assert.equal(
          suspended.response.status,
          200,
          `maintenance should suspend tenant A: ${JSON.stringify(suspended.body)}`
        );
        assert.equal(suspended.body.isActive, false);

        assert.equal(
          await deviceTransport.heartbeat(customerA.session!, [capability]),
          false,
          "suspending tenant A should invalidate its existing device session"
        );
        assert.equal(
          (
            await invoke(
              customerA.customerKey,
              customerA.deviceId,
              `suspended-tenant-${randomUUID()}`
            )
          ).response.status,
          401,
          "tenant A's customer key must stop working while suspended"
        );
        await invokeAndComplete(customerB, "tenant B remains available during tenant A suspension");

        const auditSql = `SELECT action, actor, target, resource_type, status, metadata_json, details_json
        FROM cloud_compliance_audit
        WHERE action = 'tenant.lifecycle.status' AND target = '${customerA.tenantId}'
        ORDER BY timestamp DESC, id DESC LIMIT 2;`;
        const auditResult = spawnSync(
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
            "--command",
            auditSql,
            "--json",
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
          auditResult.status,
          0,
          `local D1 lifecycle audit query failed:\n${auditResult.stdout}\n${auditResult.stderr}`
        );
        const auditOutput: unknown = JSON.parse(auditResult.stdout);
        assert.ok(Array.isArray(auditOutput), "Wrangler should return D1 query results as JSON");
        const auditRecords = auditOutput.flatMap((entry: unknown) => {
          if (entry === null || typeof entry !== "object") return [];
          const results = (entry as { results?: unknown }).results;
          return Array.isArray(results) ? results : [];
        }) as Array<Record<string, unknown>>;
        assert.equal(
          auditRecords.length,
          2,
          "the lifecycle should record attempted and successful audit rows"
        );
        for (const record of auditRecords) {
          assert.equal(record.action, "tenant.lifecycle.status");
          assert.equal(record.actor, "cloud-maintenance");
          assert.equal(record.target, customerA.tenantId);
          assert.equal(record.resource_type, "tenant");
          assert.equal(record.details_json, null);
          assert.deepEqual(JSON.parse(String(record.metadata_json)), { status: "suspended" });
        }
        assert.deepEqual(
          new Set(auditRecords.map((record) => record.status)),
          new Set(["attempted", "success"])
        );

        const resumed = await requestJson(lifecycleUrl, {
          method: "POST",
          token: maintenanceToken,
          body: { status: "active" },
        });
        assert.equal(
          resumed.response.status,
          200,
          `maintenance should resume tenant A: ${JSON.stringify(resumed.body)}`
        );
        assert.equal(resumed.body.isActive, true);

        const freshSession = await deviceTransport.connect(
          customerA.deviceId,
          customerA.credential
        );
        assert.ok(
          freshSession,
          "the still-registered device should reconnect after tenant recovery"
        );
        assert.equal(
          await deviceTransport.heartbeat(freshSession, [capability]),
          true,
          "a fresh session should heartbeat after tenant recovery"
        );
        customerA.session = freshSession;
        await invokeAndComplete(customerA, "tenant A works after maintenance recovery");
      }
    );

    const crossTenantA = await invoke(
      customerA.customerKey,
      customerB.deviceId,
      `cross-tenant-${randomUUID()}`
    );
    assert.equal(
      crossTenantA.response.status,
      404,
      `tenant A key must not invoke tenant B device: ${JSON.stringify(crossTenantA.body)}`
    );
    const crossTenantB = await invoke(
      customerB.customerKey,
      customerA.deviceId,
      `cross-tenant-${randomUUID()}`
    );
    assert.equal(
      crossTenantB.response.status,
      404,
      `tenant B key must not invoke tenant A device: ${JSON.stringify(crossTenantB.body)}`
    );

    const revokedDevice = await provisionCustomer("revoked");
    const revokeResult = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/${revokedDevice.tenantId}/gateway-devices/${revokedDevice.deviceId}`,
      { token: adminToken, method: "DELETE" }
    );
    assert.equal(revokeResult.response.status, 200);
    assert.equal(
      await deviceTransport.heartbeat(revokedDevice.session!, [capability]),
      false,
      "revocation should invalidate the existing Durable Object session"
    );
    assert.equal(
      (
        await invoke(
          revokedDevice.customerKey,
          revokedDevice.deviceId,
          `revoked-device-${randomUUID()}`
        )
      ).response.status,
      503,
      "revoked device must not accept a customer invocation"
    );

    const offlineDevice = await provisionCustomer("offline", false);
    assert.equal(
      (
        await invoke(
          offlineDevice.customerKey,
          offlineDevice.deviceId,
          `offline-device-${randomUUID()}`
        )
      ).response.status,
      503,
      "registered but offline device must not accept a customer invocation"
    );

    // The local worker config and environment were generated under tempDir, not
    // the repository; assert this invariant to guard against future test changes.
    const localEnv = await readFile(path.join(tempDir, ".env"), "utf8");
    assert.equal(localEnv, `${localSecrets}\n`);
  }
);
