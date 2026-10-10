import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const enabled = process.env.RUN_CLOUDFLARE_CUSTOMER_COMBOS_INT === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const identityToken = "local-customer-combos-identity-scope-token-123456";
const provisioningToken = "local-customer-combos-provision-scope-token-123456";
const inferenceToken = "local-customer-combos-inference-scope-token-123456";
const lifecycleToken = "local-customer-combos-lifecycle-scope-token-123456";
const hostsToken = "local-customer-combos-hosts-scope-token-123456";
const frontDeskToken = "local-customer-combos-frontdesk-scope-token-123456";
const maintenanceToken = "local-customer-combos-maintenance-scope-token-123456";
const fixtureAdminToken = "local-customer-combos-fixture-admin-token-123456";
const credentialKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(37)));
const idempotencyKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(43)));
const mockProviderKeyA = "sk-cloudflare-local-inference-fixture";
const modelAOpenAi = "gpt-4o-mini-2024-07-18";
const anthropicModel = "claude-sonnet-4-6";
const anthropicKeyA = "sk-ant-cloud-combo-tenant-a-fixture";
const anthropicKeyB = "sk-ant-cloud-combo-tenant-b-fixture";

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

async function jsonRequest(
  url: string,
  options: { method?: string; token?: string; body?: unknown } = {}
) {
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
    assert.fail(`Expected JSON, got ${response.status}: ${text.slice(0, 300)}`);
  }
  assert.ok(body && typeof body === "object" && !Array.isArray(body));
  return { response, body: body as Record<string, unknown> };
}

async function waitForWorker(url: string, child: ChildProcess, logs: () => string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) assert.fail(`Wrangler exited: ${logs()}`);
    try {
      if ((await fetch(`${url}/__cloud/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* wait while Wrangler starts */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Wrangler did not become ready: ${logs()}`);
}

async function stopWorker(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

test(
  "local Wrangler D1 keeps customer combos separate across tenants",
  {
    skip: !enabled && "Set RUN_CLOUDFLARE_CUSTOMER_COMBOS_INT=1 to run local Wrangler acceptance.",
    timeout: 120_000,
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "omniroute-cloud-combos-int-"));
    const home = path.join(tempDir, "home");
    const persist = path.join(tempDir, "wrangler-state");
    await mkdir(home, { recursive: true });
    const workerName = `omniroute-customer-combos-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const config = path.join(tempDir, "wrangler.jsonc");
    const envFile = path.join(tempDir, "local.env");
    const baseUrl = `http://127.0.0.1:${await unusedPort()}`;
    const wrangler = path.join(repoRoot, "node_modules", ".bin", "wrangler");
    const vars = [
      `OMNIROUTE_CLOUD_ADMIN_TOKEN=${fixtureAdminToken}`,
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
    await writeFile(path.join(tempDir, ".dev.vars"), `${vars}\n`, { mode: 0o600 });
    await writeFile(path.join(tempDir, ".env"), `${vars}\n`, { mode: 0o600 });
    await writeFile(envFile, `${vars}\n`, { mode: 0o600 });
    await writeFile(
      config,
      JSON.stringify(
        {
          name: workerName,
          main: path.join(repoRoot, "tests", "fixtures", "cloudflare-inference-mock-worker.ts"),
          compatibility_date: "2026-10-08",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: workerName,
              migrations_dir: path.join(repoRoot, "cloudflare/migrations"),
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
      HOME: home,
      TMPDIR: tempDir,
      NODE_ENV: "test",
      NO_COLOR: "1",
      CI: "1",
    };
    const run = (args: string[], timeout = 60_000) =>
      spawnSync(process.execPath, [wrangler, ...args], {
        cwd: tempDir,
        env: commandEnv,
        encoding: "utf8",
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      });
    const migration = run([
      "d1",
      "migrations",
      "apply",
      workerName,
      "--local",
      "--persist-to",
      persist,
      "--config",
      config,
      "--env-file",
      envFile,
    ]);
    assert.equal(
      migration.status,
      0,
      `D1 migrations failed:\n${migration.stdout}\n${migration.stderr}`
    );
    const mockSchema = run(
      [
        "d1",
        "execute",
        workerName,
        "--local",
        "--persist-to",
        persist,
        "--config",
        config,
        "--env-file",
        envFile,
        "--yes",
        "--command",
        "CREATE TABLE cloud_test_mock_provider_calls (id TEXT PRIMARY KEY, call_count INTEGER NOT NULL, last_error TEXT, fail_generation_count INTEGER NOT NULL DEFAULT 0); INSERT INTO cloud_test_mock_provider_calls (id, call_count, last_error, fail_generation_count) VALUES ('inference', 0, NULL, 0); CREATE TABLE cloud_test_mock_provider_credential_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, credential_id TEXT NOT NULL); CREATE TABLE cloud_test_mock_provider_model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, credential_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, operation TEXT NOT NULL, path TEXT NOT NULL, auth_header TEXT NOT NULL, version_header TEXT, max_tokens INTEGER, stream INTEGER, response_status INTEGER NOT NULL);",
      ],
      30_000
    );
    assert.equal(
      mockSchema.status,
      0,
      `mock provider fixture setup failed:\n${mockSchema.stdout}\n${mockSchema.stderr}`
    );
    const child = spawn(
      process.execPath,
      [
        wrangler,
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        new URL(baseUrl).port,
        "--persist-to",
        persist,
        "--config",
        config,
        "--env-file",
        envFile,
        "--show-interactive-dev-session=false",
      ],
      { cwd: tempDir, env: commandEnv, stdio: ["ignore", "pipe", "pipe"] }
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

    const provision = async (label: string) => {
      const tenantId = `combo-${label}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const tenant = await jsonRequest(`${baseUrl}/__cloud/v1/tenants`, {
        token: provisioningToken,
        body: {
          id: tenantId,
          name: `Combo ${label}`,
          slug: tenantId,
          bootstrapMode: "oidc_pending",
        },
      });
      assert.equal(tenant.response.status, 201, JSON.stringify(tenant.body));
      const memberships = await jsonRequest(
        `${baseUrl}/__cloud/v1/tenants/${tenantId}/memberships`,
        { token: identityToken, body: { principalId: `owner-${tenantId}`, role: "owner" } }
      );
      assert.equal(memberships.response.status, 201, JSON.stringify(memberships.body));
      const key = await jsonRequest(
        `${baseUrl}/__cloud/v1/tenants/${tenantId}/memberships/${String(memberships.body.id)}/api-keys`,
        { token: identityToken, body: {} }
      );
      assert.equal(key.response.status, 201, JSON.stringify(key.body));
      return { tenantId, token: String(key.body.token) };
    };
    const a = await provision("a");
    const b = await provision("b");
    const collection = `${baseUrl}/__cloud/v1/customer/combos`;
    const payloadA = {
      name: "default",
      description: "Tenant A private target",
      models: [
        `openai/${modelAOpenAi}`,
        { kind: "model", provider: "anthropic", model: anthropicModel },
      ],
      strategy: "priority",
    };
    const payloadB = {
      name: "default",
      description: "Tenant B private target",
      models: [{ kind: "model", provider: "anthropic", model: anthropicModel }],
      strategy: "priority",
    };
    const createdA = await jsonRequest(collection, { token: a.token, body: payloadA });
    assert.equal(createdA.response.status, 201, `${JSON.stringify(createdA.body)}\n${output}`);
    const createdB = await jsonRequest(collection, { token: b.token, body: payloadB });
    assert.equal(
      createdB.response.status,
      201,
      "combo names are unique within a tenant, not globally"
    );
    const idA = String(createdA.body.id);
    assert.equal(
      (await jsonRequest(`${collection}/${idA}`, { token: b.token })).response.status,
      404
    );
    const listA = await fetch(collection, { headers: { authorization: `Bearer ${a.token}` } });
    const listB = await fetch(collection, { headers: { authorization: `Bearer ${b.token}` } });
    assert.deepEqual(
      ((await listA.json()) as Array<Record<string, unknown>>).map((row) => row.id),
      [idA]
    );
    assert.deepEqual(
      ((await listB.json()) as Array<Record<string, unknown>>).map((row) => row.id),
      [createdB.body.id]
    );
    const query = run(
      [
        "d1",
        "execute",
        workerName,
        "--local",
        "--persist-to",
        persist,
        "--config",
        config,
        "--env-file",
        envFile,
        "--yes",
        "--json",
        "--command",
        `SELECT tenant_id, name FROM cloud_tenant_combos ORDER BY tenant_id;`,
      ],
      30_000
    );
    assert.equal(query.status, 0, `D1 read failed:\n${query.stdout}\n${query.stderr}`);
    const rows = JSON.parse(query.stdout) as Array<{ results?: Array<Record<string, unknown>> }>;
    assert.equal(rows.flatMap((result) => result.results ?? []).length, 2);

    const entitlements = [
      { tenantId: a.tenantId, model: modelAOpenAi, provider: "openai" },
      { tenantId: a.tenantId, model: anthropicModel, provider: "anthropic" },
      { tenantId: b.tenantId, model: anthropicModel, provider: "anthropic" },
    ];
    for (const { tenantId, model, provider } of entitlements) {
      const entitlement = await jsonRequest(
        `${baseUrl}/__cloud/v1/tenants/${tenantId}/inference-entitlements`,
        {
          method: "PUT",
          token: inferenceToken,
          body: {
            provider,
            model,
            enabled: true,
            maxInputTokens: 100,
            maxOutputTokens: 40,
          },
        }
      );
      assert.equal(entitlement.response.status, 200, JSON.stringify(entitlement.body));
      const budget = await jsonRequest(
        `${baseUrl}/__cloud/v1/tenants/${tenantId}/inference-budget`,
        {
          method: "PUT",
          token: inferenceToken,
          body: { monthlyTokenLimit: 1000 },
        }
      );
      assert.equal(budget.response.status, 200, JSON.stringify(budget.body));
    }
    for (const { tenantId, token, id, provider, providerKey } of [
      {
        tenantId: a.tenantId,
        token: a.token,
        id: "mock-openai",
        provider: "openai",
        providerKey: mockProviderKeyA,
      },
      {
        tenantId: a.tenantId,
        token: a.token,
        id: "mock-anthropic",
        provider: "anthropic",
        providerKey: anthropicKeyA,
      },
      {
        tenantId: b.tenantId,
        token: b.token,
        id: "mock-anthropic",
        provider: "anthropic",
        providerKey: anthropicKeyB,
      },
    ]) {
      const connection = await jsonRequest(
        `${baseUrl}/__cloud/v1/tenants/${tenantId}/provider-connections`,
        { token, body: { id, provider, apiKey: providerKey } }
      );
      assert.equal(connection.response.status, 201, JSON.stringify(connection.body));
      assert.equal(JSON.stringify(connection.body).includes(providerKey), false);
    }

    const setMockFailure = (statement: string) =>
      run(
        [
          "d1",
          "execute",
          workerName,
          "--local",
          "--persist-to",
          persist,
          "--config",
          config,
          "--env-file",
          envFile,
          "--yes",
          "--command",
          statement,
        ],
        30_000
      );

    const invoke = (tenant: { tenantId: string; token: string }, label: string) =>
      fetch(`${baseUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tenant.token}`,
          "content-type": "application/json",
          "idempotency-key": `combo-${label}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          model: "combo:default",
          messages: [{ role: "user", content: `request for tenant ${label}` }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
    const responseA = await invoke(a, "a");
    const bodyA = (await responseA.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    assert.equal(responseA.status, 200, JSON.stringify(bodyA));
    assert.equal(bodyA.choices?.[0]?.message?.content, "Anthropic result for tenant-a-anthropic.");
    const responseB = await invoke(b, "b");
    const bodyB = (await responseB.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    assert.equal(responseB.status, 200, JSON.stringify(bodyB));
    assert.equal(bodyB.choices?.[0]?.message?.content, "Anthropic result for tenant-b-anthropic.");

    const mockStats = await jsonRequest(`${baseUrl}/__test/mock-provider/stats`, {
      token: fixtureAdminToken,
    });
    assert.equal(mockStats.response.status, 200, JSON.stringify(mockStats.body));
    assert.equal(
      mockStats.body.callCount,
      6,
      "fallback plus both successful Anthropic targets dispatch six calls"
    );
    assert.deepEqual(mockStats.body.credentialIds, [
      "tenant-a",
      "tenant-a",
      "tenant-a-anthropic",
      "tenant-a-anthropic",
      "tenant-b-anthropic",
      "tenant-b-anthropic",
    ]);
    assert.deepEqual(
      (mockStats.body.modelCalls as Array<Record<string, unknown>>).map((call) => [
        call.credential_id,
        call.provider,
        call.model,
        call.operation,
        call.path,
        call.auth_header,
        call.version_header,
        call.max_tokens,
        call.stream,
        call.response_status,
      ]),
      [
        [
          "tenant-a",
          "openai",
          modelAOpenAi,
          "count",
          "/v1/responses/input_tokens",
          "authorization",
          null,
          null,
          null,
          200,
        ],
        [
          "tenant-a",
          "openai",
          modelAOpenAi,
          "generation",
          "/v1/responses",
          "authorization",
          null,
          40,
          null,
          403,
        ],
        [
          "tenant-a-anthropic",
          "anthropic",
          anthropicModel,
          "count",
          "/v1/messages/count_tokens",
          "x-api-key",
          "2023-06-01",
          null,
          null,
          200,
        ],
        [
          "tenant-a-anthropic",
          "anthropic",
          anthropicModel,
          "generation",
          "/v1/messages",
          "x-api-key",
          "2023-06-01",
          40,
          null,
          200,
        ],
        [
          "tenant-b-anthropic",
          "anthropic",
          anthropicModel,
          "count",
          "/v1/messages/count_tokens",
          "x-api-key",
          "2023-06-01",
          null,
          null,
          200,
        ],
        [
          "tenant-b-anthropic",
          "anthropic",
          anthropicModel,
          "generation",
          "/v1/messages",
          "x-api-key",
          "2023-06-01",
          40,
          null,
          200,
        ],
      ],
      "each combo must use the fixed provider contract and only its tenant's credentials"
    );

    for (const tenant of [
      {
        ...a,
        expectedUsage: [
          ["openai", modelAOpenAi, "fallback", 0, "mock-openai"],
          ["anthropic", anthropicModel, "success", 1, "mock-anthropic"],
        ],
        expectedAudits: [
          ["target_fallback", "openai", modelAOpenAi],
          ["success", "anthropic", anthropicModel],
        ],
      },
      {
        ...b,
        expectedUsage: [["anthropic", anthropicModel, "success", 1, "mock-anthropic"]],
        expectedAudits: [["success", "anthropic", anthropicModel]],
      },
    ]) {
      const state = await jsonRequest(
        `${baseUrl}/__test/inference/state?tenantId=${encodeURIComponent(tenant.tenantId)}`,
        { token: fixtureAdminToken }
      );
      assert.equal(state.response.status, 200, JSON.stringify(state.body));
      const usage = state.body.usage as Array<Record<string, unknown>>;
      assert.deepEqual(
        usage.map((row) => [row.provider, row.model, row.status, row.success, row.connection_id]),
        tenant.expectedUsage
      );
      const reservations = state.body.reservations as Array<Record<string, unknown>>;
      assert.deepEqual(
        reservations.map((row) => [row.provider, row.model, row.status]),
        tenant.expectedUsage.map(([provider, model]) => [provider, model, "settled"])
      );
      const audits = state.body.audits as Array<Record<string, unknown>>;
      assert.deepEqual(
        audits.map((row) => {
          const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
          return [row.status, metadata.provider, metadata.model];
        }),
        tenant.expectedAudits
      );
    }

    const armedFailure = setMockFailure(
      "UPDATE cloud_test_mock_provider_calls SET fail_generation_count = 1 WHERE id = 'inference';"
    );
    assert.equal(armedFailure.status, 0, `failed to arm 503 fixture: ${armedFailure.stderr}`);
    const unsafeFallback = await invoke(a, "a-503");
    assert.equal(unsafeFallback.status, 502, await unsafeFallback.text());
    const afterUnsafeFallback = await jsonRequest(`${baseUrl}/__test/mock-provider/stats`, {
      token: fixtureAdminToken,
    });
    assert.equal(afterUnsafeFallback.body.callCount, 8);
    assert.deepEqual(
      (afterUnsafeFallback.body.credentialIds as string[]).slice(-2),
      ["tenant-a", "tenant-a"],
      "a 503 after generation starts must not fall through to tenant A's Anthropic connection"
    );
    assert.deepEqual(
      (afterUnsafeFallback.body.modelCalls as Array<Record<string, unknown>>)
        .slice(-2)
        .map((call) => [call.provider, call.operation, call.response_status]),
      [
        ["openai", "count", 200],
        ["openai", "generation", 503],
      ]
    );
  }
);
