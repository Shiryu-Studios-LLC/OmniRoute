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
const adminToken = "local-maintenance-admin-token-only";
const maintenanceToken = "local-maintenance-token-only";
const expectedTasks = [
  "expired-rate-limits",
  "expired-gateway-pairings",
  "stale-inference-reservations",
  "settled-inference-reservations",
  "expired-inference-responses",
  "expired-oidc-artifacts",
  "expired-gateway-image-jobs",
] as const;

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

async function waitForWorker(url: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(`local Wrangler Worker exited before starting:\n${output()}`);
    }
    try {
      const response = await fetch(`${url}/__cloud/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Wrangler needs a short startup window before the local socket is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`local Wrangler Worker did not become ready:\n${output()}`);
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
  "local Wrangler scheduled event waits for every maintenance ledger write and retention cleanup",
  { skip: !enabled && "Set RUN_CLOUDFLARE_LOCAL_INT=1 to run the local Wrangler integration." },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "omniroute-cloud-maintenance-int-"));
    const homeDir = path.join(tempDir, "home");
    const persistDir = path.join(tempDir, "wrangler-state");
    await mkdir(homeDir, { recursive: true });

    const workerName = `omniroute-maintenance-${process.pid}-${Date.now()}`;
    const configPath = path.join(tempDir, "wrangler.jsonc");
    const envPath = path.join(tempDir, "local.env");
    const baseUrl = `http://127.0.0.1:${await getUnusedPort()}`;
    const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
    const secrets = [
      `OMNIROUTE_CLOUD_ADMIN_TOKEN=${adminToken}`,
      `OMNIROUTE_CLOUD_MAINTENANCE_TOKEN=${maintenanceToken}`,
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
          r2_buckets: [{ binding: "GATEWAY_ARTIFACTS", bucket_name: `${workerName}-artifacts` }],
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
        configPath,
        "--env-file",
        envPath,
      ],
      {
        cwd: tempDir,
        env: processEnv,
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

    const staleId = 9001;
    const staleFinishedAtMs = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const seedResult = spawnSync(
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
        configPath,
        "--env-file",
        envPath,
        "--command",
        `INSERT INTO cloud_maintenance_runs (id, task_key, started_at_ms, finished_at_ms, duration_ms, outcome) VALUES (${staleId}, 'expired-rate-limits', ${staleFinishedAtMs - 10}, ${staleFinishedAtMs}, 10, 'succeeded')`,
      ],
      {
        cwd: tempDir,
        env: processEnv,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    assert.equal(seedResult.status, 0, `seeding retention row failed:\n${seedResult.stderr}`);

    const port = new URL(baseUrl).port;
    const child = spawn(
      process.execPath,
      [
        wranglerBin,
        "dev",
        "--local",
        "--test-scheduled",
        "--ip",
        "127.0.0.1",
        "--port",
        port,
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
    const scheduled = await fetch(`${baseUrl}/__scheduled?cron=*+*+*+*+*`, {
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(scheduled.status, 200, `scheduled trigger failed:\n${output}`);
    assert.equal(await scheduled.text(), "Ran scheduled event");

    const historyUrl = `${baseUrl}/__cloud/v1/tenants/maintenance/runs?limit=100`;
    let runs: Array<Record<string, unknown>> = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = await fetch(historyUrl, {
        headers: { authorization: `Bearer ${adminToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      const responseText = await response.text();
      assert.equal(response.status, 200, `maintenance history failed:\n${responseText}`);
      const body = JSON.parse(responseText) as { runs: Array<Record<string, unknown>> };
      runs = body.runs;
      const taskKeys = new Set(runs.map((run) => run.taskKey));
      if (
        expectedTasks.every((taskKey) => taskKeys.has(taskKey)) &&
        !runs.some((run) => run.id === staleId)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const actualTasks = new Set(runs.map((run) => run.taskKey));
    assert.deepEqual(
      [...actualTasks].sort(),
      [...expectedTasks].sort(),
      `scheduled waitUntil did not persist all task outcomes:\n${JSON.stringify(runs)}\n${output}`
    );
    assert.ok(runs.every((run) => run.outcome === "succeeded"));
    assert.equal(
      runs.some((run) => run.id === staleId),
      false,
      "expired run was retained"
    );
  }
);
