import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-node-tenants-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "provider-node-tenant-isolation-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.INITIAL_PASSWORD = "provider-node-tenant-isolation-password";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const accessTokens = await import("../../src/lib/db/accessTokens.ts");
const { createCustomerTenant, SHIRYU_ADMIN_TENANT_ID } =
  await import("../../src/lib/db/tenants.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const settings = await import("../../src/lib/db/settings.ts");
const providers = await import("../../src/lib/db/providers.ts");
const combos = await import("../../src/lib/db/combos.ts");
const providerNodesRoute = await import("../../src/app/api/provider-nodes/route.ts");
const providerNodeRoute = await import("../../src/app/api/provider-nodes/[id]/route.ts");
const providerConnectionsRoute = await import("../../src/app/api/providers/route.ts");
const providerClientRoute = await import("../../src/app/api/providers/client/route.ts");
const combosRoute = await import("../../src/app/api/combos/route.ts");
const resilienceConnectionsRoute =
  await import("../../src/app/api/resilience/connections/route.ts");
const zedManualImportRoute = await import("../../src/app/api/providers/zed/manual-import/route.ts");
const providerParamFiltersRoute =
  await import("../../src/app/api/providers/[id]/param-filters/route.ts");
const comboMetricsRoute = await import("../../src/app/api/combos/metrics/route.ts");
const providerExpirationRoute = await import("../../src/app/api/providers/expiration/route.ts");
const { withManagementTenantContext } = await import("../../src/lib/api/requireManagementAuth.ts");

async function reset() {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settings.updateSettings({ requireLogin: true });
}

function authRequest(url: string, key: string, method = "GET", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test.beforeEach(reset);
test.after(() => {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.INITIAL_PASSWORD;
});

test("tenant API key scopes provider-node CRUD to its tenant", async () => {
  const tenant = createCustomerTenant("Provider Node Tenant", `provider-node-${Date.now()}`);
  const key = await runWithTenantContext({ tenantId: tenant.id }, () =>
    apiKeys.createApiKey("Tenant management", "machine-test", ["manage"])
  );
  assert.equal(key.tenantId, tenant.id);
  assert.equal((await settings.getSettings()).requireLogin, true);
  assert.equal((await apiKeys.getApiKeyMetadata(key.key))?.tenantId, tenant.id);
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO tenant_members (id, tenant_id, principal_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)"
    )
    .run("provider-node-owner", tenant.id, key.id, now, now);

  await providers.createProviderNode({
    id: "platform-node",
    tenantId: SHIRYU_ADMIN_TENANT_ID,
    name: "Platform node",
    prefix: "platform",
    type: "openai-compatible",
    apiType: "chat",
    baseUrl: "https://platform.example.com/v1",
  });
  const platformConnection = await providers.createProviderConnection({
    id: "platform-connection",
    provider: "openai",
    authType: "apikey",
    apiKey: "platform-secret",
    name: "Platform connection",
  });
  const customerConnection = await runWithTenantContext({ tenantId: tenant.id }, () =>
    providers.createProviderConnection({
      id: "customer-connection",
      provider: "openai",
      authType: "apikey",
      apiKey: "customer-secret",
      name: "Customer connection",
    })
  );
  await runWithTenantContext({ tenantId: SHIRYU_ADMIN_TENANT_ID }, () =>
    combos.createCombo({ name: "Platform combo", models: [], strategy: "priority", config: {} })
  );
  await runWithTenantContext({ tenantId: tenant.id }, () =>
    combos.createCombo({ name: "Customer combo", models: [], strategy: "priority", config: {} })
  );

  const listedConnections = await providerConnectionsRoute.GET(
    authRequest("http://localhost/api/providers", key.key)
  );
  const connectionBody = (await listedConnections.json()) as {
    connections: Array<{ id: string; name: string }>;
  };
  assert.equal(listedConnections.status, 200);
  assert.deepEqual(
    connectionBody.connections.map((connection) => connection.id),
    [customerConnection.id]
  );
  const clientSync = await providerClientRoute.GET(
    authRequest("http://localhost/api/providers/client", key.key)
  );
  const clientSyncBody = (await clientSync.json()) as {
    connections: Array<{ id: string; apiKey: string }>;
  };
  assert.equal(clientSync.status, 200);
  assert.deepEqual(
    clientSyncBody.connections.map((connection) => connection.id),
    [customerConnection.id]
  );
  assert.equal(clientSyncBody.connections[0]?.apiKey, "customer-secret");
  const resilience = await resilienceConnectionsRoute.GET(
    authRequest("http://localhost/api/resilience/connections", key.key) as never
  );
  const resilienceBody = (await resilience.json()) as { connections: Array<{ id: string }> };
  assert.equal(resilience.status, 200);
  assert.deepEqual(
    resilienceBody.connections.map((connection) => connection.id),
    [customerConnection.id]
  );
  assert.equal(
    core
      .getDbInstance()
      .prepare("SELECT id FROM provider_connections WHERE id = ?")
      .get(platformConnection.id) !== undefined,
    true
  );

  const listedCombos = await combosRoute.GET(authRequest("http://localhost/api/combos", key.key));
  const comboBody = (await listedCombos.json()) as { combos: Array<{ name: string }> };
  assert.equal(listedCombos.status, 200);
  assert.deepEqual(
    comboBody.combos.map((combo) => combo.name),
    ["Customer combo"]
  );

  const created = await providerNodesRoute.POST(
    authRequest("http://localhost/api/provider-nodes", key.key, "POST", {
      name: "Customer node",
      prefix: "customer",
      apiType: "chat",
      baseUrl: "https://customer.example.com/v1",
    })
  );
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { node: { id: string } };

  const storedTenants = core
    .getDbInstance()
    .prepare("SELECT tenant_id FROM provider_nodes WHERE id = ?")
    .get(createdBody.node.id) as { tenant_id: string } | undefined;
  assert.equal(storedTenants?.tenant_id, tenant.id);

  const listed = await providerNodesRoute.GET(
    authRequest("http://localhost/api/provider-nodes", key.key)
  );
  const listedBody = (await listed.json()) as { nodes: Array<{ id: string; name: string }> };
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listedBody.nodes.map((node) => node.name),
    ["Customer node"]
  );

  const platformDelete = await providerNodeRoute.DELETE(
    authRequest("http://localhost/api/provider-nodes/platform-node", key.key, "DELETE"),
    { params: Promise.resolve({ id: "platform-node" }) }
  );
  assert.equal(platformDelete.status, 404);
  assert.equal(
    core
      .getDbInstance()
      .prepare("SELECT id FROM provider_nodes WHERE id = 'platform-node'")
      .get() != null,
    true
  );
});

test("specialized provider imports use tenant ownership and global provider settings reject tenant keys", async () => {
  const tenant = createCustomerTenant(
    "Specialized Provider Tenant",
    `provider-special-${Date.now()}`
  );
  const key = await runWithTenantContext({ tenantId: tenant.id }, () =>
    apiKeys.createApiKey("Tenant management", "machine-special", ["manage"])
  );
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO tenant_members (id, tenant_id, principal_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)"
    )
    .run("provider-special-owner", tenant.id, key.id, now, now);

  const imported = await zedManualImportRoute.POST(
    authRequest("http://localhost/api/providers/zed/manual-import", key.key, "POST", {
      provider: "zed-openai",
      token: "tenant-owned-secret",
    })
  );
  assert.equal(imported.status, 200);
  const importedBody = (await imported.json()) as { connectionId: string };
  const owner = core
    .getDbInstance()
    .prepare("SELECT tenant_id FROM provider_connections WHERE id = ?")
    .get(importedBody.connectionId) as { tenant_id: string } | undefined;
  assert.equal(owner?.tenant_id, tenant.id);

  const globalFilters = await providerParamFiltersRoute.GET(
    authRequest("http://localhost/api/providers/openai/param-filters", key.key),
    { params: Promise.resolve({ id: "openai" }) }
  );
  assert.equal(globalFilters.status, 403);

  const globalMetrics = await comboMetricsRoute.GET(
    authRequest("http://localhost/api/combos/metrics", key.key)
  );
  assert.equal(globalMetrics.status, 403);

  const globalExpiration = await providerExpirationRoute.GET(
    authRequest("http://localhost/api/providers/expiration", key.key)
  );
  assert.equal(globalExpiration.status, 403);

  // CLI access tokens are global management credentials with no tenant_id in
  // their persisted record, so the management helper deliberately runs them as
  // the platform principal.
  const cliToken = accessTokens.createAccessToken({ name: "Platform CLI", scope: "read" });
  const platformMetrics = await comboMetricsRoute.GET(
    authRequest("http://localhost/api/combos/metrics", cliToken.secret)
  );
  assert.equal(platformMetrics.status, 200);
});

test("dashboard auth stays platform when an inference-only customer key is also present", async () => {
  const tenant = createCustomerTenant("Mixed Credential Tenant", `mixed-${Date.now()}`);
  const key = await runWithTenantContext({ tenantId: tenant.id }, () =>
    apiKeys.createApiKey("Inference only", "machine-inference", [])
  );
  const platformConnection = await providers.createProviderConnection({
    id: "mixed-platform-connection",
    provider: "openai",
    authType: "apikey",
    apiKey: "platform-secret",
    name: "Platform connection",
  });
  await runWithTenantContext({ tenantId: tenant.id }, () =>
    providers.createProviderConnection({
      id: "mixed-customer-connection",
      provider: "openai",
      authType: "apikey",
      apiKey: "customer-secret",
      name: "Customer connection",
    })
  );

  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "provider-node-dashboard-session-secret";
  try {
    const dashboardToken = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const response = await providerConnectionsRoute.GET(
      new Request("http://localhost/api/providers", {
        headers: {
          authorization: `Bearer ${key.key}`,
          cookie: `auth_token=${dashboardToken}`,
        },
      })
    );
    const body = (await response.json()) as { connections: Array<{ id: string }> };
    assert.equal(response.status, 200);
    assert.deepEqual(
      body.connections.map((connection) => connection.id),
      [platformConnection.id]
    );
  } finally {
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  }
});

test("management tenant context fails closed when API key metadata disappears after auth", async () => {
  const tenant = createCustomerTenant("Revoked Metadata Tenant", `metadata-${Date.now()}`);
  const key = await runWithTenantContext({ tenantId: tenant.id }, () =>
    apiKeys.createApiKey("Tenant management", "machine-metadata", ["manage"])
  );
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO tenant_members (id, tenant_id, principal_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)"
    )
    .run("metadata-owner", tenant.id, key.id, now, now);

  let handlerCalled = false;
  const result = await withManagementTenantContext(
    authRequest("http://localhost/api/provider-nodes", key.key),
    async () => {
      handlerCalled = true;
      return new Response("unexpected");
    },
    async () => null
  );
  assert.equal(handlerCalled, false);
  assert.equal(result instanceof Response, true);
  assert.equal((result as Response).status, 403);
});

test("customer management requires membership and role for direct route calls", async () => {
  const tenant = createCustomerTenant("Membership Required Tenant", `membership-${Date.now()}`);
  const rolelessKey = await runWithTenantContext({ tenantId: tenant.id }, () =>
    apiKeys.createApiKey("Roleless management", "machine-roleless", ["manage"])
  );
  const rolelessResult = await providerNodesRoute.GET(
    authRequest("http://localhost/api/provider-nodes", rolelessKey.key)
  );
  assert.equal(rolelessResult.status, 403);

  const memberKey = await runWithTenantContext({ tenantId: tenant.id }, () =>
    apiKeys.createApiKey("Member management", "machine-member", ["manage"])
  );
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO tenant_members (id, tenant_id, principal_id, role, created_at, updated_at) VALUES (?, ?, ?, 'member', ?, ?)"
    )
    .run("management-member", tenant.id, memberKey.id, now, now);

  const mutation = await providerNodesRoute.POST(
    authRequest("http://localhost/api/provider-nodes", memberKey.key, "POST", {
      name: "Denied member node",
      prefix: "denied-member",
      apiType: "chat",
      baseUrl: "https://member.example.com/v1",
    })
  );
  assert.equal(mutation.status, 403);
  assert.equal(
    core
      .getDbInstance()
      .prepare("SELECT id FROM provider_nodes WHERE prefix = 'denied-member'")
      .get(),
    undefined
  );
});

test("customer API keys with a missing tenant are denied", async () => {
  const tenant = createCustomerTenant("Missing Tenant Setup", `missing-tenant-${Date.now()}`);
  const key = await runWithTenantContext({ tenantId: tenant.id }, () =>
    apiKeys.createApiKey("Tenant management", "machine-missing-tenant", ["manage"])
  );
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO tenant_members (id, tenant_id, principal_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)"
    )
    .run("missing-tenant-owner", tenant.id, key.id, now, now);
  core
    .getDbInstance()
    .prepare("UPDATE api_keys SET tenant_id = ? WHERE id = ?")
    .run("tenant_missing_for_test", key.id);

  const response = await providerNodesRoute.GET(
    authRequest("http://localhost/api/provider-nodes", key.key)
  );
  assert.equal(response.status, 403);
});
