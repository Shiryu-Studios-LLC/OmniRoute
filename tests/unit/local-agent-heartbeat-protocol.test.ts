import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-local-agent-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const agents = await import("../../src/lib/db/localAgents.ts");
const { signLocalAgentHeartbeat } = await import("../../src/lib/localAgent/protocol.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

function seedTenants() {
  const now = new Date().toISOString();
  const insert = core.getDbInstance().prepare(
    `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'customer', 1, ?, ?)`
  );
  insert.run("agent_tenant_a", "Agent Tenant A", "agent-tenant-a", now, now);
  insert.run("agent_tenant_b", "Agent Tenant B", "agent-tenant-b", now, now);
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("registration issues a one-time credential and isolates device inventory per tenant", () => {
  seedTenants();
  const registration = asTenant("agent_tenant_a", () =>
    agents.registerLocalAgent({ name: "ollama-worker" })
  );
  assert.equal(registration.device.tenantId, "agent_tenant_a");
  assert.equal(registration.credential.length, 43);
  assert.equal(JSON.stringify(agents.listLocalAgents()).includes(registration.credential), false);
  assert.deepEqual(
    asTenant("agent_tenant_b", () => agents.listLocalAgents()),
    []
  );
  assert.equal(
    asTenant("agent_tenant_b", () => agents.getLocalAgent(registration.device.id)),
    null
  );
  assert.equal(
    asTenant("agent_tenant_b", () => agents.revokeLocalAgent(registration.device.id)),
    false
  );
  assert.throws(
    () =>
      asTenant("agent_tenant_b", () =>
        agents.registerLocalAgent({ tenantId: "agent_tenant_a", name: "spoofed" })
      ),
    /Cross-tenant database operation denied/
  );
});

test("signed heartbeats update status and reject tampering, replay, and stale timestamps", () => {
  seedTenants();
  const nowMs = Date.now();
  const registration = asTenant("agent_tenant_a", () =>
    agents.registerLocalAgent({ name: "comfyui-worker" })
  );
  const payload = {
    status: "busy" as const,
    capabilities: ["comfyui", "ollama"],
    serviceHealth: { ollama: true, comfyui: false },
  };
  const nonce = "first-heartbeat-nonce-0001";
  const signature = signLocalAgentHeartbeat(registration.credential, nowMs, nonce, payload);
  const request = {
    deviceId: registration.device.id,
    credential: registration.credential,
    timestamp: nowMs,
    nonce,
    signature,
    payload,
    nowMs,
  };

  const updated = asTenant("agent_tenant_a", () => agents.acceptLocalAgentHeartbeat(request));
  assert.equal(updated.status, "busy");
  assert.deepEqual(updated.capabilities, ["comfyui", "ollama"]);
  assert.deepEqual(updated.serviceHealth, { ollama: true, comfyui: false });
  assert.notEqual(
    signLocalAgentHeartbeat(registration.credential, nowMs, "signed-health-tamper-0001", payload),
    signLocalAgentHeartbeat(registration.credential, nowMs, "signed-health-tamper-0001", {
      ...payload,
      serviceHealth: { ollama: false, comfyui: false },
    })
  );
  assert.equal(updated.lastSeenAt, new Date(nowMs).toISOString());

  const nextNonce = "health-omitted-heartbeat-0001";
  const legacyPayload = { status: "online" as const, capabilities: ["ollama"] };
  const legacyUpdated = asTenant("agent_tenant_a", () =>
    agents.acceptLocalAgentHeartbeat({
      deviceId: registration.device.id,
      credential: registration.credential,
      timestamp: nowMs + 1,
      nonce: nextNonce,
      signature: signLocalAgentHeartbeat(
        registration.credential,
        nowMs + 1,
        nextNonce,
        legacyPayload
      ),
      payload: legacyPayload,
      nowMs: nowMs + 1,
    })
  );
  assert.equal(
    legacyUpdated.serviceHealth,
    null,
    "older agents clear stale health and remain valid"
  );
  core
    .getDbInstance()
    .prepare("UPDATE local_agent_devices SET service_health_json = ? WHERE id = ?")
    .run("{malformed", registration.device.id);
  assert.equal(
    asTenant("agent_tenant_a", () => agents.getLocalAgent(registration.device.id))?.serviceHealth,
    null,
    "corrupt stored health fails closed"
  );

  assert.throws(
    () => asTenant("agent_tenant_a", () => agents.acceptLocalAgentHeartbeat(request)),
    /Heartbeat replay rejected/
  );
  assert.throws(
    () =>
      asTenant("agent_tenant_a", () =>
        agents.acceptLocalAgentHeartbeat({
          ...request,
          nonce: "different-heartbeat-nonce-0002",
          payload: { status: "online", capabilities: ["ollama"] },
        })
      ),
    /Invalid local agent signature/
  );
  assert.throws(
    () =>
      asTenant("agent_tenant_a", () =>
        agents.acceptLocalAgentHeartbeat({
          ...request,
          nonce: "stale-heartbeat-nonce-0003",
          timestamp: nowMs - 6 * 60 * 1000,
        })
      ),
    /outside allowed window/
  );
});

test("heartbeat credentials are tenant-bound and revocation immediately blocks signed traffic", () => {
  seedTenants();
  const registration = asTenant("agent_tenant_a", () =>
    agents.registerLocalAgent({ name: "local-worker" })
  );
  const timestamp = Date.now();
  const payload = { status: "online" as const, capabilities: [] };
  const heartbeat = {
    deviceId: registration.device.id,
    credential: registration.credential,
    timestamp,
    nonce: "tenant-bound-heartbeat-nonce-1",
    payload,
    signature: signLocalAgentHeartbeat(
      registration.credential,
      timestamp,
      "tenant-bound-heartbeat-nonce-1",
      payload
    ),
  };

  assert.throws(
    () =>
      asTenant("agent_tenant_b", () =>
        agents.acceptLocalAgentHeartbeat({ ...heartbeat, nowMs: timestamp })
      ),
    /Local agent is unavailable/
  );
  assert.equal(
    asTenant("agent_tenant_a", () => agents.revokeLocalAgent(registration.device.id)),
    true
  );
  assert.throws(
    () =>
      asTenant("agent_tenant_a", () =>
        agents.acceptLocalAgentHeartbeat({ ...heartbeat, nowMs: timestamp })
      ),
    /Local agent is unavailable/
  );
  assert.ok(
    asTenant("agent_tenant_a", () => agents.getLocalAgent(registration.device.id))?.revokedAt
  );
});
