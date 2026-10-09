import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

const enabled = process.env.RUN_CLOUDFLARE_CUSTOMER_PORTAL_BROWSER_INT === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const adminToken = "local-customer-portal-browser-admin-token-only";
const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(43)));
const issuer = "https://local-idp.omniroute.test";

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

async function waitForWorker(baseUrl: string, child: ChildProcess, logs: () => string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      assert.fail(`Wrangler exited before becoming ready (code ${child.exitCode}):\n${logs()}`);
    }
    try {
      if ((await fetch(`${baseUrl}/__cloud/health`, { signal: AbortSignal.timeout(1_000) })).ok) {
        return;
      }
    } catch {
      // Wrangler may still be starting its local workerd process.
    }
    await delay(250);
  }
  assert.fail(`Wrangler did not become ready within 60 seconds:\n${logs()}`);
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

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

test(
  "local Wrangler customer portal renders and exercises an authenticated owner session in Chromium",
  {
    skip:
      !enabled &&
      "Set RUN_CLOUDFLARE_CUSTOMER_PORTAL_BROWSER_INT=1 to run the local Wrangler + Chromium integration.",
    timeout: 180_000,
  },
  async (t) => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "omniroute-cloud-customer-portal-browser-")
    );
    const homeDir = path.join(tempDir, "home");
    const persistDir = path.join(tempDir, "wrangler-state");
    await mkdir(homeDir, { recursive: true });

    const workerName = `omniroute-customer-portal-browser-${process.pid}-${randomUUID().slice(0, 8)}`;
    const wranglerConfigPath = path.join(tempDir, "wrangler.jsonc");
    const safeEnvPath = path.join(tempDir, "local.env");
    const baseUrl = `http://127.0.0.1:${await getUnusedPort()}`;
    const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
    const vars = [
      `OMNIROUTE_CLOUD_ADMIN_TOKEN=${adminToken}`,
      `OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY=${encryptionKey}`,
      `OMNIROUTE_CLOUD_PUBLIC_ORIGIN=${baseUrl}`,
      "OMNIROUTE_ENV=development",
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
      /0016_cloud_tenant_oidc_sessions\.sql|0016_cloud_tenant_oidc_sessions/
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

    const tenantId = `portal-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const provisioned = await requestJson(`${baseUrl}/__cloud/v1/tenants`, {
      method: "POST",
      token: adminToken,
      body: {
        id: tenantId,
        name: "Chromium Portal Customer",
        slug: tenantId,
        ownerPrincipalId: `owner-${tenantId}`,
      },
    });
    assert.equal(
      provisioned.response.status,
      201,
      `tenant provisioning failed: ${JSON.stringify(provisioned.body)}\n${output}`
    );

    const oidcConfig = await requestJson(`${baseUrl}/__cloud/v1/tenants/${tenantId}/oidc`, {
      method: "PUT",
      token: adminToken,
      body: {
        issuer,
        clientId: `client-${tenantId}`,
        clientSecret: "temporary-local-secret",
        isEnabled: true,
      },
    });
    assert.equal(oidcConfig.response.status, 201, JSON.stringify(oidcConfig.body));

    const membershipResult = runWrangler([
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
      `SELECT id FROM cloud_customer_memberships WHERE tenant_id = ${sqlText(tenantId)} AND role = 'owner' AND is_active = 1 LIMIT 1;`,
    ]);
    assert.equal(membershipResult.status, 0, membershipResult.stderr);
    const membershipPayload = JSON.parse(membershipResult.stdout) as Array<{
      results?: Array<{ id?: unknown }>;
    }>;
    const membershipId = membershipPayload.flatMap((item) => item.results ?? [])[0]?.id;
    assert.equal(typeof membershipId, "string", membershipResult.stdout);

    const subject = `owner-subject-${tenantId}`;
    const identity = await requestJson(
      `${baseUrl}/__cloud/v1/tenants/${tenantId}/oidc/identities`,
      {
        method: "POST",
        token: adminToken,
        body: { issuer, subject, membershipId },
      }
    );
    assert.equal(identity.response.status, 201, JSON.stringify(identity.body));
    const identityId = identity.body.id;
    assert.equal(typeof identityId, "string", JSON.stringify(identity.body));

    // A short-lived, random, local-only session lets Chromium exercise the real
    // Worker cookie-authenticated owner routes without any external IdP account.
    const sessionToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
    const nowMs = Date.now();
    const expiresAtMs = nowMs + 30 * 60 * 1000;
    const seedResult = runWrangler([
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
      `UPDATE cloud_tenant_settings SET mcp_enabled = 1 WHERE tenant_id = ${sqlText(tenantId)}; INSERT INTO cloud_tenant_oidc_sessions (token_hash, tenant_id, membership_id, identity_id, created_at_ms, expires_at_ms) VALUES (${sqlText(tokenHash)}, ${sqlText(tenantId)}, ${sqlText(String(membershipId))}, ${sqlText(String(identityId))}, ${nowMs}, ${expiresAtMs});`,
    ]);
    assert.equal(seedResult.status, 0, `${seedResult.stdout}\n${seedResult.stderr}`);

    const browser = await chromium.launch({ headless: true });
    t.after(async () => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "omni_customer_session",
        value: sessionToken,
        url: baseUrl,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const failedRequests: string[] = [];
    page.on("requestfailed", (request) =>
      failedRequests.push(`${request.method()} ${request.url()}`)
    );
    await page.goto(`${baseUrl}/__cloud/portal`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Chromium Portal Customer" }).waitFor();
    await page.getByText("Your role: owner").waitFor();
    await page.getByText("owner · Active").waitFor();
    await page.getByRole("heading", { name: "Onboarding readiness" }).waitFor();
    await page.getByText(/Inference access is default-deny/).waitFor();
    await page.getByText(/Only a platform admin can configure entitlements/).waitFor();
    assert.equal(await page.locator("#onboarding-readiness li").count(), 9);
    assert.equal(
      (await page.locator("#onboarding-readiness").textContent())?.includes(tenantId),
      false
    );
    await page.getByLabel("Business name").fill("Browser Configured Business");
    await page.getByLabel("Description").fill("Tenant-managed profile from the customer portal.");
    await page.getByLabel("Hours").fill("Weekdays 9 to 5");
    await page.getByLabel("Assistant name").fill("Portal Assistant");
    await page.getByLabel("Tone").fill("Warm and concise");
    await page.getByLabel("When to hand off to a person").fill("Offer a callback.");
    await page.getByRole("button", { name: "Add service" }).click();
    await page.getByLabel("Service name").fill("Consultation");
    await page.getByLabel("Price").fill("$45");
    await page.getByRole("button", { name: "Save business profile" }).click();
    await page.getByText("Business profile saved.").waitFor();
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator("#business-name").inputValue(), "Browser Configured Business");
    assert.equal(
      await page.locator("#business-services input").first().inputValue(),
      "Consultation"
    );

    const providerSecret = "sk-test-browser-provider-secret";
    await page.locator("#provider-connection-name").fill("Browser OpenAI");
    await page.locator("#provider-api-key").fill(providerSecret);
    await page.getByRole("button", { name: "Add OpenAI connection" }).click();
    await page
      .getByText("OpenAI connection created. Credential values are never displayed.")
      .waitFor();
    assert.equal(await page.locator("#provider-api-key").inputValue(), "");
    const providerRow = page.locator("#provider-connections .provider-row").first();
    await providerRow.waitFor();
    assert.equal((await providerRow.textContent())?.includes(providerSecret), false);
    await providerRow.getByLabel("Connection name").fill("Browser OpenAI Edited");
    await providerRow.getByRole("button", { name: "Save connection" }).click();
    await page
      .getByText("Provider connection updated. Credential values are never displayed.")
      .waitFor();
    assert.equal(
      (await page.locator("#provider-connections").textContent())?.includes(providerSecret),
      false
    );
    const connectionResult = runWrangler([
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
      `SELECT api_key, name FROM provider_connections WHERE tenant_id = ${sqlText(tenantId)} AND provider = 'openai';`,
    ]);
    assert.equal(
      connectionResult.status,
      0,
      `${connectionResult.stdout}\n${connectionResult.stderr}`
    );
    assert.doesNotMatch(connectionResult.stdout, new RegExp(providerSecret));
    assert.match(connectionResult.stdout, /enc:v[12]:/);
    assert.match(connectionResult.stdout, /Browser OpenAI Edited/);
    await providerRow.getByRole("button", { name: "Revoke connection" }).click();
    await page.getByText("Provider connection revoked.").waitFor();
    await providerRow.waitFor({ state: "detached" });
    assert.equal(await page.locator("#provider-connections").textContent(), "");

    const mcpSecret = "mcp-test-browser-credential";
    await page.locator("#mcp-server-name").fill("Browser MCP");
    await page.locator("#mcp-server-endpoint").fill("https://mcp.example.test/mcp");
    await page.locator("#mcp-server-credential").fill(mcpSecret);
    await page.getByRole("button", { name: "Add MCP server" }).click();
    await page.getByText("MCP server created. Credentials are never displayed.").waitFor();
    assert.equal(await page.locator("#mcp-server-credential").inputValue(), "");
    const mcpRow = page.locator("#mcp-servers .mcp-server-row").first();
    await mcpRow.waitFor();
    assert.equal((await mcpRow.textContent())?.includes(mcpSecret), false);
    await mcpRow.getByLabel("Server name").fill("Browser MCP Edited");
    await mcpRow.getByRole("button", { name: "Save MCP server" }).click();
    await page.getByText("MCP server updated. Credentials are never displayed.").waitFor();
    assert.equal((await page.locator("#mcp-servers").textContent())?.includes(mcpSecret), false);
    const mcpResult = runWrangler([
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
      `SELECT name, credential_encrypted FROM cloud_tenant_mcp_servers WHERE tenant_id = ${sqlText(tenantId)};`,
    ]);
    assert.equal(mcpResult.status, 0, `${mcpResult.stdout}\n${mcpResult.stderr}`);
    assert.doesNotMatch(mcpResult.stdout, new RegExp(mcpSecret));
    assert.match(mcpResult.stdout, /enc:v[12]:/);
    assert.match(mcpResult.stdout, /Browser MCP Edited/);
    await mcpRow.getByRole("button", { name: "Delete MCP server" }).click();
    await page.getByText("MCP server deleted.").waitFor();
    await mcpRow.waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Create API key" }).click();
    await page.getByText("API key created.").waitFor();
    const issuedKey = await page.locator("#api-key-result code").textContent();
    assert.match(issuedKey ?? "", /^orc_live_/);

    await page.getByRole("button", { name: "Create one-use invitation" }).click();
    await page.getByText("Invitation created.").waitFor();
    assert.match(
      (await page.locator("#invitation-result code").textContent()) ?? "",
      /^[A-Za-z0-9_-]{20,}$/
    );
    assert.deepEqual(failedRequests, []);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    assert.equal((await requestJson(`${baseUrl}/__cloud/auth/session`)).response.status, 401);
    await context.close();
  }
);
