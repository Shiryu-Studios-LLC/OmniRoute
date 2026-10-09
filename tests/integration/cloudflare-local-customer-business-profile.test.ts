import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const enabled = process.env.RUN_CLOUDFLARE_CUSTOMER_BUSINESS_PROFILE_INT === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const adminToken = "local-business-profile-integration-admin-token-only";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  options: { method?: string; token?: string; body?: unknown; host?: string } = {}
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.host ? { host: options.host } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`${method} ${url} failed before receiving a response`, { cause: error });
  }
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

async function requestWithHost(
  port: number,
  pathname: string,
  host: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: pathname,
        headers: { host },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          try {
            const body: unknown = JSON.parse(text);
            assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
            resolve({ status: response.statusCode ?? 0, body: body as Record<string, unknown> });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.setTimeout(10_000, () => req.destroy(new Error("Front Desk request timed out")));
    req.once("error", reject);
    req.end();
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
  "local Wrangler customer business profiles use D1 migration 0023 and isolate profile data",
  {
    skip:
      !enabled &&
      "Set RUN_CLOUDFLARE_CUSTOMER_BUSINESS_PROFILE_INT=1 to run the local Wrangler business profile integration.",
    timeout: 120_000,
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "omniroute-cloud-business-profile-int-"));
    const homeDir = path.join(tempDir, "home");
    const persistDir = path.join(tempDir, "wrangler-state");
    await mkdir(homeDir, { recursive: true });

    const workerName = `omniroute-business-profile-int-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const wranglerConfigPath = path.join(tempDir, "wrangler.jsonc");
    const safeEnvPath = path.join(tempDir, "local.env");
    const baseUrl = `http://127.0.0.1:${await getUnusedPort()}`;
    const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
    const vars = [
      `OMNIROUTE_CLOUD_ADMIN_TOKEN=${adminToken}`,
      "OMNIROUTE_ENV=local-customer-business-profile-integration",
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
    assert.match(
      `${migrationResult.stdout}\n${migrationResult.stderr}`,
      /0023_cloud_tenant_business_profiles\.sql|0023_cloud_tenant_business_profiles/
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
      const tenantId = `business-${label}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const provisioned = await requestJson(`${baseUrl}/__cloud/v1/tenants`, {
        method: "POST",
        token: adminToken,
        body: {
          id: tenantId,
          name: `Business Customer ${label}`,
          slug: tenantId,
          ownerPrincipalId: `principal-${tenantId}`,
        },
      });
      assert.equal(
        provisioned.response.status,
        201,
        `${label} tenant provisioning failed: ${JSON.stringify(provisioned.body)}\n${output}`
      );
      const key = (provisioned.body.ownerApiKey as { token?: unknown } | undefined)?.token;
      assert.equal(typeof key, "string");
      assert.match(key as string, /^orc_live_/);
      return { tenantId, token: key as string };
    };

    const customerA = await provisionTenant("a");
    const customerB = await provisionTenant("b");
    const profileUrl = `${baseUrl}/__cloud/v1/customer/business-profile`;
    const defaultA = await requestJson(profileUrl, { token: customerA.token });
    assert.equal(defaultA.response.status, 200, JSON.stringify(defaultA.body));
    assert.equal(defaultA.body.tenantId, customerA.tenantId);
    assert.equal(defaultA.body.name, "Business Customer a");
    assert.deepEqual(defaultA.body.services, []);
    assert.deepEqual(defaultA.body.assistant, {
      name: "AI Front Desk",
      tone: "friendly, concise, helpful",
      handoff: "Offer a human follow-up when needed.",
    });

    const profile = {
      name: "Customer A Detail Shop",
      description: "Professional mobile detailing.",
      hours: "Monday through Saturday, 8 AM to 6 PM",
      services: [
        { name: "Express Detail", price: "$89+" },
        { name: "Full Detail", price: "$229+" },
      ],
      assistant: {
        name: "Customer A Front Desk",
        tone: "friendly, concise, helpful",
        handoff: "Offer a human follow-up.",
      },
    };
    const updated = await requestJson(profileUrl, {
      method: "PUT",
      token: customerA.token,
      body: profile,
    });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
    assert.deepEqual(
      {
        name: updated.body.name,
        description: updated.body.description,
        hours: updated.body.hours,
        services: updated.body.services,
        assistant: updated.body.assistant,
      },
      profile
    );

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
          `SELECT tenant_id, name, services_json FROM cloud_tenant_business_profiles ORDER BY tenant_id; SELECT action, metadata_json FROM cloud_compliance_audit WHERE tenant_id = '${customerA.tenantId}' AND action = 'customer.business_profile.update';`,
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
      return (parsed as Array<{ results?: Array<Record<string, unknown>> }>).flatMap(
        (result) => result.results ?? []
      );
    };
    const storedRows = readStoredState();
    const profiles = storedRows.filter((row) => Object.hasOwn(row, "services_json"));
    assert.equal(profiles.length, 2, "both tenant profile rows should exist in actual local D1");
    const storedA = profiles.find((row) => row.tenant_id === customerA.tenantId);
    const storedB = profiles.find((row) => row.tenant_id === customerB.tenantId);
    assert.equal(storedA?.name, profile.name);
    assert.deepEqual(JSON.parse(storedA?.services_json as string), profile.services);
    assert.equal(storedB?.name, "Business Customer b");
    assert.deepEqual(JSON.parse(storedB?.services_json as string), []);

    const auditRows = storedRows.filter((row) => Object.hasOwn(row, "metadata_json"));
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].action, "customer.business_profile.update");
    assert.deepEqual(JSON.parse(auditRows[0].metadata_json as string), {
      serviceCount: profile.services.length,
    });
    assert.equal(JSON.stringify(auditRows).includes(profile.name), false);
    assert.equal(JSON.stringify(auditRows).includes(profile.services[0].name), false);

    const readB = await requestJson(profileUrl, { token: customerB.token });
    assert.equal(readB.response.status, 200);
    assert.equal(readB.body.tenantId, customerB.tenantId);
    assert.equal(readB.body.name, "Business Customer b");
    assert.deepEqual(readB.body.services, []);

    if (process.env.FRONT_DESK_REPO) {
      await t.test(
        "real Front Desk serves each tenant's D1 business profile by host",
        async (frontDeskTest) => {
          const frontDeskRepo = path.resolve(process.env.FRONT_DESK_REPO!);
          await access(path.join(frontDeskRepo, "server.js"));
          await access(path.join(frontDeskRepo, "businessProfileClient.js"));
          const frontDeskPort = await getUnusedPort();
          const frontDeskTempDir = await mkdtemp(
            path.join(os.tmpdir(), "omniroute-frontdesk-business-profile-int-")
          );
          const frontDeskHome = path.join(frontDeskTempDir, "home");
          const frontDeskLeadsDir = path.join(frontDeskTempDir, "leads");
          await mkdir(frontDeskHome, { recursive: true });
          const profileB = {
            name: "Customer B Front Desk",
            description: "Profile loaded from local D1 for customer B.",
            hours: "Tuesday through Sunday",
            services: [{ name: "B Service", price: "$42" }],
            assistant: {
              name: "Assistant B",
              tone: "warm and concise",
              handoff: "Offer a callback for customer B.",
            },
          };
          const frontDeskTenantProfiles = [
            { ...customerA, profile: { ...profile, name: "Customer A Front Desk" } },
            { ...customerB, profile: profileB },
          ];
          const profileUpdates = await Promise.all(
            frontDeskTenantProfiles.map(({ token, profile: tenantProfile }) =>
              requestJson(profileUrl, { method: "PUT", token, body: tenantProfile })
            )
          );
          assert.deepEqual(
            profileUpdates.map((result) => result.response.status),
            [200, 200]
          );

          const tenants = frontDeskTenantProfiles.map((entry, index) => ({
            host: `frontdesk-${index === 0 ? "a" : "b"}.integration.test`,
            tenantId: entry.tenantId,
            apiKeyEnv: `FRONT_DESK_PROFILE_KEY_${index === 0 ? "A" : "B"}`,
            dashboardTokenEnv: `FRONT_DESK_PROFILE_DASHBOARD_${index === 0 ? "A" : "B"}`,
            model: "auto",
            omniRouteUrl: baseUrl,
            businessProfileApi: true,
            business: {
              name: `Static fallback ${index === 0 ? "A" : "B"}`,
              description: "Used only if the Worker profile endpoint is unavailable.",
              hours: "Weekdays",
              services: [],
              assistant: {
                name: "Static assistant",
                tone: "friendly",
                handoff: "Offer follow-up.",
              },
            },
          }));
          const frontDesk = spawn(process.execPath, [path.join(frontDeskRepo, "server.js")], {
            cwd: frontDeskRepo,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: frontDeskHome,
              TMPDIR: frontDeskTempDir,
              NODE_ENV: "test",
              NO_COLOR: "1",
              CI: "1",
              PORT: String(frontDeskPort),
              FRONT_DESK_LEADS_DIR: frontDeskLeadsDir,
              FRONT_DESK_TENANTS_JSON: JSON.stringify(tenants),
              FRONT_DESK_PROFILE_KEY_A: customerA.token,
              FRONT_DESK_PROFILE_KEY_B: customerB.token,
              FRONT_DESK_PROFILE_DASHBOARD_A: "temporary-dashboard-a-token",
              FRONT_DESK_PROFILE_DASHBOARD_B: "temporary-dashboard-b-token",
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let frontDeskOutput = "";
          const appendFrontDeskOutput = (chunk: Buffer) => {
            frontDeskOutput = `${frontDeskOutput}${chunk.toString("utf8")}`.slice(-20_000);
          };
          frontDesk.stdout?.on("data", appendFrontDeskOutput);
          frontDesk.stderr?.on("data", appendFrontDeskOutput);
          frontDeskTest.after(async () => {
            await stopWorker(frontDesk);
            await rm(frontDeskTempDir, { recursive: true, force: true });
          });

          const deadline = Date.now() + 30_000;
          let ready = false;
          while (Date.now() < deadline) {
            if (frontDesk.exitCode !== null) {
              assert.fail(`Front Desk exited before becoming ready:\n${frontDeskOutput}`);
            }
            try {
              const response = await requestWithHost(
                frontDeskPort,
                "/api/health",
                "frontdesk-a.integration.test"
              );
              if (response.status === 200) {
                ready = true;
                break;
              }
            } catch {
              // The real Front Desk process may still be starting.
            }
            await delay(200);
          }
          assert.equal(ready, true, `Front Desk did not become ready:\n${frontDeskOutput}`);

          const frontDeskProfiles = await Promise.all([
            requestWithHost(frontDeskPort, "/business.json", "frontdesk-a.integration.test"),
            requestWithHost(frontDeskPort, "/business.json", "frontdesk-b.integration.test"),
          ]);
          assert.deepEqual(
            frontDeskProfiles.map((result) => result.status),
            [200, 200]
          );
          assert.equal(frontDeskProfiles[0].body.name, "Customer A Front Desk");
          assert.equal(frontDeskProfiles[1].body.name, "Customer B Front Desk");
          assert.deepEqual(frontDeskProfiles[0].body.services, profile.services);
          assert.deepEqual(frontDeskProfiles[1].body.services, profileB.services);
          for (const result of frontDeskProfiles) {
            const publicProfile = JSON.stringify(result.body);
            assert.equal(
              publicProfile.includes(customerA.token),
              false,
              "Front Desk leaked tenant A's API key"
            );
            assert.equal(
              publicProfile.includes(customerB.token),
              false,
              "Front Desk leaked tenant B's API key"
            );
            assert.equal(
              publicProfile.includes("apiKey"),
              false,
              "Front Desk exposed an apiKey field"
            );
          }
        }
      );
    }
  }
);
