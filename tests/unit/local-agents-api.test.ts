import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-local-agents-api-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "local-agent-api-test-secret-1234567890";
process.env.INITIAL_PASSWORD = "local-agent-api-auth-required";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const registry = await import("../../src/lib/db/localAgents.ts");
const compliance = await import("../../src/lib/compliance/index.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const { signLocalAgentHeartbeat } = await import("../../src/lib/localAgent/protocol.ts");
const collection = await import("../../src/app/api/local-agents/route.ts");
const item = await import("../../src/app/api/local-agents/[id]/route.ts");
const heartbeatRoute = await import("../../src/app/api/local-agents/heartbeat/route.ts");

const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

async function resetStorage() {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'customer', 1, ?, ?)`
  );
  insert.run("api_agent_a", "API Agent A", "api-agent-a", now, now);
  insert.run("api_agent_b", "API Agent B", "api-agent-b", now, now);
}

async function createManagementKey(tenantId: string, name: string) {
  return runWithTenantContext({ tenantId, role: "owner" }, () =>
    apiKeys.createApiKey(name, `machine-${tenantId}`, ["manage"])
  );
}

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

function request(pathname: string, method: string, key?: string, body?: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test.beforeEach(resetStorage);
test.after(() => {
  apiKeys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_INITIAL_PASSWORD === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
});

test("local agent register/list/revoke routes require management auth and stay tenant-scoped", async () => {
  assert.equal((await collection.GET(request("/api/local-agents", "GET"))).status, 401);
  const keyA = await createManagementKey("api_agent_a", "Tenant A management");
  const keyB = await createManagementKey("api_agent_b", "Tenant B management");

  const spoofed = await asTenant("api_agent_b", () =>
    collection.POST(
      request("/api/local-agents", "POST", keyB.key, {
        name: "spoofed",
        tenantId: "api_agent_a",
      })
    )
  );
  assert.equal(spoofed.status, 403);

  const createdResponse = await asTenant("api_agent_a", () =>
    collection.POST(request("/api/local-agents", "POST", keyA.key, { name: "tenant-a-worker" }))
  );
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  assert.equal(createdResponse.headers.get("cache-control"), "no-store");
  const registration = (await createdResponse.json()) as {
    device: { id: string; tenantId: string };
    credential: string;
  };
  assert.equal(registration.device.tenantId, "api_agent_a");
  assert.ok(registration.credential);

  const listA = await asTenant("api_agent_a", () =>
    collection.GET(request("/api/local-agents", "GET", keyA.key))
  );
  assert.equal(((await listA.json()) as { agents: unknown[] }).agents.length, 1);
  const listB = await asTenant("api_agent_b", () =>
    collection.GET(request("/api/local-agents", "GET", keyB.key))
  );
  assert.deepEqual(((await listB.json()) as { agents: unknown[] }).agents, []);

  const crossTenantRevoke = await asTenant("api_agent_b", () =>
    item.DELETE(request(`/api/local-agents/${registration.device.id}`, "DELETE", keyB.key), {
      params: Promise.resolve({ id: registration.device.id }),
    })
  );
  assert.equal(crossTenantRevoke.status, 404);
  const revoke = await asTenant("api_agent_a", () =>
    item.DELETE(request(`/api/local-agents/${registration.device.id}`, "DELETE", keyA.key), {
      params: Promise.resolve({ id: registration.device.id }),
    })
  );
  assert.equal(revoke.status, 200);

  const auditEvents = asTenant("api_agent_a", () =>
    compliance.getAuditLog({ resourceType: "local_agent", limit: 10 })
  );
  assert.deepEqual(auditEvents.map((event) => event.action).sort(), [
    "localAgent.register",
    "localAgent.revoke",
  ]);
  assert.ok(auditEvents.every((event) => event.status === "success"));
  assert.doesNotMatch(JSON.stringify(auditEvents), new RegExp(registration.credential));
});

test("heartbeat is device-authenticated, tenant-bound, uncached, and replay-protected", async () => {
  const registration = asTenant("api_agent_a", () =>
    registry.registerLocalAgent({ name: "heartbeat-worker" })
  );
  const otherTenantRegistration = asTenant("api_agent_b", () =>
    registry.registerLocalAgent({ name: "other-tenant-worker" })
  );
  const timestamp = Date.now();
  const nonce = "api-route-heartbeat-nonce-001";
  const payload = {
    status: "online" as const,
    capabilities: ["ollama"],
    serviceHealth: { ollama: true, comfyui: false },
  };
  const body = {
    deviceId: registration.device.id,
    credential: registration.credential,
    timestamp,
    nonce,
    signature: signLocalAgentHeartbeat(registration.credential, timestamp, nonce, payload),
    payload,
  };

  const accepted = await heartbeatRoute.POST(
    request("/api/local-agents/heartbeat", "POST", undefined, body)
  );
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    ((await accepted.json()) as { agent: { serviceHealth: unknown } }).agent.serviceHealth,
    payload.serviceHealth
  );
  const transitionAudit = asTenant("api_agent_a", () =>
    compliance.getAuditLog({ resourceType: "local_agent", limit: 10 })
  );
  assert.equal(transitionAudit.length, 1);
  assert.equal(transitionAudit[0].action, "localAgent.heartbeat_transition");
  assert.deepEqual(transitionAudit[0].details, {
    previousStatus: "offline",
    status: "online",
    capabilitiesChanged: true,
    serviceHealthChanged: true,
  });

  const unchangedNonce = "api-route-heartbeat-nonce-004";
  const unchanged = await heartbeatRoute.POST(
    request("/api/local-agents/heartbeat", "POST", undefined, {
      ...body,
      nonce: unchangedNonce,
      signature: signLocalAgentHeartbeat(
        registration.credential,
        timestamp,
        unchangedNonce,
        payload
      ),
    })
  );
  assert.equal(unchanged.status, 200);
  const unchangedAudit = asTenant("api_agent_a", () =>
    compliance.getAuditLog({ resourceType: "local_agent", limit: 10 })
  );
  assert.equal(unchangedAudit.length, 1, "unchanged heartbeats do not add audit noise");

  const replay = await asTenant("api_agent_a", () =>
    heartbeatRoute.POST(request("/api/local-agents/heartbeat", "POST", undefined, body))
  );
  assert.equal(replay.status, 401);

  const forged = await asTenant("api_agent_a", () =>
    heartbeatRoute.POST(
      request("/api/local-agents/heartbeat", "POST", undefined, {
        ...body,
        nonce: "api-route-heartbeat-nonce-002",
        payload: { status: "busy", capabilities: [] },
      })
    )
  );
  assert.equal(forged.status, 401);

  const impersonationNonce = "cross-tenant-heartbeat-nonce-003";
  const impersonationPayload = { status: "busy" as const, capabilities: ["ollama"] };
  const impersonation = await heartbeatRoute.POST(
    request("/api/local-agents/heartbeat", "POST", undefined, {
      deviceId: registration.device.id,
      credential: otherTenantRegistration.credential,
      timestamp,
      nonce: impersonationNonce,
      signature: signLocalAgentHeartbeat(
        otherTenantRegistration.credential,
        timestamp,
        impersonationNonce,
        impersonationPayload
      ),
      payload: impersonationPayload,
    })
  );
  assert.equal(impersonation.status, 401);

  const suppliedTenant = await heartbeatRoute.POST(
    request("/api/local-agents/heartbeat", "POST", undefined, {
      ...body,
      tenantId: "api_agent_b",
    })
  );
  assert.equal(suppliedTenant.status, 400);
});
