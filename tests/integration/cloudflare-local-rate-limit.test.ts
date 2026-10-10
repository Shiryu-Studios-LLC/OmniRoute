import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const enabled = process.env.RUN_CLOUDFLARE_LOCAL_INT === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const identityToken = "local-rate-limit-identity-admin-token-1234567890";
const inferenceToken = "local-rate-limit-inference-admin-token-1234567890";
const lifecycleToken = "local-rate-limit-lifecycle-token-for-integration-123456";
const provisioningToken = "local-rate-limit-provisioning-token-1234567890";
const hostsToken = "local-rate-limit-hosts-admin-token-1234567890";
const frontDeskToken = "local-rate-limit-frontdesk-admin-token-1234567890";
const maintenanceToken = "local-rate-limit-maintenance-token-1234567890";
const credentialKey = Buffer.alloc(32, 51).toString("base64");
const idempotencyKey = Buffer.alloc(32, 52).toString("base64");
const limit = 300;

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function waitForWorker(url: string, child: ChildProcess, logs: () => string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(`local Wrangler Worker exited before starting:\n${logs()}`);
    }
    try {
      if ((await fetch(`${url}/__cloud/health`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {
      // Wrangler needs a short startup window before the local socket is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`local Wrangler Worker did not become ready:\n${logs()}`);
}

async function stopWorker(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

test(
  "local Wrangler D1 enforces concurrent rate limits independently for each tenant",
  {
    skip: !enabled && "Set RUN_CLOUDFLARE_LOCAL_INT=1 to run the local Wrangler integration.",
    timeout: 180_000,
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "omniroute-cloud-rate-limit-int-"));
    const homeDir = path.join(tempDir, "home");
    const persistDir = path.join(tempDir, "wrangler-state");
    await mkdir(homeDir, { recursive: true });

    const workerName = `omniroute-rate-limit-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const configPath = path.join(tempDir, "wrangler.jsonc");
    const envPath = path.join(tempDir, "local.env");
    const baseUrl = `http://127.0.0.1:${await unusedPort()}`;
    const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
    const secrets = [
      `OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN=${identityToken}`,
      `OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN=${inferenceToken}`,
      `OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN=${lifecycleToken}`,
      `OMNIROUTE_CLOUD_PROVISIONING_TOKEN=${provisioningToken}`,
      `OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN=${hostsToken}`,
      `OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN=${frontDeskToken}`,
      `OMNIROUTE_CLOUD_MAINTENANCE_TOKEN=${maintenanceToken}`,
      `OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY=${credentialKey}`,
      `OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY=${idempotencyKey}`,
      "OMNIROUTE_ENV=staging",
    ].join("\n");
    await writeFile(path.join(tempDir, ".env"), `${secrets}\n`, { mode: 0o600 });
    await writeFile(path.join(tempDir, ".dev.vars"), `${secrets}\n`, { mode: 0o600 });
    await writeFile(envPath, `${secrets}\n`, { mode: 0o600 });
    await writeFile(
      configPath,
      `${JSON.stringify(
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
      )}\n`,
      { mode: 0o600 }
    );

    const processEnv = {
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
        env: processEnv,
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
      configPath,
      "--env-file",
      envPath,
    ]);
    assert.equal(
      migration.status,
      0,
      `local D1 migrations failed:\n${migration.stdout}\n${migration.stderr}`
    );

    const seed = runWrangler([
      "d1",
      "execute",
      workerName,
      "--local",
      "--persist-to",
      persistDir,
      "--config",
      configPath,
      "--env-file",
      envPath,
      "--yes",
      "--command",
      `INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES
        ('rate-tenant-a', 'Rate Tenant A', 'rate-tenant-a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('rate-tenant-b', 'Rate Tenant B', 'rate-tenant-b', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`,
    ]);
    assert.equal(
      seed.status,
      0,
      `seeding rate-limit tenants failed:\n${seed.stdout}\n${seed.stderr}`
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
        configPath,
        "--env-file",
        envPath,
        "--show-interactive-dev-session=false",
      ],
      { cwd: tempDir, env: processEnv, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    t.after(async () => {
      await stopWorker(child);
      await rm(tempDir, { recursive: true, force: true });
    });
    await waitForWorker(baseUrl, child, () => output);

    const requestTenant = async (tenantId: string) =>
      fetch(`${baseUrl}/__cloud/v1/tenants/${tenantId}`, {
        headers: { authorization: `Bearer ${lifecycleToken}` },
        signal: AbortSignal.timeout(30_000),
      });

    const results = await Promise.all(
      Array.from({ length: limit + 1 }, () => requestTenant("rate-tenant-a"))
    );
    const allowed = results.filter((response) => response.status === 200);
    const denied = results.filter((response) => response.status === 429);
    const firstResponseBody = await results[0].clone().text();
    assert.equal(
      allowed.length,
      limit,
      `expected exactly ${limit} A requests to pass; got statuses ${results
        .map((response) => response.status)
        .join(",")}; first body ${firstResponseBody}; Worker log tail ${output.slice(-1_000)}`
    );
    assert.equal(denied.length, 1, "the excess A request should be rejected");
    assert.ok(
      results.every((response) => response.status === 200 || response.status === 429),
      `unexpected A response statuses: ${results.map((response) => response.status).join(",")}`
    );

    const tenantBResponse = await requestTenant("rate-tenant-b");
    assert.equal(tenantBResponse.status, 200, "tenant A's exhausted bucket must not affect B");
    const tenantBAgain = await requestTenant("rate-tenant-b");
    assert.equal(tenantBAgain.status, 200, "tenant B must have an independent request count");

    const query = runWrangler([
      "d1",
      "execute",
      workerName,
      "--local",
      "--persist-to",
      persistDir,
      "--config",
      configPath,
      "--env-file",
      envPath,
      "--yes",
      "--json",
      "--command",
      "SELECT tenant_id, bucket_hash, request_count, limit_count FROM cloud_rate_limits ORDER BY tenant_id;",
    ]);
    assert.equal(
      query.status,
      0,
      `reading local D1 rate limits failed:\n${query.stdout}\n${query.stderr}`
    );
    const outputRows = JSON.parse(query.stdout) as Array<{
      results?: Array<Record<string, unknown>>;
    }>;
    const rows = outputRows.flatMap((result) => result.results ?? []);
    assert.equal(rows.length, 2, "D1 should persist one independent bucket per tenant");
    assert.deepEqual(
      rows.map((row) => [row.tenant_id, Number(row.request_count), Number(row.limit_count)]),
      [
        ["rate-tenant-a", limit + 1, limit],
        ["rate-tenant-b", 2, limit],
      ]
    );
    assert.ok(
      rows.every(
        (row) => typeof row.bucket_hash === "string" && /^[a-f0-9]{64}$/.test(row.bucket_hash)
      ),
      "D1 should store hashed logical buckets instead of raw bucket labels"
    );
    const expectedBucketHash = createHash("sha256").update("cloud-admin-api").digest("hex");
    assert.ok(rows.every((row) => row.bucket_hash === expectedBucketHash));
  }
);
