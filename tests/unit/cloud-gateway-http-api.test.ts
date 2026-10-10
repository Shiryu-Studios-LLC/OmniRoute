import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import type {
  GatewayCoordinatorStub,
  GatewayDurableObjectNamespace,
  GatewayDurableStorage,
  GatewayDurableStorageTransaction,
} from "../../src/cloud/connectorGatewayDurableObject";
import { GatewaySessionDurableObject } from "../../src/cloud/connectorGatewayDurableObject";
import {
  createCloudCustomerMembership,
  issueCloudCustomerApiKey,
} from "../../src/cloud/customerIdentity";
import { createHttpLocalAgentGatewayTransport } from "../../src/lib/localAgent/httpGatewayTransport";
import { pairLocalAgentCommand } from "../../bin/cli/commands/local-agent.mjs";
import { cleanupExpiredCloudGatewayPairings } from "../../src/cloud/gatewayPairing";
import { createCloudRuntime } from "../../src/cloud/runtime";

class SqliteStatement<T = unknown> implements CloudDbStatement<T> {
  private values: unknown[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): CloudDbStatement<T> {
    this.values = values;
    return this;
  }

  async first<U = T>(): Promise<U | null> {
    return (
      (this.db
        .prepare(this.sql)
        .get(...(this.values as (null | number | bigint | string | Uint8Array)[])) as
        U | undefined) ?? null
    );
  }

  async all<U = T>(): Promise<{ results: U[]; success: boolean; meta?: Record<string, unknown> }> {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...(this.values as (null | number | bigint | string | Uint8Array)[])) as U[],
      success: true,
    };
  }

  async run(): Promise<{ success: boolean; meta?: Record<string, unknown> }> {
    const result = this.db
      .prepare(this.sql)
      .run(...(this.values as (null | number | bigint | string | Uint8Array)[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 implements CloudDb {
  constructor(readonly db = new DatabaseSync(":memory:")) {}

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new SqliteStatement<T>(this.db, sql);
  }

  async batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    const results: unknown[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<unknown> {
    return this.db.exec(sql);
  }
}

class MemoryStorage implements GatewayDurableStorage, GatewayDurableStorageTransaction {
  private readonly values = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async transaction<T>(
    callback: (transaction: GatewayDurableStorageTransaction) => Promise<T>
  ): Promise<T> {
    return callback(this);
  }
}

class TestDurableObjectNamespace implements GatewayDurableObjectNamespace<GatewayCoordinatorStub> {
  private readonly objects = new Map<string, GatewaySessionDurableObject>();

  idFromName(name: string): string {
    return name;
  }

  get(id: unknown): GatewayCoordinatorStub {
    const name = String(id);
    let instance = this.objects.get(name);
    if (!instance) {
      instance = new GatewaySessionDurableObject({
        id: { name },
        storage: new MemoryStorage(),
      });
      this.objects.set(name, instance);
    }
    return instance;
  }
}

function createRuntimeFixture(
  options: {
    customerInvokeRateLimit?: { limit: number; windowMs: number };
    customerAuthFailureRateLimit?: { limit: number; windowMs: number };
    customerAuthFailureFallbackRateLimit?: { limit: number; windowMs: number };
    gatewayConnectRateLimit?: { limit: number; windowMs: number };
    gatewayConnectFallbackRateLimit?: { limit: number; windowMs: number };
    gatewayDeviceRateLimits?: {
      heartbeat?: { limit: number; windowMs: number };
      poll?: { limit: number; windowMs: number };
      result?: { limit: number; windowMs: number };
    };
    gatewayPairingIssueRateLimit?: { limit: number; windowMs: number };
    gatewayPairingExchangeRateLimit?: { limit: number; windowMs: number };
    gatewayRequestBodyTimeoutMs?: number;
    currentClock?: boolean;
    localAiEnabled?: boolean;
  } = {}
) {
  const d1 = new SqliteD1();
  for (const name of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0004_cloud_gateway_devices.sql",
    "0005_cloud_customer_identity.sql",
    "0006_gateway_invocation_idempotency.sql",
    "0007_gateway_device_service_health.sql",
    "0008_cloud_tenant_settings.sql",
    "0017_cloud_gateway_pairings.sql",
  ]) {
    d1.db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", name), "utf8"));
  }
  const now = "2026-10-08T12:00:00.000Z";
  d1.db
    .prepare(
      `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'customer', 1, ?, ?)`
    )
    .run("tenant-a", "Alpha", "alpha", now, now);
  d1.db
    .prepare(
      `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'customer', 1, ?, ?)`
    )
    .run("tenant-b", "Beta", "beta", now, now);
  if (options.localAiEnabled !== false) {
    d1.db
      .prepare("UPDATE cloud_tenant_settings SET local_ai_enabled = 1 WHERE tenant_id IN (?, ?)")
      .run("tenant-a", "tenant-b");
  }

  const sessions = new TestDurableObjectNamespace();
  const runtime = createCloudRuntime({
    env: {
      DB: d1,
      OMNIROUTE_CLOUD_ADMIN_TOKEN: "test-admin-token",
      GATEWAY_SESSIONS: sessions,
    },
    now: () => new Date(options.currentClock ? Date.now() : now),
    customerInvokeRateLimit: options.customerInvokeRateLimit,
    customerAuthFailureRateLimit: options.customerAuthFailureRateLimit,
    customerAuthFailureFallbackRateLimit: options.customerAuthFailureFallbackRateLimit,
    gatewayConnectRateLimit: options.gatewayConnectRateLimit,
    gatewayConnectFallbackRateLimit: options.gatewayConnectFallbackRateLimit,
    gatewayDeviceRateLimits: options.gatewayDeviceRateLimits,
    gatewayPairingIssueRateLimit: options.gatewayPairingIssueRateLimit,
    gatewayPairingExchangeRateLimit: options.gatewayPairingExchangeRateLimit,
    gatewayRequestBodyTimeoutMs: options.gatewayRequestBodyTimeoutMs,
  });
  const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(input instanceof Request ? input : new Request(input, init));
  return { d1, runtime, sessions, fetch, now };
}

async function customerKey(
  fixture: ReturnType<typeof createRuntimeFixture>,
  tenantId: string,
  role: "owner" | "admin" | "member" | "viewer",
  principalId = `${tenantId}-${role}`
) {
  const membership = await createCloudCustomerMembership(fixture.d1, {
    tenantId,
    principalId,
    role,
    now: fixture.now,
  });
  return issueCloudCustomerApiKey(fixture.d1, {
    tenantId,
    membershipId: membership.id,
    now: fixture.now,
  });
}

function pairingIssueRequest(token: string): Request {
  return new Request("https://cloud.example.test/__gateway/v1/customer/local-agent/pairings", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
}

test("customer owner can pair a Local Agent once; code and device stay tenant-bound", async () => {
  const fixture = createRuntimeFixture();
  const home = mkdtempSync(join(tmpdir(), "omniroute-worker-agent-pair-"));
  try {
    const owner = await customerKey(fixture, "tenant-a", "owner");
    const issue = await fixture.fetch(pairingIssueRequest(owner.token));
    assert.equal(issue.status, 201);
    assert.equal(issue.headers.get("cache-control"), "no-store");
    const issued = (await issue.json()) as { pairingCode: string; expiresAt: string };
    assert.match(issued.pairingCode, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Date.parse(issued.expiresAt), Date.parse(fixture.now) + 5 * 60_000);
    const storedPairing = fixture.d1.db
      .prepare("SELECT code_hash, consumed_at FROM cloud_gateway_pairings WHERE tenant_id = ?")
      .get("tenant-a") as { code_hash: string; consumed_at: string | null };
    assert.equal(
      storedPairing.code_hash,
      createHash("sha256").update(issued.pairingCode).digest("hex")
    );
    assert.equal(storedPairing.consumed_at, null);
    assert.notEqual(storedPairing.code_hash, issued.pairingCode);

    fixture.d1.db.exec(`CREATE TRIGGER fail_pair_exchange_audit
      BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action = 'gateway.device.pair.exchange'
      BEGIN SELECT RAISE(ABORT, 'pair audit unavailable'); END`);
    const failedAtomicExchange = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, pairingCode: issued.pairingCode }),
      })
    );
    assert.equal(failedAtomicExchange.status, 503);
    assert.equal(
      (
        fixture.d1.db
          .prepare("SELECT consumed_at FROM cloud_gateway_pairings WHERE code_hash = ?")
          .get(storedPairing.code_hash) as { consumed_at: string | null }
      ).consumed_at,
      null,
      "audit failure rolls back code consumption"
    );
    assert.equal(
      (
        fixture.d1.db
          .prepare(
            "SELECT COUNT(*) AS count FROM cloud_gateway_devices WHERE tenant_id = 'tenant-a'"
          )
          .get() as { count: number }
      ).count,
      0,
      "audit failure rolls back device creation"
    );
    fixture.d1.db.exec("DROP TRIGGER fail_pair_exchange_audit");
    let output = "";
    let exchangeCacheControl: string | null = null;
    const paired = await pairLocalAgentCommand(
      { gatewayUrl: "https://cloud.example.test" },
      {
        env: { HOME: home },
        home,
        readCode: async () => issued.pairingCode,
        stdout: { write: (value: string) => (output += value) },
        fetcher: async (input, init) => {
          const response = await fixture.fetch(input, init);
          exchangeCacheControl = response.headers.get("cache-control");
          return response;
        },
      }
    );
    assert.equal(exchangeCacheControl, "no-store");
    const codeBucketHash = createHash("sha256")
      .update(`gateway-device-pairing:code:${storedPairing.code_hash}`)
      .digest("hex");
    assert.equal(
      (
        fixture.d1.db
          .prepare("SELECT COUNT(*) AS count FROM cloud_rate_limits WHERE bucket_hash = ?")
          .get(codeBucketHash) as { count: number }
      ).count,
      1,
      "rate-limit storage uses the pairing code digest, never its raw value"
    );
    const rawCodeBucketHash = createHash("sha256")
      .update(`gateway-device-pairing:code:${issued.pairingCode}`)
      .digest("hex");
    assert.equal(
      (
        fixture.d1.db
          .prepare("SELECT COUNT(*) AS count FROM cloud_rate_limits WHERE bucket_hash = ?")
          .get(rawCodeBucketHash) as { count: number }
      ).count,
      0,
      "raw pairing code is absent from rate-limit bucket derivation"
    );
    assert.equal(output.includes(issued.pairingCode), false);
    const device = fixture.d1.db
      .prepare("SELECT tenant_id, credential_hash FROM cloud_gateway_devices WHERE id = ?")
      .get(paired.deviceId) as { tenant_id: string; credential_hash: string };
    assert.equal(device.tenant_id, "tenant-a");
    assert.equal(device.credential_hash.length, 64);
    assert.equal(statSync(paired.configPath).mode & 0o777, 0o600);

    const replay = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, pairingCode: issued.pairingCode }),
      })
    );
    assert.equal(replay.status, 401);
    assert.equal(replay.headers.get("cache-control"), "no-store");
    const foreignRead = await fixture.fetch(
      adminRequest(`/__cloud/v1/tenants/tenant-b/gateway-devices/${paired.deviceId}`, "GET")
    );
    assert.equal(foreignRead.status, 404);

    const audits = fixture.d1.db
      .prepare(
        `SELECT action, target, metadata_json FROM cloud_compliance_audit
          WHERE tenant_id = 'tenant-a' AND action LIKE 'gateway.device.pair.%' ORDER BY action`
      )
      .all() as Array<{ action: string; target: string; metadata_json: string }>;
    assert.deepEqual(
      audits.map((row) => row.action),
      ["gateway.device.pair.exchange", "gateway.device.pair.issue"]
    );
    assert.ok(audits.every((row) => row.target !== issued.pairingCode));
    assert.ok(
      audits.every((row) => JSON.parse(row.metadata_json).pairingHash === storedPairing.code_hash)
    );
    const deniedReplayAudit = fixture.d1.db
      .prepare(
        `SELECT target, metadata_json FROM cloud_compliance_audit
          WHERE tenant_id = 'tenant_shiryu_admin'
            AND action = 'gateway.device.pair.exchange' AND status = 'denied' LIMIT 1`
      )
      .get() as { target: string; metadata_json: string };
    assert.equal(deniedReplayAudit.target, storedPairing.code_hash);
    assert.equal(JSON.parse(deniedReplayAudit.metadata_json).pairingHash, storedPairing.code_hash);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("tenant local-AI opt-in gates pairing and invocation and invalidates outstanding pairing grants", async () => {
  const disabledFixture = createRuntimeFixture({ localAiEnabled: false });
  try {
    const owner = await customerKey(disabledFixture, "tenant-a", "owner");
    assert.equal((await disabledFixture.fetch(pairingIssueRequest(owner.token))).status, 403);
    const invocation = await disabledFixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/customer/invoke", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    );
    assert.equal(invocation.status, 403);
  } finally {
    disabledFixture.d1.db.close();
  }

  const revocationFixture = createRuntimeFixture();
  try {
    const owner = await customerKey(revocationFixture, "tenant-a", "owner");
    const issued = await revocationFixture.fetch(pairingIssueRequest(owner.token));
    assert.equal(issued.status, 201);
    const { pairingCode } = (await issued.json()) as { pairingCode: string };
    revocationFixture.d1.db
      .prepare("UPDATE cloud_tenant_settings SET local_ai_enabled = 0 WHERE tenant_id = ?")
      .run("tenant-a");
    const exchange = await revocationFixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, pairingCode }),
      })
    );
    assert.notEqual(exchange.status, 200);
    assert.equal(
      (
        revocationFixture.d1.db
          .prepare("SELECT COUNT(*) AS count FROM cloud_gateway_devices WHERE tenant_id = ?")
          .get("tenant-a") as { count: number }
      ).count,
      0
    );
  } finally {
    revocationFixture.d1.db.close();
  }
});

test("Local AI opt-out blocks reconnects and revokes active sessions before re-enabling", async () => {
  const fixture = createRuntimeFixture();
  try {
    const owner = await customerKey(fixture, "tenant-a", "owner");
    const pairing = await fixture.fetch(pairingIssueRequest(owner.token));
    const { pairingCode } = (await pairing.json()) as { pairingCode: string };
    const exchange = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, pairingCode }),
      })
    );
    assert.equal(exchange.status, 201);
    const paired = (await exchange.json()) as { deviceId: string; credential: string };
    const connect = async () =>
      fixture.fetch(
        new Request("https://cloud.example.test/__gateway/v1/device/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: 1, ...paired }),
        })
      );
    const connected = await connect();
    assert.equal(connected.status, 200);
    const { session } = (await connected.json()) as {
      session: { sessionToken: string };
    };
    const settingsRequest = (localAiEnabled: boolean) =>
      fixture.fetch(
        new Request("https://cloud.example.test/__cloud/v1/customer/settings", {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${owner.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ localAiEnabled, mcpEnabled: false }),
        })
      );
    assert.equal((await settingsRequest(false)).status, 200);
    assert.equal((await connect()).status, 401);

    const poll = () =>
      fixture.fetch(
        new Request("https://cloud.example.test/__gateway/v1/device/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: 1,
            deviceId: paired.deviceId,
            sessionToken: session.sessionToken,
          }),
        })
      );
    assert.equal((await poll()).status, 401);
    assert.equal((await settingsRequest(true)).status, 200);
    assert.equal((await poll()).status, 401, "a revoked pre-opt-out session must not return");
    assert.equal(
      (await connect()).status,
      200,
      "the device can reconnect with its active credential"
    );
  } finally {
    fixture.d1.db.close();
  }
});

test("Local Agent pairing denies member/viewer roles and rate-limits owners", async () => {
  const fixture = createRuntimeFixture({
    gatewayPairingIssueRateLimit: { limit: 1, windowMs: 60_000 },
  });
  const member = await customerKey(fixture, "tenant-a", "member");
  const viewer = await customerKey(fixture, "tenant-b", "viewer");
  const admin = await customerKey(fixture, "tenant-b", "admin");
  assert.equal((await fixture.fetch(pairingIssueRequest(member.token))).status, 403);
  assert.equal((await fixture.fetch(pairingIssueRequest(viewer.token))).status, 403);
  assert.equal((await fixture.fetch(pairingIssueRequest(admin.token))).status, 201);
  const owner = await customerKey(fixture, "tenant-a", "owner");
  assert.equal((await fixture.fetch(pairingIssueRequest(owner.token))).status, 201);
  assert.equal((await fixture.fetch(pairingIssueRequest(owner.token))).status, 429);
});

test("expired Local Agent pairing grants are deleted in a bounded cleanup", async () => {
  const fixture = createRuntimeFixture();
  try {
    const owner = await customerKey(fixture, "tenant-a", "owner");
    const issue = await fixture.fetch(pairingIssueRequest(owner.token));
    const pairing = (await issue.json()) as { pairingCode: string };
    const codeHash = createHash("sha256").update(pairing.pairingCode).digest("hex");
    fixture.d1.db
      .prepare("UPDATE cloud_gateway_pairings SET expires_at = ? WHERE code_hash = ?")
      .run("2026-10-08T11:59:00.000Z", codeHash);
    assert.equal(
      await cleanupExpiredCloudGatewayPairings(fixture.d1, {
        now: "2026-10-08T12:00:00.000Z",
        batchSize: 1,
      }),
      1
    );
    assert.equal(
      (
        fixture.d1.db
          .prepare("SELECT COUNT(*) AS count FROM cloud_gateway_pairings WHERE code_hash = ?")
          .get(codeHash) as { count: number }
      ).count,
      0
    );
  } finally {
    fixture.d1.db.close();
  }
});

function invokeRequest(
  token: string,
  body: unknown,
  idempotencyKey: string = randomUUID()
): Request {
  return new Request("https://cloud.example.test/__gateway/v1/customer/invoke", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function registerOnlineDevice(
  fixture: ReturnType<typeof createRuntimeFixture>,
  tenantId: string,
  id: string,
  capabilities = ["ollama:chat:qwen-local"]
) {
  const credential = `agent-${id}-credential`.padEnd(43, "x");
  const registered = await fixture.fetch(
    adminRequest(`/__cloud/v1/tenants/${tenantId}/gateway-devices`, "POST", {
      id,
      credentialHash: createHash("sha256").update(credential).digest("hex"),
      capabilities,
    })
  );
  assert.equal(registered.status, 201);
  const transport = createHttpLocalAgentGatewayTransport("https://cloud.example.test", {
    fetch: fixture.fetch,
  });
  const session = await transport.connect(id, credential);
  assert.ok(session);
  assert.equal(await transport.heartbeat(session, capabilities), true);
  return { transport, session };
}

function adminRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`https://cloud.example.test${path}`, {
    method,
    headers: {
      Authorization: "Bearer test-admin-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("D1 device registration and Worker v1 connect/heartbeat/poll/result stay device-tenant bound", async () => {
  const fixture = createRuntimeFixture();
  try {
    const credential = "agent-credential-".padEnd(43, "x");
    const credentialHash = createHash("sha256").update(credential).digest("hex");
    const registration = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices", "POST", {
        id: "device-a",
        credentialHash,
        capabilities: [],
      })
    );
    assert.equal(registration.status, 201);
    const registered = (await registration.json()) as Record<string, unknown>;
    assert.equal(registered.tenantId, "tenant-a");
    assert.equal("credentialHash" in registered, false);
    const legacyDeviceRead = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices/device-a", "GET")
    );
    assert.equal(legacyDeviceRead.status, 200);
    assert.equal(
      ((await legacyDeviceRead.json()) as Record<string, unknown>).serviceHealth,
      null,
      "legacy devices without a health heartbeat remain readable as unknown"
    );

    const gatewayUrl = "https://cloud.example.test";
    const transport = createHttpLocalAgentGatewayTransport(gatewayUrl, { fetch: fixture.fetch });
    const session = await transport.connect("device-a", credential);
    assert.ok(session);
    assert.equal(session.tenantId, "tenant-a");

    const malformedHeartbeat = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          deviceId: session.deviceId,
          sessionToken: session.sessionToken,
          capabilities: [],
          serviceHealth: { ollama: true, comfyui: false, endpoint: "http://127.0.0.1" },
        }),
      })
    );
    assert.equal(malformedHeartbeat.status, 400);

    assert.equal(
      await transport.heartbeat(session, ["ollama:chat:qwen-local"], {
        ollama: true,
        comfyui: false,
      }),
      true
    );
    const stored = fixture.d1.db
      .prepare(
        "SELECT tenant_id, status, capabilities_json, service_health_json, last_seen_at FROM cloud_gateway_devices WHERE id = ?"
      )
      .get("device-a") as
      | {
          tenant_id: string;
          status: string;
          capabilities_json: string;
          service_health_json: string | null;
          last_seen_at: string;
        }
      | undefined;
    assert.equal(stored?.tenant_id, "tenant-a");
    assert.equal(stored?.status, "online");
    assert.deepEqual(JSON.parse(stored?.capabilities_json ?? "[]"), ["ollama:chat:qwen-local"]);
    assert.deepEqual(JSON.parse(stored?.service_health_json ?? "null"), {
      ollama: true,
      comfyui: false,
    });
    assert.equal(stored?.last_seen_at, fixture.now);

    const deviceRead = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices/device-a", "GET")
    );
    assert.equal(deviceRead.status, 200);
    const deviceBody = (await deviceRead.json()) as Record<string, unknown>;
    assert.deepEqual(deviceBody.serviceHealth, { ollama: true, comfyui: false });
    assert.equal("credentialHash" in deviceBody, false);
    assert.equal("credential_hash" in deviceBody, false);
    assert.equal(
      await transport.heartbeat(session, ["ollama:chat:qwen-local"]),
      true,
      "legacy heartbeats may omit the optional service health field"
    );
    const legacyHeartbeatRead = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices/device-a", "GET")
    );
    assert.equal(
      ((await legacyHeartbeatRead.json()) as Record<string, unknown>).serviceHealth,
      null,
      "omitting service health clears the prior observation instead of refreshing stale data"
    );
    const crossTenantRead = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-b/gateway-devices/device-a", "GET")
    );
    assert.equal(crossTenantRead.status, 404);

    const coordinator = fixture.sessions.get("device-a");
    const requestId = "queued-request-1";
    assert.equal(
      await coordinator.enqueueRequest("device-a", {
        requestId,
        tenantId: session.tenantId,
        sessionId: session.sessionId,
        capability: "ollama:chat:qwen-local",
        payload: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
        createdAt: fixture.now,
        expiresAt: "2026-10-08T12:00:20.000Z",
        status: "pending",
      }),
      true
    );
    const requests = await transport.poll(session);
    assert.equal(requests?.length, 1);
    assert.deepEqual(requests?.[0], {
      requestId,
      capability: "ollama:chat:qwen-local",
      payload: { messages: [{ role: "user", content: "hello" }] },
      expiresAt: "2026-10-08T12:00:20.000Z",
      deliveryAttempt: 1,
    });
    assert.equal(
      await transport.submitResult(session, {
        version: 1,
        requestId,
        deliveryAttempt: 1,
        outcome: { ok: true, value: { message: { role: "assistant", content: "hi" } } },
      }),
      true
    );
    const completed = await coordinator.getRequest("device-a", requestId, fixture.now);
    assert.equal(completed?.status, "complete");
  } finally {
    fixture.d1.db.close();
  }
});

test("customer stream invocation emits ordered SSE, applies one-event backpressure, and conflicts on replay", async () => {
  const fixture = createRuntimeFixture();
  try {
    const key = await customerKey(fixture, "tenant-a", "owner");
    const { transport, session } = await registerOnlineDevice(fixture, "tenant-a", "device-stream");
    const idempotencyKey = "stream-idempotency-key-01";
    const response = await fixture.fetch(
      invokeRequest(
        key.token,
        {
          deviceId: "device-stream",
          capability: "ollama:chat:qwen-local",
          payload: { messages: [{ role: "user", content: "hello" }] },
          timeoutMs: 5_000,
          stream: true,
        },
        idempotencyKey
      )
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    const queued = await transport.poll(session!);
    assert.equal(queued?.length, 1);
    assert.equal((queued?.[0] as (typeof queued)[0] & { stream?: boolean })?.stream, true);

    async function submit(sequence: number, event: unknown): Promise<Response> {
      return fixture.fetch(
        new Request("https://cloud.example.test/__gateway/v1/device/stream-event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            deviceId: session!.deviceId,
            sessionToken: session!.sessionToken,
            requestId: queued![0]!.requestId,
            sequence,
            event,
          }),
        })
      );
    }

    const reader = response.body!.getReader();
    const deltaPost = submit(0, { type: "delta", data: { content: "hello" } });
    const delta = await reader.read();
    assert.equal(
      new TextDecoder().decode(delta.value),
      'data: {"sequence":0,"type":"delta","data":{"content":"hello"}}\n\n'
    );
    assert.equal(
      (await deltaPost).status,
      200,
      "device event is acknowledged only after the SSE consumer pulls it"
    );

    const usagePost = submit(1, { type: "usage", data: { promptTokens: 2, completionTokens: 1 } });
    const usage = await reader.read();
    assert.match(new TextDecoder().decode(usage.value), /"sequence":1,"type":"usage"/);
    assert.equal((await usagePost).status, 200);

    const donePost = submit(2, { type: "done", data: {} });
    const done = await reader.read();
    assert.match(new TextDecoder().decode(done.value), /"sequence":2,"type":"done"/);
    assert.equal((await donePost).status, 200);
    assert.equal((await reader.read()).done, true);

    const replay = await fixture.fetch(
      invokeRequest(
        key.token,
        {
          deviceId: "device-stream",
          capability: "ollama:chat:qwen-local",
          payload: { messages: [{ role: "user", content: "hello" }] },
          timeoutMs: 5_000,
          stream: true,
        },
        idempotencyKey
      )
    );
    assert.equal(replay.status, 409);
    assert.deepEqual(await replay.json(), { error: "Streaming invocations cannot be replayed" });
    assert.equal((await transport.poll(session!))?.length, 0, "replay never re-enqueues a stream");
    const auditRows = fixture.d1.db
      .prepare(
        "SELECT status FROM cloud_compliance_audit WHERE tenant_id = 'tenant-a' AND action = 'gateway.customer.invoke' ORDER BY rowid"
      )
      .all() as Array<{ status: string }>;
    assert.deepEqual(
      auditRows.map((row) => row.status),
      ["attempted", "success"]
    );
    const usageRows = fixture.d1.db
      .prepare(
        "SELECT provider, model, api_key_id, tokens_input, tokens_output, service_tier, status FROM cloud_usage_history WHERE tenant_id = 'tenant-a'"
      )
      .all() as Array<{
      provider: string;
      model: string;
      api_key_id: string;
      tokens_input: number;
      tokens_output: number;
      service_tier: string;
      status: string;
    }>;
    assert.deepEqual(
      usageRows.map((row) => ({ ...row })),
      [
        {
          provider: "ollama",
          model: "qwen-local",
          api_key_id: key.id,
          tokens_input: 2,
          tokens_output: 1,
          service_tier: "customer-managed",
          status: "success",
        },
      ]
    );
  } finally {
    fixture.d1.db.close();
  }
});

test("stream read timeout emits a safe terminal event and records a final unavailable audit", async () => {
  const fixture = createRuntimeFixture({ currentClock: true });
  try {
    const key = await customerKey(fixture, "tenant-a", "owner");
    const { transport, session } = await registerOnlineDevice(
      fixture,
      "tenant-a",
      "device-timeout"
    );
    const response = await fixture.fetch(
      invokeRequest(
        key.token,
        {
          deviceId: "device-timeout",
          capability: "ollama:chat:qwen-local",
          payload: { messages: [{ role: "user", content: "hello" }] },
          timeoutMs: 200,
          stream: true,
        },
        "stream-read-timeout-key-1"
      )
    );
    assert.equal(response.status, 200);
    await transport.poll(session!);
    const reader = response.body!.getReader();
    const timeoutFrame = await reader.read();
    assert.match(new TextDecoder().decode(timeoutFrame.value), /"type":"error"/);
    assert.equal((await reader.read()).done, true);
    const audits = fixture.d1.db
      .prepare(
        "SELECT status FROM cloud_compliance_audit WHERE tenant_id = 'tenant-a' AND action = 'gateway.customer.invoke' ORDER BY rowid"
      )
      .all() as Array<{ status: string }>;
    assert.deepEqual(
      audits.map((row) => row.status),
      ["attempted", "unavailable"]
    );
  } finally {
    fixture.d1.db.close();
  }
});

test("stream acknowledgment failure emits a sequenced error and records unavailable audit", async () => {
  const fixture = createRuntimeFixture();
  try {
    const key = await customerKey(fixture, "tenant-a", "owner");
    const { transport, session } = await registerOnlineDevice(
      fixture,
      "tenant-a",
      "device-ack-failure"
    );
    const response = await fixture.fetch(
      invokeRequest(
        key.token,
        {
          deviceId: "device-ack-failure",
          capability: "ollama:chat:qwen-local",
          payload: { messages: [{ role: "user", content: "hello" }] },
          timeoutMs: 5_000,
          stream: true,
        },
        "stream-ack-failure-key-1"
      )
    );
    const request = (await transport.poll(session!))![0]!;
    const coordinator = fixture.sessions.get(session!.deviceId);
    coordinator.acknowledgeStreamEvent = async () => false;
    const eventPost = fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/stream-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          deviceId: session!.deviceId,
          sessionToken: session!.sessionToken,
          requestId: request.requestId,
          sequence: 0,
          event: { type: "delta", data: { content: "partial" } },
        }),
      })
    );
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"delta"/);
    assert.equal((await eventPost).status, 409, "failed acknowledgment tells the device to stop");
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      'data: {"sequence":1,"type":"error","data":{"code":"capability_execution_failed"}}\n\n'
    );
    assert.equal((await reader.read()).done, true);
    const audits = fixture.d1.db
      .prepare(
        "SELECT status FROM cloud_compliance_audit WHERE tenant_id = 'tenant-a' AND action = 'gateway.customer.invoke' ORDER BY rowid"
      )
      .all() as Array<{ status: string }>;
    assert.deepEqual(
      audits.map((row) => row.status),
      ["attempted", "unavailable"]
    );
  } finally {
    fixture.d1.db.close();
  }
});

test("stream usage is recorded only after a successful done event", async () => {
  const fixture = createRuntimeFixture();
  try {
    const key = await customerKey(fixture, "tenant-a", "owner");
    const { transport, session } = await registerOnlineDevice(
      fixture,
      "tenant-a",
      "device-error-after-usage"
    );
    const response = await fixture.fetch(
      invokeRequest(
        key.token,
        {
          deviceId: "device-error-after-usage",
          capability: "ollama:chat:qwen-local",
          payload: { messages: [{ role: "user", content: "hello" }] },
          timeoutMs: 5_000,
          stream: true,
        },
        "stream-usage-before-error-1"
      )
    );
    const request = (await transport.poll(session!))![0]!;
    const reader = response.body!.getReader();
    const postEvent = (sequence: number, event: unknown) =>
      fixture.fetch(
        new Request("https://cloud.example.test/__gateway/v1/device/stream-event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            deviceId: session!.deviceId,
            sessionToken: session!.sessionToken,
            requestId: request.requestId,
            sequence,
            event,
          }),
        })
      );
    const usagePost = postEvent(0, {
      type: "usage",
      data: { promptTokens: 3, completionTokens: 4 },
    });
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"usage"/);
    assert.equal((await usagePost).status, 200);
    const errorPost = postEvent(1, {
      type: "error",
      data: { code: "capability_execution_failed" },
    });
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"error"/);
    assert.equal((await errorPost).status, 200);
    assert.equal((await reader.read()).done, true);
    assert.equal(
      (
        fixture.d1.db
          .prepare("SELECT COUNT(*) AS count FROM cloud_usage_history WHERE tenant_id = 'tenant-a'")
          .get() as { count: number }
      ).count,
      0,
      "a usage event from an incomplete stream must not be recorded as a successful invocation"
    );
  } finally {
    fixture.d1.db.close();
  }
});

test("stream usage write failure emits error instead of presenting done", async () => {
  const fixture = createRuntimeFixture();
  try {
    const key = await customerKey(fixture, "tenant-a", "owner");
    const { transport, session } = await registerOnlineDevice(
      fixture,
      "tenant-a",
      "device-usage-write-failure"
    );
    const response = await fixture.fetch(
      invokeRequest(
        key.token,
        {
          deviceId: "device-usage-write-failure",
          capability: "ollama:chat:qwen-local",
          payload: { messages: [{ role: "user", content: "hello" }] },
          timeoutMs: 5_000,
          stream: true,
        },
        "stream-usage-write-failure-key-1"
      )
    );
    const request = (await transport.poll(session!))![0]!;
    fixture.d1.db.exec(
      `CREATE TRIGGER reject_cloud_usage BEFORE INSERT ON cloud_usage_history
       BEGIN SELECT RAISE(FAIL, 'usage insert rejected'); END;`
    );
    const postEvent = (sequence: number, event: unknown) =>
      fixture.fetch(
        new Request("https://cloud.example.test/__gateway/v1/device/stream-event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            deviceId: session!.deviceId,
            sessionToken: session!.sessionToken,
            requestId: request.requestId,
            sequence,
            event,
          }),
        })
      );
    const reader = response.body!.getReader();
    const usagePost = postEvent(0, {
      type: "usage",
      data: { promptTokens: 3, completionTokens: 4 },
    });
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"usage"/);
    assert.equal((await usagePost).status, 200);
    const donePost = postEvent(1, { type: "done", data: {} });
    const terminal = new TextDecoder().decode((await reader.read()).value);
    assert.equal(
      terminal,
      'data: {"sequence":1,"type":"error","data":{"code":"capability_execution_failed"}}\n\n'
    );
    assert.equal((await donePost).status, 409, "accounting failure cancels the device stream");
    assert.equal((await reader.read()).done, true);
    assert.equal(
      (
        fixture.d1.db
          .prepare("SELECT COUNT(*) AS count FROM cloud_usage_history WHERE tenant_id = 'tenant-a'")
          .get() as { count: number }
      ).count,
      0
    );
    const audits = fixture.d1.db
      .prepare(
        "SELECT status FROM cloud_compliance_audit WHERE tenant_id = 'tenant-a' AND action = 'gateway.customer.invoke' ORDER BY rowid"
      )
      .all() as Array<{ status: string }>;
    assert.deepEqual(
      audits.map((row) => row.status),
      ["attempted", "unavailable"]
    );
  } finally {
    fixture.d1.db.close();
  }
});

test("stream event endpoint enforces event bounds, authenticated session, and request cancellation", async () => {
  const fixture = createRuntimeFixture();
  try {
    const key = await customerKey(fixture, "tenant-a", "owner");
    const { transport, session } = await registerOnlineDevice(fixture, "tenant-a", "device-cancel");
    const response = await fixture.fetch(
      invokeRequest(
        key.token,
        {
          deviceId: "device-cancel",
          capability: "ollama:chat:qwen-local",
          payload: { messages: [{ role: "user", content: "hello" }] },
          timeoutMs: 5_000,
          stream: true,
        },
        "stream-cancellation-key-1"
      )
    );
    const request = (await transport.poll(session!))![0]!;
    const oversized = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/stream-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          deviceId: session!.deviceId,
          sessionToken: session!.sessionToken,
          requestId: request.requestId,
          sequence: 0,
          event: { type: "delta", data: { content: "x".repeat(9 * 1024) } },
        }),
      })
    );
    assert.equal(oversized.status, 413);

    const reader = response.body!.getReader();
    const pending = fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/stream-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          deviceId: session!.deviceId,
          sessionToken: session!.sessionToken,
          requestId: request.requestId,
          sequence: 0,
          event: { type: "delta", data: { content: "wait" } },
        }),
      })
    );
    await reader.cancel();
    assert.equal((await pending).status, 409, "client disconnect cancels an unconsumed event");
    const canceledAudit = fixture.d1.db
      .prepare(
        "SELECT status FROM cloud_compliance_audit WHERE tenant_id = 'tenant-a' AND action = 'gateway.customer.invoke' ORDER BY rowid"
      )
      .all() as Array<{ status: string }>;
    assert.deepEqual(
      canceledAudit.map((row) => row.status),
      ["attempted", "cancelled"]
    );
    const stale = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/stream-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          deviceId: session!.deviceId,
          sessionToken: "z".repeat(43),
          requestId: request.requestId,
          sequence: 0,
          event: { type: "delta", data: { content: "late" } },
        }),
      })
    );
    assert.equal(stale.status, 401);
  } finally {
    fixture.d1.db.close();
  }
});

test("Worker device requests reject tenant overrides, cross-device credentials, and revoked sessions", async () => {
  const fixture = createRuntimeFixture();
  try {
    const credentialA = "agent-a-credential-".padEnd(43, "a");
    const credentialB = "agent-b-credential-".padEnd(43, "b");
    for (const [tenantId, id, credential] of [
      ["tenant-a", "device-a", credentialA],
      ["tenant-b", "device-b", credentialB],
    ]) {
      const response = await fixture.fetch(
        adminRequest(`/__cloud/v1/tenants/${tenantId}/gateway-devices`, "POST", {
          id,
          credentialHash: createHash("sha256").update(credential).digest("hex"),
          capabilities: [],
        })
      );
      assert.equal(response.status, 201);
    }

    const tenantOverride = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices", "POST", {
        id: "foreign-device",
        credentialHash: createHash("sha256").update(credentialA).digest("hex"),
        capabilities: [],
        tenantId: "tenant-b",
      })
    );
    assert.equal(tenantOverride.status, 400);

    const transport = createHttpLocalAgentGatewayTransport("https://cloud.example.test", {
      fetch: fixture.fetch,
    });
    assert.equal(await transport.connect("device-b", credentialA), null);
    const session = await transport.connect("device-a", credentialA);
    assert.ok(session);
    assert.equal(session.tenantId, "tenant-a");
    assert.equal(await transport.heartbeat(session, ["ollama:chat:qwen-local"]), true);

    const overrideRequest = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          deviceId: session.deviceId,
          sessionToken: session.sessionToken,
          tenantId: "tenant-b",
        }),
      })
    );
    assert.equal(overrideRequest.status, 400);

    const foreignRequestRoute = await fixture.fetch(
      new Request(
        "https://cloud.example.test/__gateway/v1/tenants/tenant-a/devices/device-a/request",
        {
          method: "POST",
        }
      )
    );
    assert.equal(foreignRequestRoute.status, 404);

    const revoked = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices/device-a", "DELETE")
    );
    assert.equal(revoked.status, 200);
    assert.equal(await transport.heartbeat(session, []), false);
  } finally {
    fixture.d1.db.close();
  }
});

test("platform admin can suspend and resume a customer while invalidating prior device sessions", async () => {
  const fixture = createRuntimeFixture();
  try {
    const credential = "agent-a-credential-".padEnd(43, "a");
    const registration = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices", "POST", {
        id: "device-lifecycle",
        credentialHash: createHash("sha256").update(credential).digest("hex"),
        capabilities: [],
      })
    );
    assert.equal(registration.status, 201);
    const transport = createHttpLocalAgentGatewayTransport("https://cloud.example.test", {
      fetch: fixture.fetch,
    });
    const session = await transport.connect("device-lifecycle", credential);
    assert.ok(session);

    const suspended = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/status", "POST", { status: "suspended" })
    );
    assert.equal(suspended.status, 200);
    assert.equal(((await suspended.json()) as { isActive: boolean }).isActive, false);
    assert.equal(await transport.heartbeat(session, []), false);
    assert.equal(
      (await fixture.fetch(adminRequest("/__cloud/v1/tenants/tenant-a", "GET"))).status,
      404
    );
    const suspendedStatus = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/status", "GET")
    );
    assert.equal(suspendedStatus.status, 200);
    assert.equal(((await suspendedStatus.json()) as { isActive: boolean }).isActive, false);

    const resumed = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/status", "POST", { status: "active" })
    );
    assert.equal(resumed.status, 200);
    assert.equal(((await resumed.json()) as { isActive: boolean }).isActive, true);
    assert.equal(await transport.heartbeat(session, []), false);

    const audit = fixture.d1.db
      .prepare(
        `SELECT tenant_id, target, status FROM cloud_compliance_audit
          WHERE action = 'tenant.lifecycle.status' ORDER BY rowid`
      )
      .all() as Array<{ tenant_id: string; target: string; status: string }>;
    assert.equal(audit.length, 4);
    assert.ok(audit.every((entry) => entry.tenant_id === "tenant_shiryu_admin"));
    assert.ok(audit.every((entry) => entry.target === "tenant-a"));
    assert.deepEqual(
      audit.map((entry) => entry.status),
      ["attempted", "success", "attempted", "success"]
    );
  } finally {
    fixture.d1.db.close();
  }
});

test("platform admin can rotate only a tenant-owned gateway credential and kills its old session", async () => {
  const fixture = createRuntimeFixture();
  try {
    const oldCredential = "agent-old-credential-".padEnd(43, "o");
    const newCredential = "agent-new-credential-".padEnd(43, "n");
    const registration = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices", "POST", {
        id: "device-rotate",
        credentialHash: createHash("sha256").update(oldCredential).digest("hex"),
        capabilities: [],
      })
    );
    assert.equal(registration.status, 201);
    const transport = createHttpLocalAgentGatewayTransport("https://cloud.example.test", {
      fetch: fixture.fetch,
    });
    const oldSession = await transport.connect("device-rotate", oldCredential);
    assert.ok(oldSession);

    const rotated = await fixture.fetch(
      adminRequest(
        "/__cloud/v1/tenants/tenant-a/gateway-devices/device-rotate/rotate-credential",
        "POST",
        { credentialHash: createHash("sha256").update(newCredential).digest("hex") }
      )
    );
    assert.equal(rotated.status, 200);
    assert.deepEqual(await rotated.json(), { rotated: true });
    assert.equal(await transport.heartbeat(oldSession, []), false);
    assert.equal(await transport.connect("device-rotate", oldCredential), null);
    const newSession = await transport.connect("device-rotate", newCredential);
    assert.ok(newSession);

    const crossTenant = await fixture.fetch(
      adminRequest(
        "/__cloud/v1/tenants/tenant-b/gateway-devices/device-rotate/rotate-credential",
        "POST",
        { credentialHash: createHash("sha256").update("unrelated-new-credential").digest("hex") }
      )
    );
    assert.equal(crossTenant.status, 404);
    assert.equal(await transport.heartbeat(newSession, []), true);
  } finally {
    fixture.d1.db.close();
  }
});

test("HTTP Local Agent transport rejects non-HTTPS remote gateway URLs and oversized envelopes", async () => {
  assert.throws(
    () =>
      createHttpLocalAgentGatewayTransport("http://gateway.example.test", {
        fetch: async () => Response.json({}),
      }),
    /must use HTTPS/
  );
  const transport = createHttpLocalAgentGatewayTransport("http://localhost:8787", {
    fetch: async () => Response.json({}),
  });
  await assert.rejects(
    transport.submitResult(
      {
        sessionId: "session",
        deviceId: "device",
        tenantId: "tenant",
        sessionToken: "a".repeat(43),
        leaseExpiresAt: "2026-10-08T12:01:00Z",
      },
      {
        version: 1,
        requestId: "request",
        outcome: { ok: true, value: "x".repeat(90_000) },
      }
    ),
    /exceeds the size limit/
  );
});

test("HTTP Local Agent transport cancels oversized gateway responses while reading", async () => {
  const oversizedChunk = new Uint8Array(512 * 1024 + 1);
  const scenarios = [
    { name: "without Content-Length", headers: {} },
    { name: "with an understated Content-Length", headers: { "content-length": "1" } },
  ];

  for (const scenario of scenarios) {
    let cancelled = false;
    const transport = createHttpLocalAgentGatewayTransport("https://gateway.example.test", {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(oversizedChunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: scenario.headers }
        ),
    });

    await assert.rejects(
      transport.connect("device", "c".repeat(43)),
      /response exceeds the size limit/,
      scenario.name
    );
    assert.equal(cancelled, true, `${scenario.name} response stream should be cancelled`);
  }
});

test("HTTP Local Agent transport cancels a response rejected by Content-Length", async () => {
  let cancelled = false;
  const transport = createHttpLocalAgentGatewayTransport("https://gateway.example.test", {
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([123]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": String(512 * 1024 + 1) } }
      ),
  });

  await assert.rejects(
    transport.connect("device", "c".repeat(43)),
    /response exceeds the size limit/
  );
  assert.equal(cancelled, true, "advertised oversized response stream should be cancelled");
});

test("stream event transport uses the longer acknowledgment deadline for slow readers", async () => {
  const transport = createHttpLocalAgentGatewayTransport("https://gateway.example.test", {
    requestTimeoutMs: 100,
    streamEventTimeoutMs: 500,
    fetch: async (input) => {
      assert.match(String(input), /\/__gateway\/v1\/device\/stream-event$/);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return Response.json({ version: 1, accepted: true });
    },
  });
  const accepted = await transport.submitStreamEvent(
    {
      sessionId: "session",
      deviceId: "device",
      tenantId: "tenant",
      sessionToken: "a".repeat(43),
      leaseExpiresAt: "2026-10-08T12:01:00Z",
    },
    "request",
    0,
    { type: "delta", data: { content: "hello" } }
  );
  assert.equal(accepted, true);
});

test("Worker rejects an oversized body without relying on Content-Length", async () => {
  const fixture = createRuntimeFixture();
  try {
    const request = new Request("https://cloud.example.test/__gateway/v1/device/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, deviceId: "device-a", credential: "x".repeat(90_000) }),
    });
    assert.equal(request.headers.get("content-length"), null);
    const response = await fixture.fetch(request);
    assert.equal(response.status, 400);
  } finally {
    fixture.d1.db.close();
  }
});

test("Worker cancels a stalled gateway request body after the configured read timeout", async () => {
  const fixture = createRuntimeFixture({ gatewayRequestBodyTimeoutMs: 5 });
  let cancelled = false;
  try {
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true;
      },
    });
    const response = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" })
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid or oversized JSON body" });
    assert.equal(cancelled, true);
  } finally {
    fixture.d1.db.close();
  }
});

test("Worker cancels a stalled customer gateway body after the default read timeout", async () => {
  const fixture = createRuntimeFixture();
  let cancelled = false;
  try {
    const owner = await customerKey(fixture, "tenant-a", "owner");
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true;
      },
    });
    const response = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/customer/local-agent/pairings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" })
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Pairing request must be an empty JSON object",
    });
    assert.equal(cancelled, true);
  } finally {
    fixture.d1.db.close();
  }
});

test("connect rate limit rejects before reading another unauthenticated request body", async () => {
  const fixture = createRuntimeFixture({
    gatewayConnectFallbackRateLimit: { limit: 1, windowMs: 60_000 },
    gatewayRequestBodyTimeoutMs: 20,
  });
  try {
    const malformed = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    );
    assert.equal(malformed.status, 400);

    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
    });
    const limited = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" })
    );

    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "Device authentication rate limit exceeded" });
  } finally {
    fixture.d1.db.close();
  }
});

test("customer invocation derives tenant from its API key, completes through the DO, and audits without payloads", async () => {
  const fixture = createRuntimeFixture();
  try {
    const ownerA = await customerKey(fixture, "tenant-a", "owner");
    const ownerB = await customerKey(fixture, "tenant-b", "owner");
    const deviceA = await registerOnlineDevice(fixture, "tenant-a", "device-customer-a");
    const deviceB = await registerOnlineDevice(fixture, "tenant-b", "device-customer-b");

    const body = {
      deviceId: "device-customer-a",
      capability: "ollama:chat:qwen-local",
      payload: { prompt: "sensitive request content" },
      timeoutMs: 2_000,
    };
    const invocation = fixture.fetch(invokeRequest(ownerA.token, body));
    let requests: Awaited<ReturnType<typeof deviceA.transport.poll>> = null;
    for (let attempt = 0; attempt < 50 && !requests?.length; attempt += 1) {
      requests = await deviceA.transport.poll(deviceA.session);
      if (!requests?.length) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests?.length, 1);
    assert.equal(requests?.[0].capability, body.capability);
    assert.deepEqual(requests?.[0].payload, body.payload);
    assert.equal(
      await deviceA.transport.submitResult(deviceA.session, {
        version: 1,
        requestId: requests![0].requestId,
        deliveryAttempt: requests![0].deliveryAttempt,
        outcome: {
          ok: true,
          value: {
            message: { role: "assistant", content: "local result" },
            prompt_eval_count: 42,
            eval_count: 16,
          },
        },
      }),
      true
    );
    const response = await invocation;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      requestId: requests![0].requestId,
      result: {
        version: 1,
        outcome: {
          ok: true,
          value: {
            message: { role: "assistant", content: "local result" },
            prompt_eval_count: 42,
            eval_count: 16,
          },
        },
      },
    });

    const usage = fixture.d1.db
      .prepare(
        `SELECT tenant_id, provider, model, api_key_id, tokens_input, tokens_output, endpoint
           FROM cloud_usage_history WHERE tenant_id = 'tenant-a'`
      )
      .all() as Array<{
      tenant_id: string;
      provider: string;
      model: string;
      api_key_id: string;
      tokens_input: number;
      tokens_output: number;
      endpoint: string;
    }>;
    assert.deepEqual(JSON.parse(JSON.stringify(usage)), [
      {
        tenant_id: "tenant-a",
        provider: "ollama",
        model: "qwen-local",
        api_key_id: ownerA.id,
        tokens_input: 42,
        tokens_output: 16,
        endpoint: "/__gateway/v1/customer/invoke",
      },
    ]);

    const failedCapabilityInvocation = fixture.fetch(
      invokeRequest(ownerB.token, {
        ...body,
        deviceId: "device-customer-b",
        payload: { messages: [{ role: "user", content: "failed local execution" }] },
      })
    );
    let requestsB: Awaited<ReturnType<typeof deviceB.transport.poll>> = null;
    for (let attempt = 0; attempt < 50 && !requestsB?.length; attempt += 1) {
      requestsB = await deviceB.transport.poll(deviceB.session);
      if (!requestsB?.length) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requestsB?.length, 1);
    assert.equal(
      await deviceB.transport.submitResult(deviceB.session, {
        version: 1,
        requestId: requestsB![0].requestId,
        deliveryAttempt: requestsB![0].deliveryAttempt,
        outcome: { ok: false, error: { code: "capability_execution_failed" } },
      }),
      true
    );
    assert.equal((await failedCapabilityInvocation).status, 200);
    const usageB = fixture.d1.db
      .prepare("SELECT COUNT(*) AS count FROM cloud_usage_history WHERE tenant_id = 'tenant-b'")
      .get() as { count: number };
    assert.equal(usageB.count, 0, "failed local capability execution must not create usage");

    const crossTenant = await fixture.fetch(
      invokeRequest(ownerA.token, { ...body, deviceId: "device-customer-b" })
    );
    assert.equal(crossTenant.status, 404);
    const foreignTenantCanInvokeA = await fixture.fetch(
      invokeRequest(ownerB.token, { ...body, deviceId: "device-customer-a" })
    );
    assert.equal(foreignTenantCanInvokeA.status, 404);
    const override = await fixture.fetch(
      invokeRequest(ownerA.token, { ...body, tenantId: "tenant-b" })
    );
    assert.equal(override.status, 400);
    const unavailableCapability = await fixture.fetch(
      invokeRequest(ownerA.token, { ...body, capability: "comfyui:workflow:submit" })
    );
    assert.equal(unavailableCapability.status, 409);

    const audit = fixture.d1.db
      .prepare(
        `SELECT tenant_id, actor, target, action, status, metadata_json
           FROM cloud_compliance_audit WHERE action = 'gateway.customer.invoke' ORDER BY rowid`
      )
      .all() as Array<{
      tenant_id: string;
      actor: string;
      target: string;
      action: string;
      status: string;
      metadata_json: string;
    }>;
    assert.equal(audit.length, 10);
    assert.ok(audit.filter((entry) => entry.tenant_id === "tenant-a").length === 6);
    assert.ok(audit.every((entry) => !entry.metadata_json.includes("sensitive request content")));
    assert.ok(
      audit
        .filter((entry) => entry.tenant_id === "tenant-a")
        .every((entry) => entry.actor === "tenant-a-owner")
    );
  } finally {
    fixture.d1.db.close();
  }
});

test("customer invocation replays completed results only while its device remains active", async () => {
  const fixture = createRuntimeFixture();
  try {
    const owner = await customerKey(fixture, "tenant-a", "owner");
    const device = await registerOnlineDevice(fixture, "tenant-a", "device-idempotent");
    const key = "gateway-operation-0001";
    const body = {
      deviceId: "device-idempotent",
      capability: "ollama:chat:qwen-local",
      payload: { messages: [{ role: "user", content: "one execution" }] },
      timeoutMs: 2_000,
    };
    const rateBefore = fixture.d1.db
      .prepare(
        "SELECT COALESCE(SUM(request_count), 0) AS request_count FROM cloud_rate_limits WHERE tenant_id = 'tenant-a' AND limit_count = 30"
      )
      .get() as { request_count: number };

    const first = fixture.fetch(invokeRequest(owner.token, body, key));
    const concurrent = await fixture.fetch(invokeRequest(owner.token, body, key));
    assert.equal(concurrent.status, 409);
    assert.deepEqual(await concurrent.json(), {
      error: "Invocation with this Idempotency-Key is in progress",
    });

    let requests: Awaited<ReturnType<typeof device.transport.poll>> = null;
    for (let attempt = 0; attempt < 50 && !requests?.length; attempt += 1) {
      requests = await device.transport.poll(device.session);
      if (!requests?.length) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests?.length, 1);
    assert.equal(
      await device.transport.submitResult(device.session, {
        version: 1,
        requestId: requests![0].requestId,
        deliveryAttempt: requests![0].deliveryAttempt,
        outcome: { ok: true, value: { message: { role: "assistant", content: "once" } } },
      }),
      true
    );

    const completed = await first;
    assert.equal(completed.status, 200);
    const completedBody = await completed.json();
    assert.equal((completedBody as { requestId: string }).requestId, requests![0].requestId);

    const replay = await fixture.fetch(invokeRequest(owner.token, body, key));
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), completedBody);
    assert.equal((await device.transport.poll(device.session))?.length, 0);

    const rateLimit = fixture.d1.db
      .prepare(
        "SELECT SUM(request_count) AS request_count FROM cloud_rate_limits WHERE tenant_id = 'tenant-a' AND limit_count = 30"
      )
      .get() as { request_count: number };
    assert.equal(
      rateLimit.request_count,
      rateBefore.request_count + 1,
      "retries must not consume another invocation slot"
    );

    const stored = fixture.d1.db
      .prepare("SELECT state, key_hash, request_id FROM cloud_gateway_idempotency")
      .get() as { state: string; key_hash: string; request_id: string };
    assert.equal(stored.state, "completed");
    assert.equal(stored.request_id, requests![0].requestId);
    assert.notEqual(stored.key_hash, key, "D1 stores only the Idempotency-Key hash");

    for (const changed of [
      { ...body, payload: { messages: [{ role: "user", content: "different" }] } },
      { ...body, capability: "ollama:chat:other-model" },
      { ...body, deviceId: "different-device" },
    ]) {
      assert.equal((await fixture.fetch(invokeRequest(owner.token, changed, key))).status, 409);
    }
    const ownerB = await customerKey(fixture, "tenant-b", "owner");
    assert.equal(
      (await fixture.fetch(invokeRequest(ownerB.token, body, key))).status,
      404,
      "the tenant-scoped key does not reveal or block tenant A's idempotency record"
    );

    const revoked = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices/device-idempotent", "DELETE")
    );
    assert.equal(revoked.status, 200);
    const replayAfterRevocation = await fixture.fetch(invokeRequest(owner.token, body, key));
    assert.equal(replayAfterRevocation.status, 503);
    assert.deepEqual(await replayAfterRevocation.json(), { error: "Device is unavailable" });
  } finally {
    fixture.d1.db.close();
  }
});

test("an invocation retry after timeout resumes the same retained device request", async () => {
  const fixture = createRuntimeFixture({ currentClock: true });
  try {
    const owner = await customerKey(fixture, "tenant-a", "owner");
    const device = await registerOnlineDevice(fixture, "tenant-a", "device-timeout-retry");
    const key = "gateway-timeout-0001";
    const body = {
      deviceId: "device-timeout-retry",
      capability: "ollama:chat:qwen-local",
      payload: { prompt: "complete after the first wait expires" },
      timeoutMs: 100,
    };
    const timedOut = await fixture.fetch(invokeRequest(owner.token, body, key));
    assert.equal(timedOut.status, 504);

    const delivered = await device.transport.poll(device.session);
    assert.equal(delivered?.length, 1);
    const retry = fixture.fetch(invokeRequest(owner.token, { ...body, timeoutMs: 2_000 }, key));
    assert.equal((await device.transport.poll(device.session))?.length, 0);
    assert.equal(
      await device.transport.submitResult(device.session, {
        version: 1,
        requestId: delivered![0].requestId,
        deliveryAttempt: delivered![0].deliveryAttempt,
        outcome: { ok: true, value: { recovered: true } },
      }),
      true
    );
    const completed = await retry;
    assert.equal(completed.status, 200);
    assert.equal((completed as Response).headers.get("cache-control"), "no-store");
    const stored = fixture.d1.db
      .prepare("SELECT request_id, state FROM cloud_gateway_idempotency")
      .get() as { request_id: string; state: string };
    assert.equal(stored.request_id, delivered![0].requestId);
    assert.equal(stored.state, "completed");
  } finally {
    fixture.d1.db.close();
  }
});

test("a result-audit failure retries from the completed device request without invoking twice", async () => {
  const fixture = createRuntimeFixture();
  try {
    const owner = await customerKey(fixture, "tenant-a", "owner");
    const device = await registerOnlineDevice(fixture, "tenant-a", "device-audit-retry");
    const key = "gateway-audit-retry-0001";
    const body = {
      deviceId: "device-audit-retry",
      capability: "ollama:chat:qwen-local",
      payload: { prompt: "return once even when result auditing fails" },
      timeoutMs: 2_000,
    };
    let failSuccessfulResultAudit = true;
    const failingDb: CloudDb = {
      prepare<T = unknown>(sql: string): CloudDbStatement<T> {
        const statement = fixture.d1.prepare<T>(sql);
        let values: unknown[] = [];
        return {
          bind(...nextValues: unknown[]) {
            values = nextValues;
            statement.bind(...nextValues);
            return this;
          },
          first<U = T>(column?: string) {
            return statement.first<U>(column);
          },
          all<U = T>() {
            return statement.all<U>();
          },
          async run() {
            if (
              failSuccessfulResultAudit &&
              sql.includes("INSERT INTO cloud_compliance_audit") &&
              values[9] === "success"
            ) {
              throw new Error("Injected terminal audit failure");
            }
            return statement.run();
          },
        };
      },
      batch(statements: CloudDbStatement[]) {
        return fixture.d1.batch(statements);
      },
      exec(sql: string) {
        return fixture.d1.exec(sql);
      },
    };
    const retryRuntime = createCloudRuntime({
      env: { DB: failingDb, GATEWAY_SESSIONS: fixture.sessions },
      now: () => new Date(fixture.now),
    });
    const invoke = () => retryRuntime.fetch(invokeRequest(owner.token, body, key));

    const firstInvocation = invoke();
    let delivered: Awaited<ReturnType<typeof device.transport.poll>> = null;
    for (let attempt = 0; attempt < 50 && !delivered?.length; attempt += 1) {
      delivered = await device.transport.poll(device.session);
      if (!delivered?.length) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(delivered?.length, 1);
    const requestId = delivered![0].requestId;
    assert.equal(
      await device.transport.submitResult(device.session, {
        version: 1,
        requestId,
        deliveryAttempt: delivered![0].deliveryAttempt,
        outcome: { ok: true, value: { recovered: "same durable request" } },
      }),
      true
    );

    const firstResponse = await firstInvocation;
    assert.equal(firstResponse.status, 503);
    assert.deepEqual(await firstResponse.json(), { error: "Invocation result is unavailable" });

    failSuccessfulResultAudit = false;
    const retriedResponse = await invoke();
    assert.equal(retriedResponse.status, 200);
    assert.deepEqual(await retriedResponse.json(), {
      requestId,
      result: {
        version: 1,
        outcome: { ok: true, value: { recovered: "same durable request" } },
      },
    });
    assert.equal((await device.transport.poll(device.session))?.length, 0);

    const idempotency = fixture.d1.db
      .prepare("SELECT request_id, state FROM cloud_gateway_idempotency")
      .get() as { request_id: string; state: string };
    assert.equal(idempotency.request_id, requestId);
    assert.equal(idempotency.state, "completed");
    const audits = fixture.d1.db
      .prepare(
        "SELECT status, COUNT(*) AS count FROM cloud_compliance_audit WHERE action = 'gateway.customer.invoke' GROUP BY status ORDER BY status"
      )
      .all() as Array<{ status: string; count: number }>;
    assert.deepEqual(
      audits.map((row) => ({ status: row.status, count: Number(row.count) })),
      [
        { status: "attempted", count: 1 },
        { status: "success", count: 1 },
      ]
    );
  } finally {
    fixture.d1.db.close();
  }
});

test("device revocation makes an idempotent operation terminal and clears its queued request", async () => {
  const fixture = createRuntimeFixture();
  try {
    const owner = await customerKey(fixture, "tenant-a", "owner");
    const device = await registerOnlineDevice(fixture, "tenant-a", "device-revoke-invoke");
    const key = "gateway-revocation-0001";
    const body = {
      deviceId: "device-revoke-invoke",
      capability: "ollama:chat:qwen-local",
      payload: { prompt: "must not repeat after revocation" },
      timeoutMs: 2_000,
    };
    const invocation = fixture.fetch(invokeRequest(owner.token, body, key));
    let requests: Awaited<ReturnType<typeof device.transport.poll>> = null;
    for (let attempt = 0; attempt < 50 && !requests?.length; attempt += 1) {
      requests = await device.transport.poll(device.session);
      if (!requests?.length) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests?.length, 1);

    const revokeResponse = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices/device-revoke-invoke", "DELETE")
    );
    assert.equal(revokeResponse.status, 200);
    const first = await invocation;
    assert.equal(first.status, 503);
    assert.deepEqual(await first.json(), { error: "Device is unavailable" });

    const replay = await fixture.fetch(invokeRequest(owner.token, body, key));
    assert.equal(replay.status, 503);
    assert.deepEqual(await replay.json(), { error: "Device is unavailable" });
    const stored = fixture.sessions
      .get("device-revoke-invoke")
      .getRequest("device-revoke-invoke", requests![0].requestId, fixture.now);
    assert.equal(await stored, null);
  } finally {
    fixture.d1.db.close();
  }
});

test("customer invocation rejects invalid, revoked, expired, suspended, viewer, and offline identities safely", async () => {
  const fixture = createRuntimeFixture();
  try {
    const owner = await customerKey(fixture, "tenant-a", "owner");
    const viewer = await customerKey(fixture, "tenant-a", "viewer");
    const expired = await customerKey(fixture, "tenant-a", "member", "expired-member");
    fixture.d1.db
      .prepare("UPDATE cloud_customer_api_keys SET expires_at = ? WHERE id = ?")
      .run("2026-10-08T11:59:59.000Z", expired.id);
    const revoked = await customerKey(fixture, "tenant-a", "member", "revoked-member");
    fixture.d1.db
      .prepare("UPDATE cloud_customer_api_keys SET revoked_at = ? WHERE id = ?")
      .run(fixture.now, revoked.id);

    const body = {
      deviceId: "device-customer-offline",
      capability: "ollama:chat:qwen-local",
      payload: { prompt: "do not log" },
    };
    const missingIdempotencyKey = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/customer/invoke", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    );
    assert.equal(missingIdempotencyKey.status, 400);
    const unauthorized = await fixture.fetch(invokeRequest("not-a-customer-key", body));
    assert.equal(unauthorized.status, 401);
    assert.equal((await fixture.fetch(invokeRequest(expired.token, body))).status, 401);
    assert.equal((await fixture.fetch(invokeRequest(revoked.token, body))).status, 401);
    assert.equal((await fixture.fetch(invokeRequest(viewer.token, body))).status, 403);

    const credential = "agent-offline-credential-".padEnd(43, "x");
    const registered = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/gateway-devices", "POST", {
        id: body.deviceId,
        credentialHash: createHash("sha256").update(credential).digest("hex"),
        capabilities: [body.capability],
      })
    );
    assert.equal(registered.status, 201);
    const offline = await fixture.fetch(invokeRequest(owner.token, body));
    assert.equal(offline.status, 503);
    const tooSlow = await fixture.fetch(invokeRequest(owner.token, { ...body, timeoutMs: 30_001 }));
    assert.equal(tooSlow.status, 400);
    const oversized = await fixture.fetch(
      invokeRequest(owner.token, { ...body, payload: "x".repeat(66 * 1024) })
    );
    assert.equal(oversized.status, 400);

    const suspended = await fixture.fetch(
      adminRequest("/__cloud/v1/tenants/tenant-a/status", "POST", { status: "suspended" })
    );
    assert.equal(suspended.status, 200);
    assert.equal((await fixture.fetch(invokeRequest(owner.token, body))).status, 401);
  } finally {
    fixture.d1.db.close();
  }
});

test("customer invocation rate limit is tenant-scoped and fails closed when D1 is unavailable", async () => {
  const fixture = createRuntimeFixture({ customerInvokeRateLimit: { limit: 2, windowMs: 60_000 } });
  try {
    const ownerA = await customerKey(fixture, "tenant-a", "owner");
    const ownerB = await customerKey(fixture, "tenant-b", "owner");
    const body = {
      deviceId: "missing-device",
      capability: "ollama:chat:qwen-local",
      payload: { prompt: "hello" },
    };
    assert.equal((await fixture.fetch(invokeRequest(ownerA.token, body))).status, 503);
    assert.equal((await fixture.fetch(invokeRequest(ownerA.token, body))).status, 503);
    assert.equal((await fixture.fetch(invokeRequest(ownerA.token, body))).status, 429);
    assert.equal((await fixture.fetch(invokeRequest(ownerB.token, body))).status, 503);

    const buckets = fixture.d1.db
      .prepare(
        "SELECT tenant_id, request_count, limit_count FROM cloud_rate_limits ORDER BY tenant_id"
      )
      .all() as Array<{ tenant_id: string; request_count: number; limit_count: number }>;
    assert.deepEqual(
      buckets.map((row) => ({ ...row })),
      [
        { tenant_id: "tenant-a", request_count: 3, limit_count: 2 },
        { tenant_id: "tenant-b", request_count: 1, limit_count: 2 },
      ]
    );

    let rateLimitUnavailable = true;
    let attemptedAuditUnavailable = false;
    const failingDb: CloudDb = {
      prepare<T = unknown>(sql: string): CloudDbStatement<T> {
        if (rateLimitUnavailable && sql.includes("INSERT INTO cloud_rate_limits")) {
          throw new Error("D1 unavailable");
        }
        if (attemptedAuditUnavailable && sql.includes("INSERT INTO cloud_compliance_audit")) {
          throw new Error("D1 unavailable");
        }
        return fixture.d1.prepare<T>(sql);
      },
      batch(statements: CloudDbStatement[]) {
        return fixture.d1.batch(statements);
      },
      exec(sql: string) {
        return fixture.d1.exec(sql);
      },
    };
    const failingRuntime = createCloudRuntime({
      env: { DB: failingDb, GATEWAY_SESSIONS: fixture.sessions },
      now: () => new Date(fixture.now),
    });
    const retryKey = "gateway-rate-limit-retry-0001";
    const failingResponse = await failingRuntime.fetch(invokeRequest(ownerB.token, body, retryKey));
    assert.equal(failingResponse.status, 503);
    assert.deepEqual(await failingResponse.json(), {
      error: "Invocation rate limit is unavailable",
    });
    rateLimitUnavailable = false;
    attemptedAuditUnavailable = true;
    const auditFailureResponse = await failingRuntime.fetch(
      invokeRequest(ownerB.token, body, retryKey)
    );
    assert.equal(auditFailureResponse.status, 503);
    assert.deepEqual(await auditFailureResponse.json(), {
      error: "Invocation audit is unavailable",
    });
    attemptedAuditUnavailable = false;
    const retriedResponse = await failingRuntime.fetch(invokeRequest(ownerB.token, body, retryKey));
    assert.equal(
      retriedResponse.status,
      503,
      "a pre-execution 503 must release its claim so a retry can continue through the gateway"
    );
    assert.deepEqual(await retriedResponse.json(), { error: "Device is unavailable" });
  } finally {
    fixture.d1.db.close();
  }
});

test("device poll rate limit is scoped to the registered tenant device and preserves independent devices", async () => {
  const fixture = createRuntimeFixture({
    gatewayDeviceRateLimits: { poll: { limit: 2, windowMs: 60_000 } },
  });
  try {
    const first = await registerOnlineDevice(fixture, "tenant-a", "poll-limit-device-a");
    const second = await registerOnlineDevice(fixture, "tenant-a", "poll-limit-device-b");

    const invalidSession = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          deviceId: first.session.deviceId,
          sessionToken: "z".repeat(43),
        }),
      })
    );
    assert.equal(invalidSession.status, 401);
    assert.equal((await first.transport.poll(first.session))?.length, 0);
    assert.equal((await first.transport.poll(first.session))?.length, 0);
    const throttled = await fixture.fetch(
      new Request("https://cloud.example.test/__gateway/v1/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          deviceId: first.session.deviceId,
          sessionToken: first.session.sessionToken,
        }),
      })
    );
    assert.equal(throttled.status, 429);
    assert.equal((await second.transport.poll(second.session))?.length, 0);

    const row = fixture.d1.db
      .prepare(
        "SELECT tenant_id, bucket_hash, request_count, limit_count FROM cloud_rate_limits WHERE tenant_id = ? ORDER BY request_count DESC LIMIT 1"
      )
      .get("tenant-a") as
      | { tenant_id: string; bucket_hash: string; request_count: number; limit_count: number }
      | undefined;
    assert.equal(row?.tenant_id, "tenant-a");
    assert.equal(row?.request_count, 3);
    assert.equal(row?.limit_count, 2);
    assert.match(row?.bucket_hash ?? "", /^[a-f0-9]{64}$/);
    assert.equal((row?.bucket_hash ?? "").includes(first.session.deviceId), false);
  } finally {
    fixture.d1.db.close();
  }
});

test("device connect, heartbeat, and result routes apply independent limits", async () => {
  const fixture = createRuntimeFixture({
    gatewayConnectFallbackRateLimit: { limit: 1, windowMs: 60_000 },
    gatewayDeviceRateLimits: {
      heartbeat: { limit: 1, windowMs: 60_000 },
      result: { limit: 1, windowMs: 60_000 },
    },
  });
  try {
    const deviceId = "route-limit-device";
    const { session } = await registerOnlineDevice(fixture, "tenant-a", deviceId);
    const credential = `agent-${deviceId}-credential`.padEnd(43, "x");
    const post = (route: string, payload: unknown) =>
      fixture.fetch(
        new Request(`https://cloud.example.test/__gateway/v1/device/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
      );

    assert.equal(
      (await post("connect", { version: 1, deviceId, credential })).status,
      429,
      "connect retries use the bounded pre-auth bucket"
    );
    assert.equal(
      (
        await post("heartbeat", {
          version: 1,
          deviceId,
          sessionToken: session.sessionToken,
          capabilities: [],
        })
      ).status,
      429,
      "heartbeat has its own route bucket"
    );
    assert.equal(
      (
        await post("result", {
          version: 1,
          deviceId,
          sessionToken: session.sessionToken,
          requestId: "no-pending-request",
          deliveryAttempt: 1,
          result: { ok: true },
        })
      ).status,
      409,
      "first result reaches normal device authorization"
    );
    assert.equal(
      (
        await post("result", {
          version: 1,
          deviceId,
          sessionToken: session.sessionToken,
          requestId: "no-pending-request",
          deliveryAttempt: 1,
          result: { ok: true },
        })
      ).status,
      429,
      "result retries are limited independently"
    );
  } finally {
    fixture.d1.db.close();
  }
});

test("unknown device IDs share the bounded local/test pre-auth fallback bucket", async () => {
  const fixture = createRuntimeFixture({
    gatewayConnectFallbackRateLimit: { limit: 2, windowMs: 60_000 },
  });
  try {
    const connect = (deviceId: string) =>
      fixture.fetch(
        new Request("https://cloud.example.test/__gateway/v1/device/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: 1, deviceId, credential: "x".repeat(43) }),
        })
      );
    assert.equal((await connect("unknown-device-a")).status, 401);
    assert.equal((await connect("unknown-device-b")).status, 401);
    assert.equal((await connect("unknown-device-c")).status, 429);

    const rows = fixture.d1.db
      .prepare("SELECT tenant_id, bucket_hash, request_count, limit_count FROM cloud_rate_limits")
      .all() as Array<{
      tenant_id: string;
      bucket_hash: string;
      request_count: number;
      limit_count: number;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, "tenant_shiryu_admin");
    assert.equal(rows[0].request_count, 3);
    assert.equal(rows[0].limit_count, 2);
    assert.match(rows[0].bucket_hash, /^[a-f0-9]{64}$/);
  } finally {
    fixture.d1.db.close();
  }
});

test("repeated invalid customer API keys are rate limited without persisting the credential", async () => {
  const fixture = createRuntimeFixture({
    customerAuthFailureFallbackRateLimit: { limit: 2, windowMs: 60_000 },
  });
  try {
    const token = `orc_live_${"a".repeat(40)}`;
    const body = {
      deviceId: "missing-device",
      capability: "ollama:chat:qwen-local",
      payload: { prompt: "hello" },
    };
    assert.equal((await fixture.fetch(invokeRequest(token, body))).status, 401);
    assert.equal((await fixture.fetch(invokeRequest(token, body))).status, 401);
    assert.equal((await fixture.fetch(invokeRequest(token, body))).status, 429);

    const row = fixture.d1.db
      .prepare(
        "SELECT tenant_id, bucket_hash, request_count, limit_count FROM cloud_rate_limits WHERE tenant_id = ?"
      )
      .get("tenant_shiryu_admin") as
      | { tenant_id: string; bucket_hash: string; request_count: number; limit_count: number }
      | undefined;
    assert.equal(row?.tenant_id, "tenant_shiryu_admin");
    assert.equal(row?.request_count, 3);
    assert.equal(row?.limit_count, 2);
    assert.match(row?.bucket_hash ?? "", /^[a-f0-9]{64}$/);
    assert.equal((row?.bucket_hash ?? "").includes(token), false);
  } finally {
    fixture.d1.db.close();
  }
});

test("Worker auth attempts use edge IP metadata and ignore spoofed X-Forwarded-For", async () => {
  const fixture = createRuntimeFixture({
    customerAuthFailureRateLimit: { limit: 1, windowMs: 60_000 },
  });
  try {
    const body = {
      deviceId: "missing-device",
      capability: "ollama:chat:qwen-local",
      payload: { prompt: "hello" },
    };
    const workerRequest = (token: string, forwardedFor: string) => {
      const source = invokeRequest(token, body);
      const request = new Request(source, {
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "Idempotency-Key": `cf-ip-test-${forwardedFor.replaceAll(".", "-")}-0001`,
          "CF-Connecting-IP": "198.51.100.24",
          "X-Forwarded-For": forwardedFor,
        },
      });
      Object.defineProperty(request, "cf", { value: { colo: "DFW" } });
      return request;
    };
    assert.equal(
      (await fixture.fetch(workerRequest(`orc_live_${"a".repeat(40)}`, "192.0.2.1"))).status,
      401
    );
    assert.equal(
      (await fixture.fetch(workerRequest(`orc_live_${"b".repeat(40)}`, "203.0.113.99"))).status,
      429,
      "changing X-Forwarded-For cannot bypass the edge-IP bucket"
    );

    const rows = fixture.d1.db
      .prepare("SELECT tenant_id, bucket_hash, request_count FROM cloud_rate_limits")
      .all() as Array<{ tenant_id: string; bucket_hash: string; request_count: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, "tenant_shiryu_admin");
    assert.equal(rows[0].request_count, 2);
    assert.match(rows[0].bucket_hash, /^[a-f0-9]{64}$/);
  } finally {
    fixture.d1.db.close();
  }
});
