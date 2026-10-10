import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const enabled = process.env.RUN_CLOUDFLARE_CUSTOMER_PROVIDER_INT === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const identityAdminToken = "local-customer-provider-identity-scope-token-123456";
const inferenceAdminToken = "local-customer-provider-inference-scope-token-123456";
const lifecycleAdminToken = "local-customer-provider-lifecycle-scope-token-123456";
const tenantHostsAdminToken = "local-customer-provider-hosts-scope-token-123456";
const frontDeskAdminToken = "local-customer-provider-frontdesk-scope-token-123456";
const maintenanceToken = "local-customer-provider-maintenance-scope-token-123456";
const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(37)));
const idempotencyKeySecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(43)));
const originalApiKey = "sk-local-customer-provider-integration-original-secret";
const replacementApiKey = "sk-local-customer-provider-integration-replacement-secret";

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

async function requestJsonArray(
  url: string,
  token: string
): Promise<{ response: Response; body: Array<Record<string, unknown>> }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json();
  assert.ok(Array.isArray(body));
  return { response, body: body as Array<Record<string, unknown>> };
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

test(
  "local Wrangler customer provider connections are tenant-scoped and keep credentials encrypted",
  {
    skip:
      !enabled &&
      "Set RUN_CLOUDFLARE_CUSTOMER_PROVIDER_INT=1 to run the local Wrangler customer provider integration.",
    timeout: 120_000,
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "omniroute-cloud-customer-provider-int-"));
    const homeDir = path.join(tempDir, "home");
    const persistDir = path.join(tempDir, "wrangler-state");
    await mkdir(homeDir, { recursive: true });

    const workerName = `omniroute-customer-provider-int-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const wranglerConfigPath = path.join(tempDir, "wrangler.jsonc");
    const safeEnvPath = path.join(tempDir, "local.env");
    const baseUrl = `http://127.0.0.1:${await getUnusedPort()}`;
    const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
    const vars = [
      `OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN=${identityAdminToken}`,
      `OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN=${inferenceAdminToken}`,
      `OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN=${lifecycleAdminToken}`,
      `OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN=${tenantHostsAdminToken}`,
      `OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN=${frontDeskAdminToken}`,
      `OMNIROUTE_CLOUD_MAINTENANCE_TOKEN=${maintenanceToken}`,
      `OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY=${encryptionKey}`,
      `OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY=${idempotencyKeySecret}`,
      "OMNIROUTE_ENV=staging",
    ].join("\n");
    await writeFile(path.join(tempDir, ".dev.vars"), `${vars}\n`, { mode: 0o600 });
    await writeFile(path.join(tempDir, ".env"), `${vars}\n`, { mode: 0o600 });
    await writeFile(safeEnvPath, `${vars}\n`, { mode: 0o600 });
    await writeFile(
      wranglerConfigPath,
      JSON.stringify(
        {
          name: workerName,
          main: path.join(repoRoot, "cloudflare", "worker.ts"),
          compatibility_date: "2026-10-08",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: workerName,
              migrations_dir: path.join(repoRoot, "cloudflare", "migrations"),
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
    const runWrangler = (args: string[], timeout = 60_000) =>
      spawnSync(process.execPath, [wranglerBin, ...args], {
        cwd: tempDir,
        env: commandEnv,
        encoding: "utf8",
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      });
    const migrationResult = runWrangler([
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
    ]);
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
          env: commandEnv,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
    const child = startWorker();
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

    const provisionTenant = async (label: string) => {
      const tenantId = `provider-${label}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const provisioned = await requestJson(`${baseUrl}/__cloud/v1/tenants`, {
        token: lifecycleAdminToken,
        body: {
          id: tenantId,
          name: `Customer Provider ${label}`,
          slug: tenantId,
          ownerPrincipalId: `principal-${tenantId}`,
        },
      });
      assert.equal(
        provisioned.response.status,
        201,
        `${label} tenant provisioning failed: ${JSON.stringify(provisioned.body)}\n${output}`
      );
      const token = (provisioned.body.ownerApiKey as { token?: unknown } | undefined)?.token;
      assert.equal(typeof token, "string");
      assert.match(token as string, /^orc_live_/);
      return { tenantId, token: token as string };
    };
    const customerA = await provisionTenant("a");
    const customerB = await provisionTenant("b");
    const collectionUrl = `${baseUrl}/__cloud/v1/customer/provider-connections`;
    const connectionId = `openai-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;

    // Provider nodes are available to tenant owners in staging, and both their
    // rows and encrypted headers must remain tenant-qualified in D1.
    const nodeId = `node-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const nodeAUrl = `${baseUrl}/__cloud/v1/tenants/${customerA.tenantId}/provider-nodes`;
    const nodeBUrl = `${baseUrl}/__cloud/v1/tenants/${customerB.tenantId}/provider-nodes`;
    const nodeSecret = "x-customer-a-node-secret";
    const createdNode = await requestJson(nodeAUrl, {
      token: customerA.token,
      body: {
        id: nodeId,
        type: "openai-compatible",
        name: "Customer A node",
        prefix: "customer-a",
        baseUrl: "https://api.example.invalid/v1",
        customHeadersJson: JSON.stringify({ "x-api-key": nodeSecret }),
      },
    });
    assert.equal(createdNode.response.status, 201, JSON.stringify(createdNode.body));
    assert.equal(createdNode.body.tenantId, customerA.tenantId);
    assert.equal(createdNode.body.hasCustomHeaders, true);
    assert.equal(JSON.stringify(createdNode.body).includes(nodeSecret), false);

    const listedNodesA = await requestJsonArray(nodeAUrl, customerA.token);
    assert.equal(listedNodesA.response.status, 200);
    assert.deepEqual(
      listedNodesA.body.map((node) => node.id),
      [nodeId]
    );
    assert.equal(JSON.stringify(listedNodesA.body).includes(nodeSecret), false);
    const listedNodesB = await requestJsonArray(nodeBUrl, customerB.token);
    assert.equal(listedNodesB.response.status, 200);
    assert.deepEqual(listedNodesB.body, []);
    const crossTenantNode = await requestJson(`${nodeBUrl}/${nodeId}`, { token: customerB.token });
    assert.equal(crossTenantNode.response.status, 404);

    const created = await requestJson(collectionUrl, {
      token: customerA.token,
      body: { id: connectionId, provider: "openai", apiKey: originalApiKey, name: "Initial" },
    });
    assert.equal(created.response.status, 201, `${JSON.stringify(created.body)}\n${output}`);
    assert.equal(created.body.id, connectionId);
    assert.equal(created.body.hasCredentials, true);
    assert.equal(created.body.credentialOwnership, "customer_managed");
    assert.equal(created.body.executionLocation, "third_party");

    const listUrl = `${collectionUrl}`;
    const listed = await requestJson(listUrl, { token: customerA.token });
    assert.equal(listed.response.status, 200);
    assert.ok(Array.isArray(listed.body.connections));
    assert.equal((listed.body.connections as Array<Record<string, unknown>>).length, 1);

    const updateUrl = `${collectionUrl}/${connectionId}`;
    const updated = await requestJson(updateUrl, {
      method: "PATCH",
      token: customerA.token,
      body: { apiKey: replacementApiKey, name: "Updated", priority: 7 },
    });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.name, "Updated");
    assert.equal(updated.body.priority, 7);
    assert.equal(updated.body.hasCredentials, true);

    for (const body of [created.body, listed.body, updated.body]) {
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes(originalApiKey), false, "response leaked the original key");
      assert.equal(
        serialized.includes(replacementApiKey),
        false,
        "response leaked the replacement key"
      );
      assert.equal(serialized.includes('"apiKey"'), false, "response exposed an apiKey field");
    }

    const readStoredState = () => {
      const query = runWrangler(
        [
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
          "--json",
          "--command",
          `SELECT tenant_id, id, api_key FROM provider_connections WHERE tenant_id = '${customerA.tenantId}' AND id = '${connectionId}'; SELECT tenant_id, id, custom_headers_json FROM provider_nodes WHERE tenant_id = '${customerA.tenantId}' AND id = '${nodeId}'; SELECT action, metadata_json FROM cloud_compliance_audit WHERE tenant_id = '${customerA.tenantId}' AND resource_type = 'cloud-provider-connection';`,
        ],
        30_000
      );
      assert.equal(query.status, 0, `D1 query failed:\n${query.stdout}\n${query.stderr}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(query.stdout);
      } catch {
        assert.fail(`Expected JSON from Wrangler D1 query:\n${query.stdout}\n${query.stderr}`);
      }
      assert.ok(Array.isArray(parsed), `Unexpected D1 JSON output: ${query.stdout}`);
      return parsed as Array<{ results?: Array<Record<string, unknown>> }>;
    };
    const storedState = readStoredState();
    const connectionRows = storedState
      .flatMap((result) => result.results ?? [])
      .filter((row) => Object.hasOwn(row, "api_key"));
    assert.equal(connectionRows.length, 1);
    const encrypted = connectionRows[0].api_key;
    assert.equal(typeof encrypted, "string");
    assert.match(encrypted as string, /^enc:v[12]:/);
    assert.notEqual(encrypted, originalApiKey);
    assert.notEqual(encrypted, replacementApiKey);
    const nodeRows = storedState
      .flatMap((result) => result.results ?? [])
      .filter((row) => Object.hasOwn(row, "custom_headers_json"));
    assert.equal(nodeRows.length, 1);
    assert.equal(nodeRows[0].tenant_id, customerA.tenantId);
    assert.equal(nodeRows[0].id, nodeId);
    assert.match(String(nodeRows[0].custom_headers_json), /^enc:v[12]:/);
    assert.equal(String(nodeRows[0].custom_headers_json).includes(nodeSecret), false);
    const auditRows = storedState
      .flatMap((result) => result.results ?? [])
      .filter((row) => Object.hasOwn(row, "metadata_json"));
    assert.ok(auditRows.length >= 2, "create and update should both be audited");
    const serializedAudit = JSON.stringify(auditRows);
    assert.equal(serializedAudit.includes(originalApiKey), false, "audit leaked the original key");
    assert.equal(
      serializedAudit.includes(replacementApiKey),
      false,
      "audit leaked the replacement key"
    );

    const otherTenantList = await requestJson(collectionUrl, { token: customerB.token });
    assert.equal(otherTenantList.response.status, 200);
    assert.deepEqual(otherTenantList.body.connections, []);
    const otherTenantGet = await requestJson(updateUrl, { token: customerB.token });
    assert.equal(otherTenantGet.response.status, 404);

    const deleted = await requestJson(updateUrl, { method: "DELETE", token: customerA.token });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.deleted, true);
    const missing = await requestJson(updateUrl, { token: customerA.token });
    assert.equal(missing.response.status, 404);
    const emptyList = await requestJson(collectionUrl, { token: customerA.token });
    assert.deepEqual(emptyList.body.connections, []);
  }
);
