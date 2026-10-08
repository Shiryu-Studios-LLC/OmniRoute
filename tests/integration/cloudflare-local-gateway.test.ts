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
    const readiness = await requestJson(`${baseUrl}/__cloud/readiness`);
    assert.equal(readiness.response.status, 200);
    assert.deepEqual(readiness.body.checks, { database: "ok", gateway: "ok" });
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

    const provisionCustomer = async (label: string, connectDevice = true) => {
      const tenantId = `local-${label}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const tenantResult = await requestJson(`${baseUrl}/__cloud/v1/tenants`, {
        token: adminToken,
        body: { id: tenantId, name: `Local Integration ${label}`, slug: tenantId },
      });
      assert.equal(
        tenantResult.response.status,
        201,
        `${label} tenant provisioning failed: ${JSON.stringify(tenantResult.body)}\n${output}`
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

      const session = connectDevice ? await deviceTransport.connect(deviceId, credential) : null;
      if (connectDevice) {
        assert.ok(session, `${label} device credential should authenticate through Worker and D1`);
        assert.equal(await deviceTransport.heartbeat(session!, [capability]), true);
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
        for (const filename of ["server.js", "omnirouteConfig.js", "leadStore.js"]) {
          await copyFile(path.join(frontDeskRepo, filename), path.join(frontDeskTempDir, filename));
        }
        await writeFile(path.join(frontDeskTempDir, "leads.json"), "[]\n", { mode: 0o600 });

        const frontDeskHost = "tenant-a.frontdesk.test";
        const frontDeskPort = await getUnusedPort();
        const frontDeskKeyEnv = "FRONT_DESK_LOCAL_GATEWAY_KEY";
        const frontDeskDashboardEnv = "FRONT_DESK_LOCAL_GATEWAY_DASHBOARD";
        const frontDeskTenants = [
          {
            host: frontDeskHost,
            tenantId: customerA.tenantId,
            dashboardTokenEnv: frontDeskDashboardEnv,
            gateway: {
              baseUrl,
              customerApiKeyEnv: frontDeskKeyEnv,
              deviceId: customerA.deviceId,
              ollamaModel: "integration-test",
            },
            business: {
              name: "Local Gateway Integration",
              description: "Isolated test business",
              hours: "Always",
              services: [],
              assistant: {
                name: "Integration assistant",
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
            [frontDeskKeyEnv]: customerA.customerKey,
            [frontDeskDashboardEnv]: "local-frontdesk-dashboard-token",
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
      }
    );

    const invoke = (customerKey: string, deviceId: string, idempotencyKey: string) =>
      requestJson(`${baseUrl}/__gateway/v1/customer/invoke`, {
        token: customerKey,
        headers: { "Idempotency-Key": idempotencyKey },
        body: {
          deviceId,
          capability,
          payload: { prompt: "local Worker integration payload" },
          timeoutMs: 10_000,
        },
      });

    const invokeAndComplete = async (customer: typeof customerA, expectedAnswer: string) => {
      const idempotencyKey = `local-replay-${randomUUID()}`;
      const invocation = invoke(customer.customerKey, customer.deviceId, idempotencyKey);
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

      const replayResult = await invoke(customer.customerKey, customer.deviceId, idempotencyKey);
      assert.equal(replayResult.response.status, 200);
      assert.deepEqual(replayResult.body, firstResult.body);
      assert.equal(
        (await deviceTransport.poll(customer.session!))?.length,
        0,
        "replay must not enqueue again"
      );
      return firstResult.body;
    };

    const resultA = await invokeAndComplete(customerA, "handled by customer A device");
    const resultB = await invokeAndComplete(customerB, "handled by customer B device");
    assert.notEqual(resultA.requestId, resultB.requestId);

    assert.equal(
      (await invoke(customerA.customerKey, customerB.deviceId, `cross-tenant-${randomUUID()}`))
        .response.status,
      404,
      "tenant A key must not invoke tenant B device"
    );
    assert.equal(
      (await invoke(customerB.customerKey, customerA.deviceId, `cross-tenant-${randomUUID()}`))
        .response.status,
      404,
      "tenant B key must not invoke tenant A device"
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
    assert.equal(localEnv, `OMNIROUTE_CLOUD_ADMIN_TOKEN=${adminToken}\n`);
  }
);
