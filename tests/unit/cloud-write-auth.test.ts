import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cloud-write-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.JWT_SECRET = "cloud-write-auth-jwt";
process.env.INITIAL_PASSWORD = "bootstrap-password";
process.env.API_KEY_SECRET = "cloud-write-auth-api-key-secret";

type ApiKeyRecord = { key: string };
type ProviderConnectionRecord = {
  id: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: string | null;
};

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const tenantProvisioning =
  await import("../../src/lib/tenantProvisioning/provisionCustomerTenant.ts");
const tenantContext = await import("../../src/lib/tenantContext.ts");
const credentialsRoute = await import("../../src/app/api/cloud/credentials/update/route.ts");
const aliasRoute = await import("../../src/app/api/cloud/models/alias/route.ts");
const resolveAliasRoute = await import("../../src/app/api/cloud/model/resolve/route.ts");
const cloudAuthRoute = await import("../../src/app/api/cloud/auth/route.ts");

async function resetStorage() {
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.ROUTER_API_KEY;
  process.env.INITIAL_PASSWORD = "bootstrap-password";
  process.env.JWT_SECRET = "cloud-write-auth-jwt";
  process.env.API_KEY_SECRET = "cloud-write-auth-api-key-secret";
  core.resetDbInstance();
  localDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await localDb.updateSettings({ requireLogin: true, password: "" });
}

async function createKey(scopes: string[] = []): Promise<ApiKeyRecord> {
  return localDb.createApiKey(`cloud-write-${scopes.join("-") || "none"}`, "machine-test", scopes);
}

async function createActiveConnection(projectId?: string): Promise<ProviderConnectionRecord> {
  const connection = await localDb.createProviderConnection({
    provider: "openai",
    authType: "oauth",
    name: "OpenAI OAuth",
    email: "owner@example.test",
    isActive: true,
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    expiresAt: "2026-01-01T00:00:00.000Z",
    ...(projectId ? { projectId } : {}),
  });
  assert.ok(connection?.id);
  return connection as ProviderConnectionRecord;
}

async function readActiveConnection(): Promise<ProviderConnectionRecord> {
  const [connection] = (await localDb.getProviderConnections({
    provider: "openai",
    isActive: true,
  })) as ProviderConnectionRecord[];
  assert.ok(connection);
  return connection;
}

function credentialUpdateBody() {
  return {
    provider: "openai",
    credentials: {
      accessToken: "new-access-secret",
      refreshToken: "new-refresh-secret",
      expiresIn: 3600,
    },
  };
}

function aliasUpdateBody() {
  return {
    model: "openai/gpt-4o-mini",
    alias: "fast-default",
  };
}

function cloudCredentialsRequest(token: string | null, body = credentialUpdateBody()) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://localhost/api/cloud/credentials/update", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

function cloudAliasRequest(token: string | null, body = aliasUpdateBody()) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://localhost/api/cloud/models/alias", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

function cloudAuthRequest(token: string | null) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://localhost/api/cloud/auth", { method: "POST", headers });
}

function cloudAliasListRequest(token: string) {
  return new Request("http://localhost/api/cloud/models/alias", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

function cloudResolveAliasRequest(token: string, alias: string) {
  return new Request("http://localhost/api/cloud/model/resolve", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ alias }),
  });
}

async function captureConsoleLog<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const originalLog = console.log;
  const entries: string[] = [];
  console.log = (...args: unknown[]) => {
    entries.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    return { value: await fn(), logs: entries.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

function assertTextDoesNotLeakSecrets(text: string, label: string, secrets: string[]) {
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `${label} leaked secret: ${secret}`);
  }
}

async function assertResponseDoesNotLeakSecrets(response: Response, secrets: string[]) {
  const text = await response.text();
  assertTextDoesNotLeakSecrets(text, "response", secrets);
  return text.length > 0 ? JSON.parse(text) : null;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  localDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("PUT /api/cloud/credentials/update rejects valid API key without manage/admin scope and leaves credentials unchanged", async () => {
  await createActiveConnection();
  const key = await createKey();

  const { value: response, logs } = await captureConsoleLog(() =>
    credentialsRoute.PUT(cloudCredentialsRequest(key.key))
  );
  const body = await assertResponseDoesNotLeakSecrets(response, [
    "new-access-secret",
    "new-refresh-secret",
  ]);
  assertTextDoesNotLeakSecrets(logs, "logs", ["new-access-secret", "new-refresh-secret"]);
  const connection = await readActiveConnection();

  assert.equal(response.status, 403);
  assert.match(body.error?.message || "", /manage/);
  assert.equal(connection.accessToken, "old-access-token");
  assert.equal(connection.refreshToken, "old-refresh-token");
  assert.equal(connection.expiresAt, "2026-01-01T00:00:00.000Z");
});

test("PUT /api/cloud/models/alias rejects valid API key without manage/admin scope and leaves aliases unchanged", async () => {
  await localDb.setModelAlias("fast-default", "openai/original-model");
  const key = await createKey();

  const { value: response, logs } = await captureConsoleLog(() =>
    aliasRoute.PUT(cloudAliasRequest(key.key))
  );
  const body = await assertResponseDoesNotLeakSecrets(response, ["openai/gpt-4o-mini"]);
  assertTextDoesNotLeakSecrets(logs, "logs", ["openai/gpt-4o-mini"]);
  const aliases = await localDb.getModelAliases();

  assert.equal(response.status, 403);
  assert.match(body.error?.message || "", /manage/);
  assert.equal(aliases["fast-default"], "openai/original-model");
});

test("PUT /api/cloud/credentials/update accepts API key with manage scope", async () => {
  await createActiveConnection();
  const key = await createKey(["manage"]);

  const response = await credentialsRoute.PUT(cloudCredentialsRequest(key.key));
  const body = await response.json();
  const connection = await readActiveConnection();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(connection.accessToken, "new-access-secret");
  assert.equal(connection.refreshToken, "new-refresh-secret");
  assert.notEqual(connection.expiresAt, "2026-01-01T00:00:00.000Z");
});

test("PUT /api/cloud/models/alias accepts API key with manage scope", async () => {
  const key = await createKey(["manage"]);

  const response = await aliasRoute.PUT(cloudAliasRequest(key.key));
  const body = await response.json();
  const aliases = await localDb.getModelAliases();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(aliases["fast-default"], "openai/gpt-4o-mini");
});

test("PUT /api/cloud/models/alias denies customer manage keys and preserves platform writes", async () => {
  await localDb.setModelAlias("platform-owned", "openai/original-model");
  const platformKey = await createKey(["manage"]);
  const customer = await tenantProvisioning.provisionCustomerTenant({
    name: "Customer Alias Writer",
    slug: "customer-alias-writer",
    owner: { principalId: "customer-alias-writer-owner", identityVerified: true },
    provisionedBy: "platform-cloud-alias-write-test",
  });
  const customerManageKey = await tenantContext.runWithTenantContext(
    { tenantId: customer.tenant.id, principalId: "customer-alias-writer-admin", role: "owner" },
    () => createKey(["manage"])
  );
  const customerMetadata = await (
    await import("../../src/lib/db/apiKeys.ts")
  ).getApiKeyMetadata(customerManageKey.key);
  assert.equal(customerMetadata?.tenantId, customer.tenant.id);

  const customerResponse = await aliasRoute.PUT(
    cloudAliasRequest(customerManageKey.key, {
      alias: "customer-global-write",
      model: "anthropic/customer-model",
    })
  );
  assert.equal(customerResponse.status, 403);
  assert.deepEqual(await localDb.getModelAliases(), {
    "platform-owned": "openai/original-model",
  });

  const customerAlternateHeaderResponse = await aliasRoute.PUT(
    new Request("http://localhost/api/cloud/models/alias", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": customerManageKey.key,
      },
      body: JSON.stringify({ alias: "customer-alt-header-write", model: "openai/customer-model" }),
    })
  );
  assert.equal(customerAlternateHeaderResponse.status, 403);
  assert.deepEqual(await localDb.getModelAliases(), {
    "platform-owned": "openai/original-model",
  });

  const platformResponse = await aliasRoute.PUT(
    cloudAliasRequest(platformKey.key, {
      alias: "platform-global-write",
      model: "openai/platform-model",
    })
  );
  assert.equal(platformResponse.status, 200);
  assert.deepEqual(await localDb.getModelAliases(), {
    "platform-owned": "openai/original-model",
    "platform-global-write": "openai/platform-model",
  });
});

test("POST /api/cloud/auth scopes provider connection reads to the authenticated customer tenant", async () => {
  const platformConnection = await createActiveConnection("platform-project-marker");
  assert.ok(platformConnection.id);

  const customer = await tenantProvisioning.provisionCustomerTenant({
    name: "Customer Cloud Auth",
    slug: "customer-cloud-auth",
    owner: { principalId: "customer-cloud-auth-owner", identityVerified: true },
    provisionedBy: "platform-cloud-auth-test",
  });

  const customerConnection = await tenantContext.runWithTenantContext(
    {
      tenantId: customer.tenant.id,
      principalId: customer.apiKey.id,
      role: "owner",
    },
    () => createActiveConnection("customer-project-marker")
  );

  const response = await cloudAuthRoute.POST(cloudAuthRequest(customer.apiKey.key));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.connections.length, 1);
  assert.equal(body.connections[0].projectId, "customer-project-marker");
  assert.ok(
    !body.connections.some(
      (connection: { projectId: string }) => connection.projectId === "platform-project-marker"
    )
  );

  const platformRows = await tenantContext.runWithTenantContext(
    { tenantId: "tenant_shiryu_admin", principalId: "platform-test" },
    () => localDb.getProviderConnections({ isActive: true })
  );
  assert.equal(platformRows.length, 1);
  assert.equal(platformRows[0].id, platformConnection.id);

  const customerRows = await tenantContext.runWithTenantContext(
    { tenantId: customer.tenant.id, principalId: customer.apiKey.id },
    () => localDb.getProviderConnections({ isActive: true })
  );
  assert.equal(customerRows.length, 1);
  assert.equal(customerRows[0].id, customerConnection.id);
});

test("cloud alias reads preserve platform aliases and hide them from customer API keys", async () => {
  await localDb.setModelAlias("platform-private", "openai/platform-model");

  const platformKey = await createKey();
  const customer = await tenantProvisioning.provisionCustomerTenant({
    name: "Customer Cloud Aliases",
    slug: "customer-cloud-aliases",
    owner: { principalId: "customer-cloud-aliases-owner", identityVerified: true },
    provisionedBy: "platform-cloud-aliases-test",
  });

  // The legacy key_value namespace is global. Seed another mapping while the
  // customer context is active to prove the cloud customer surfaces never
  // expose entries merely because the key belongs to that customer.
  await tenantContext.runWithTenantContext(
    { tenantId: customer.tenant.id, principalId: customer.apiKey.id, role: "owner" },
    () => localDb.setModelAlias("customer-private", "anthropic/customer-model")
  );

  const platformAuth = await cloudAuthRoute.POST(cloudAuthRequest(platformKey.key));
  const platformAuthBody = await platformAuth.json();
  const customerAuth = await cloudAuthRoute.POST(cloudAuthRequest(customer.apiKey.key));
  const customerAuthBody = await customerAuth.json();
  const platformList = await aliasRoute.GET(cloudAliasListRequest(platformKey.key));
  const platformListBody = await platformList.json();
  const customerList = await aliasRoute.GET(cloudAliasListRequest(customer.apiKey.key));
  const customerListBody = await customerList.json();
  const platformResolve = await resolveAliasRoute.POST(
    cloudResolveAliasRequest(platformKey.key, "platform-private")
  );
  const customerResolve = await resolveAliasRoute.POST(
    cloudResolveAliasRequest(customer.apiKey.key, "platform-private")
  );

  assert.equal(platformAuth.status, 200);
  assert.equal(platformAuthBody.modelAliases["platform-private"], "openai/platform-model");
  assert.equal(platformAuthBody.modelAliases["customer-private"], "anthropic/customer-model");
  assert.equal(customerAuth.status, 200);
  assert.deepEqual(customerAuthBody.modelAliases, {});
  assert.equal(platformList.status, 200);
  assert.equal(platformListBody.aliases["platform-private"], "openai/platform-model");
  assert.equal(platformListBody.aliases["customer-private"], "anthropic/customer-model");
  assert.equal(customerList.status, 200);
  assert.deepEqual(customerListBody.aliases, {});
  assert.equal(platformResolve.status, 200);
  assert.deepEqual(await platformResolve.json(), {
    alias: "platform-private",
    provider: "openai",
    model: "platform-model",
  });
  assert.equal(customerResolve.status, 404);
});

test("cloud write routes keep 401 for missing or invalid Bearer credentials", async () => {
  await createActiveConnection();

  const { value: missing, logs: missingLogs } = await captureConsoleLog(() =>
    credentialsRoute.PUT(cloudCredentialsRequest(null))
  );
  const { value: invalid, logs: invalidLogs } = await captureConsoleLog(() =>
    aliasRoute.PUT(cloudAliasRequest("sk-invalid"))
  );
  await assertResponseDoesNotLeakSecrets(missing, ["new-access-secret", "new-refresh-secret"]);
  await assertResponseDoesNotLeakSecrets(invalid, ["openai/gpt-4o-mini"]);
  assertTextDoesNotLeakSecrets(missingLogs, "logs", ["new-access-secret", "new-refresh-secret"]);
  assertTextDoesNotLeakSecrets(invalidLogs, "logs", ["openai/gpt-4o-mini"]);

  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
});
