import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const enabled = process.env.RUN_CLOUDFLARE_MCP_TENANT_INT === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const adminToken = "local-mcp-tenant-integration-admin-token-only";
const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(43)));
const hmacKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(61)));

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

test(
  "local Wrangler keeps MCP registries and credentials isolated between customer tenants",
  {
    skip:
      !enabled &&
      "Set RUN_CLOUDFLARE_MCP_TENANT_INT=1 to run the local Wrangler MCP tenant integration.",
    timeout: 120_000,
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "omniroute-cloud-mcp-tenant-int-"));
    const homeDir = path.join(tempDir, "home");
    const persistDir = path.join(tempDir, "wrangler-state");
    await mkdir(homeDir, { recursive: true });

    const workerName = `omniroute-mcp-tenant-int-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const wranglerConfigPath = path.join(tempDir, "wrangler.jsonc");
    const safeEnvPath = path.join(tempDir, "local.env");
    const baseUrl = `http://127.0.0.1:${await getUnusedPort()}`;
    const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
    const secrets = [
      `OMNIROUTE_CLOUD_ADMIN_TOKEN=${adminToken}`,
      `OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY=${encryptionKey}`,
      `OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY=${hmacKey}`,
      "OMNIROUTE_ENV=local-mcp-tenant-integration",
    ].join("\n");
    await writeFile(path.join(tempDir, ".dev.vars"), `${secrets}\n`, { mode: 0o600 });
    await writeFile(path.join(tempDir, ".env"), `${secrets}\n`, { mode: 0o600 });
    await writeFile(safeEnvPath, `${secrets}\n`, { mode: 0o600 });
    const wranglerConfig = {
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
      r2_buckets: [{ binding: "GATEWAY_ARTIFACTS", bucket_name: `${workerName}-artifacts` }],
      durable_objects: {
        bindings: [{ name: "GATEWAY_SESSIONS", class_name: "GatewaySessionObject" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["GatewaySessionObject"] }],
    };
    await writeFile(wranglerConfigPath, `${JSON.stringify(wranglerConfig, null, 2)}\n`, {
      mode: 0o600,
    });

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
    const migration = runWrangler([
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
      migration.status,
      0,
      `D1 migrations failed:\n${migration.stdout}\n${migration.stderr}`
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
      { cwd: tempDir, env: commandEnv, stdio: ["ignore", "pipe", "pipe"] }
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

    const provision = async (label: string) => {
      const tenantId = `mcp-${label}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const response = await requestJson(`${baseUrl}/__cloud/v1/tenants`, {
        token: adminToken,
        body: {
          id: tenantId,
          name: `MCP Customer ${label}`,
          slug: tenantId,
          ownerPrincipalId: `principal-${tenantId}`,
        },
      });
      assert.equal(response.response.status, 201, `${JSON.stringify(response.body)}\n${output}`);
      const token = (response.body.ownerApiKey as { token?: unknown } | undefined)?.token;
      assert.equal(typeof token, "string");
      return { tenantId, token: token as string };
    };
    const tenantA = await provision("a");
    const tenantB = await provision("b");
    const settingsUrl = `${baseUrl}/__cloud/v1/customer/settings`;
    for (const tenant of [tenantA, tenantB]) {
      const settings = await requestJson(settingsUrl, {
        method: "PUT",
        token: tenant.token,
        body: { localAiEnabled: false, mcpEnabled: true },
      });
      assert.equal(settings.response.status, 200, JSON.stringify(settings.body));
      assert.equal(settings.body.mcpEnabled, true);
    }

    const collection = `${baseUrl}/__cloud/v1/customer/mcp-servers`;
    const secretA = "mcp-tenant-a-integration-secret";
    const secretB = "mcp-tenant-b-integration-secret";
    const createdA = await requestJson(collection, {
      token: tenantA.token,
      body: {
        name: "Tenant A MCP",
        transport: "streamable_http",
        endpoint: "https://tenant-a-mcp.example.test/mcp",
        credential: secretA,
      },
    });
    assert.equal(createdA.response.status, 201, `${JSON.stringify(createdA.body)}\n${output}`);
    const serverA = createdA.body.server as Record<string, unknown>;
    assert.equal(serverA.name, "Tenant A MCP");
    assert.equal(serverA.hasCredential, true);
    const serverAId = String(serverA.id);

    const createdB = await requestJson(collection, {
      token: tenantB.token,
      body: {
        name: "Tenant B MCP",
        transport: "streamable_http",
        endpoint: "https://tenant-b-mcp.example.test/mcp",
        credential: secretB,
      },
    });
    assert.equal(createdB.response.status, 201, `${JSON.stringify(createdB.body)}\n${output}`);
    const serverB = createdB.body.server as Record<string, unknown>;
    assert.equal(serverB.name, "Tenant B MCP");
    assert.equal(serverB.hasCredential, true);
    const serverBId = String(serverB.id);
    assert.notEqual(serverAId, serverBId);

    for (const body of [createdA.body, createdB.body]) {
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes(secretA), false, "MCP response leaked tenant A credential");
      assert.equal(serialized.includes(secretB), false, "MCP response leaked tenant B credential");
      assert.equal(serialized.includes("credentialEncrypted"), false);
    }

    const listedA = await requestJson(collection, { token: tenantA.token });
    const listedB = await requestJson(collection, { token: tenantB.token });
    assert.equal(listedA.response.status, 200);
    assert.equal(listedB.response.status, 200);
    assert.deepEqual(
      (listedA.body.servers as Array<Record<string, unknown>>).map((server) => server.name),
      ["Tenant A MCP"]
    );
    assert.deepEqual(
      (listedB.body.servers as Array<Record<string, unknown>>).map((server) => server.name),
      ["Tenant B MCP"]
    );

    const foreignRead = await requestJson(`${collection}/${serverAId}`, { token: tenantB.token });
    assert.equal(foreignRead.response.status, 404, "tenant B must not read tenant A's server");
    const foreignDelete = await requestJson(`${collection}/${serverAId}`, {
      method: "DELETE",
      token: tenantB.token,
    });
    assert.equal(foreignDelete.response.status, 404, "tenant B must not delete tenant A's server");
    const remainsA = await requestJson(`${collection}/${serverAId}`, { token: tenantA.token });
    assert.equal(remainsA.response.status, 200, "foreign delete must leave tenant A's row intact");
    const ownDelete = await requestJson(`${collection}/${serverAId}`, {
      method: "DELETE",
      token: tenantA.token,
    });
    assert.equal(ownDelete.response.status, 200);
    const remainsB = await requestJson(`${collection}/${serverBId}`, { token: tenantB.token });
    assert.equal(remainsB.response.status, 200, "tenant A deletion must not alter tenant B's row");

    const stored = runWrangler([
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
      `SELECT tenant_id, id, credential_encrypted FROM cloud_tenant_mcp_servers WHERE id IN ('${serverAId}', '${serverBId}'); SELECT tenant_id, action, metadata_json, details_json FROM cloud_compliance_audit WHERE action LIKE 'cloud.mcp_server.%' AND tenant_id IN ('${tenantA.tenantId}', '${tenantB.tenantId}');`,
    ]);
    assert.equal(stored.status, 0, `D1 query failed:\n${stored.stdout}\n${stored.stderr}`);
    const queryResults = JSON.parse(stored.stdout) as Array<{
      results?: Array<Record<string, unknown>>;
    }>;
    const rows = queryResults.flatMap((result) => result.results ?? []);
    const credentialRows = rows.filter((row) => Object.hasOwn(row, "credential_encrypted"));
    assert.equal(credentialRows.length, 1, "tenant A deletion must leave only tenant B's D1 row");
    assert.equal(credentialRows[0].tenant_id, tenantB.tenantId);
    assert.match(String(credentialRows[0].credential_encrypted), /^enc:v[12]:/);
    const auditRows = rows.filter((row) => Object.hasOwn(row, "metadata_json"));
    assert.ok(auditRows.length >= 3, "create and delete operations should be audited");
    const serializedAudit = JSON.stringify(auditRows);
    assert.equal(serializedAudit.includes(secretA), false, "audit leaked tenant A credential");
    assert.equal(serializedAudit.includes(secretB), false, "audit leaked tenant B credential");
    assert.ok(auditRows.every((row) => row.details_json === null));
  }
);
