import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TenantRole } from "../../../src/lib/db/tenants.ts";
import {
  getTenantManagementPermission,
  hasTenantManagementPermission,
  isTenantManagementResource,
  type TenantManagementPermission,
} from "../../../src/server/authz/tenantPermissions.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-tenant-permissions-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-tenant-role-policy-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../../src/lib/db/core.ts");
const apiKeys = await import("../../../src/lib/db/apiKeys.ts");
const tenants = await import("../../../src/lib/db/tenants.ts");
const settings = await import("../../../src/lib/db/settings.ts");
const { runWithTenantContext } = await import("../../../src/lib/tenantContext.ts");

const ORIGINAL_JWT = process.env.JWT_SECRET;
const ORIGINAL_INITIAL = process.env.INITIAL_PASSWORD;

function reset() {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.JWT_SECRET = "tenant-role-test-jwt-secret";
  delete process.env.INITIAL_PASSWORD;
}

test.beforeEach(reset);
test.after(() => {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_JWT === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT;
  if (ORIGINAL_INITIAL === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL;
});

async function loadManagementPolicy() {
  const mod = await import(
    `../../../src/server/authz/policies/management.ts?tenant-role=${Date.now()}`
  );
  return mod.managementPolicy;
}

function policyContext(headers: Headers, method: string, path: string) {
  return {
    request: {
      method,
      headers,
      url: `http://localhost${path}`,
      nextUrl: { pathname: path },
    },
    classification: {
      routeClass: "MANAGEMENT" as const,
      reason: "management_api" as const,
      normalizedPath: path,
    },
    requestId: "tenant-role-test",
  };
}

test("tenant role permission matrix separates read, manage, and maintenance", () => {
  const roles: TenantRole[] = ["owner", "admin", "member", "maintenance"];
  const permissions: TenantManagementPermission[] = ["read", "manage", "maintenance"];
  assert.deepEqual(
    roles.map((role) =>
      permissions.map((permission) => hasTenantManagementPermission(role, permission))
    ),
    [
      [true, true, true],
      [true, true, true],
      [true, false, false],
      [true, false, true],
    ]
  );
  assert.equal(getTenantManagementPermission("/api/keys", "GET"), "read");
  assert.equal(getTenantManagementPermission("/api/keys", "POST"), "manage");
  assert.equal(getTenantManagementPermission("/api/keys/key-1/reveal", "GET"), "manage");
  assert.equal(
    getTenantManagementPermission("/api/providers/health-autopilot/actions", "POST"),
    "maintenance"
  );
  assert.equal(isTenantManagementResource("/api/keys/key-1"), true);
  assert.equal(isTenantManagementResource("/api/keys-extra"), false);
  assert.equal(isTenantManagementResource("/api/local-agents"), true);
  assert.equal(isTenantManagementResource("/api/provider-nodes"), true);
  assert.equal(getTenantManagementPermission("/api/provider-nodes", "GET"), "read");
  assert.equal(getTenantManagementPermission("/api/provider-nodes/node-1", "PUT"), "manage");
  assert.equal(isTenantManagementResource("/api/resilience/connections"), true);
  assert.equal(getTenantManagementPermission("/api/resilience/connections", "GET"), "read");
  assert.equal(getTenantManagementPermission("/api/local-agents", "GET"), "read");
  assert.equal(getTenantManagementPermission("/api/local-agents", "POST"), "manage");
  assert.equal(getTenantManagementPermission("/api/local-agents/device-1", "DELETE"), "manage");
  assert.equal(isTenantManagementResource("/api/cache/reasoning"), true);
  assert.equal(getTenantManagementPermission("/api/cache/reasoning", "GET"), "manage");
  assert.equal(getTenantManagementPermission("/api/cache/reasoning", "DELETE"), "manage");
  assert.equal(isTenantManagementResource("/api/quota/groups"), true);
  assert.equal(getTenantManagementPermission("/api/quota/groups", "GET"), "read");
  assert.equal(getTenantManagementPermission("/api/quota/groups", "POST"), "manage");
  assert.equal(getTenantManagementPermission("/api/quota/pools/pool-1", "PATCH"), "manage");
  assert.equal(isTenantManagementResource("/api/usage/token-limits"), true);
  assert.equal(getTenantManagementPermission("/api/usage/token-limits", "POST"), "manage");
  assert.equal(getTenantManagementPermission("/api/usage/budget", "GET"), "read");
  assert.equal(getTenantManagementPermission("/api/usage/budget", "POST"), "manage");
  assert.equal(isTenantManagementResource("/api/usage/budget/bulk"), true);
  assert.equal(getTenantManagementPermission("/api/settings", "PATCH"), null);
});

test("management policy applies explicit tenant roles to tenant resource routes", async () => {
  process.env.INITIAL_PASSWORD = "tenant-role-test-password";
  await settings.updateSettings({ requireLogin: true });
  const tenant = tenants.createCustomerTenant("Policy Tenant", "policy-tenant");
  const key = await runWithTenantContext({ tenantId: tenant.id }, () =>
    apiKeys.createApiKey("Member management key", "machine-member", ["manage"])
  );
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      "INSERT INTO tenant_members (id, tenant_id, principal_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run("member-policy-1", tenant.id, key.id, "member", now, now);

  const policy = await loadManagementPolicy();
  const headers = new Headers({ authorization: `Bearer ${key.key}` });
  const read = await policy.evaluate(policyContext(headers, "GET", "/api/keys"));
  assert.equal(read.allow, true);

  const write = await policy.evaluate(policyContext(headers, "POST", "/api/keys"));
  assert.deepEqual(write, {
    allow: false,
    status: 403,
    code: "TENANT_ROLE_FORBIDDEN",
    message: "Tenant role does not permit this operation",
  });

  const localAgentRegistration = await policy.evaluate(
    policyContext(headers, "POST", "/api/local-agents")
  );
  assert.equal(localAgentRegistration.allow, false);
  assert.equal(localAgentRegistration.status, 403);
  const localAgentRevocation = await policy.evaluate(
    policyContext(headers, "DELETE", "/api/local-agents/device-1")
  );
  assert.equal(localAgentRevocation.allow, false);
  assert.equal(localAgentRevocation.status, 403);

  const providerNodeRead = await policy.evaluate(
    policyContext(headers, "GET", "/api/provider-nodes")
  );
  assert.equal(providerNodeRead.allow, true);
  const providerNodeWrite = await policy.evaluate(
    policyContext(headers, "POST", "/api/provider-nodes")
  );
  assert.equal(providerNodeWrite.allow, false);
  assert.equal(providerNodeWrite.status, 403);

  const quotaRead = await policy.evaluate(policyContext(headers, "GET", "/api/quota/groups"));
  assert.equal(quotaRead.allow, true);
  const quotaWrite = await policy.evaluate(policyContext(headers, "POST", "/api/quota/groups"));
  assert.equal(quotaWrite.allow, false);
  assert.equal(quotaWrite.status, 403);

  const usageWrite = await policy.evaluate(
    policyContext(headers, "POST", "/api/usage/token-limits")
  );
  assert.equal(usageWrite.allow, false);
  assert.equal(usageWrite.status, 403);

  const reveal = await policy.evaluate(policyContext(headers, "GET", "/api/keys/key-1/reveal"));
  assert.equal(reveal.allow, false);

  const budgetRead = await policy.evaluate(
    policyContext(headers, "GET", "/api/usage/budget?apiKeyId=tenant-key")
  );
  assert.equal(budgetRead.allow, true, "member role may read its tenant budget summary");
  const budgetWrite = await policy.evaluate(policyContext(headers, "POST", "/api/usage/budget"));
  assert.deepEqual(budgetWrite, {
    allow: false,
    status: 403,
    code: "TENANT_ROLE_FORBIDDEN",
    message: "Tenant role does not permit this operation",
  });

  core
    .getDbInstance()
    .prepare(
      "UPDATE tenant_members SET role = 'maintenance' WHERE tenant_id = ? AND principal_id = ?"
    )
    .run(tenant.id, key.id);
  const maintenanceRead = await policy.evaluate(
    policyContext(headers, "GET", "/api/providers/health-matrix")
  );
  assert.equal(maintenanceRead.allow, true, "maintenance role may reach maintenance surfaces");
  const maintenanceWrite = await policy.evaluate(policyContext(headers, "POST", "/api/keys"));
  assert.equal(maintenanceWrite.allow, false, "maintenance role cannot manage tenant API keys");
});

test("legacy management keys without an explicit tenant role keep existing scope behavior", async () => {
  const key = await apiKeys.createApiKey("Legacy management key", "machine-admin", ["manage"]);
  const policy = await loadManagementPolicy();
  const result = await policy.evaluate(
    policyContext(new Headers({ authorization: `Bearer ${key.key}` }), "POST", "/api/keys")
  );
  assert.equal(result.allow, true);
});

test("customer management keys require an explicit tenant membership", async () => {
  process.env.INITIAL_PASSWORD = "tenant-role-test-password";
  await settings.updateSettings({ requireLogin: true });
  const tenant = tenants.createCustomerTenant("Unassigned Tenant", "unassigned-tenant");
  const key = await runWithTenantContext({ tenantId: tenant.id }, () =>
    apiKeys.createApiKey("Unassigned management key", "machine-admin", ["manage"])
  );
  const policy = await loadManagementPolicy();
  const headers = new Headers({ authorization: `Bearer ${key.key}` });

  for (const [method, route] of [
    ["GET", "/api/keys"],
    ["POST", "/api/keys"],
    ["GET", "/api/local-agents"],
  ] as const) {
    const result = await policy.evaluate(policyContext(headers, method, route));
    assert.deepEqual(result, {
      allow: false,
      status: 403,
      code: "TENANT_MEMBERSHIP_REQUIRED",
      message: "Tenant membership is required for customer management access",
    });
  }
});
