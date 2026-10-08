import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compliance-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const compliance = await import("../../src/lib/compliance/index.ts");
const auditRoute = await import("../../src/app/api/compliance/audit-log/route.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("compliance audit route keeps array payloads and exposes total count with structured filters", async () => {
  compliance.initAuditLog();
  compliance.logAuditEvent({
    action: "auth.login.success",
    actor: "admin",
    resourceType: "auth_session",
    status: "success",
    requestId: "req-login-1",
    ipAddress: "203.0.113.5",
    createdAt: "2026-04-14T12:00:00.000Z",
  });
  compliance.logAuditEvent({
    action: "provider.validation.ssrf_blocked",
    actor: "admin",
    target: "provider-node",
    resourceType: "provider_validation",
    status: "blocked",
    requestId: "req-validation-1",
    metadata: {
      route: "/api/provider-nodes/validate",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    createdAt: "2026-04-14T13:00:00.000Z",
  });

  const response = await auditRoute.GET(
    new Request(
      "http://localhost/api/compliance/audit-log?resourceType=provider_validation&status=blocked&requestId=req-validation-1&limit=10&offset=0"
    )
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-total-count"), "1");
  assert.equal(response.headers.get("x-page-limit"), "10");
  const payload: unknown = await response.json();
  assert.equal(Array.isArray(payload), true);
  const entries = payload as Array<Record<string, unknown>>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "provider.validation.ssrf_blocked");
  assert.equal(entries[0].resourceType, "provider_validation");
  assert.equal(entries[0].requestId, "req-validation-1");
});

test("audit log queries and route results are isolated by the current tenant", async () => {
  compliance.initAuditLog();
  runWithTenantContext({ tenantId: "tenant_a", role: "owner" }, () =>
    compliance.logAuditEvent({ action: "tenant.a.secret", target: "a-only" })
  );
  runWithTenantContext({ tenantId: "tenant_b", role: "owner" }, () =>
    compliance.logAuditEvent({ action: "tenant.b.secret", target: "b-only" })
  );

  const entriesA = runWithTenantContext({ tenantId: "tenant_a", role: "owner" }, () =>
    compliance.getAuditLog()
  );
  const entriesB = runWithTenantContext({ tenantId: "tenant_b", role: "owner" }, () =>
    compliance.getAuditLog()
  );
  assert.deepEqual(
    entriesA.map((entry) => entry.target),
    ["a-only"]
  );
  assert.deepEqual(
    entriesB.map((entry) => entry.target),
    ["b-only"]
  );

  const response = await runWithTenantContext({ tenantId: "tenant_a", role: "owner" }, () =>
    auditRoute.GET(new Request("http://localhost/api/compliance/audit-log"))
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Array<{ target: string }>;
  assert.deepEqual(
    payload.map((entry) => entry.target),
    ["a-only"]
  );
});
