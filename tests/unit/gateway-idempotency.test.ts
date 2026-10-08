import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import {
  claimGatewayIdempotency,
  completeGatewayIdempotency,
  GATEWAY_IDEMPOTENCY_MAX_RESPONSE_BYTES,
} from "../../src/cloud/gatewayIdempotency";

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

  async all<U = T>(): Promise<{ results: U[]; success: boolean }> {
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
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    this.db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY)");
    this.db.exec(
      readFileSync(
        join(process.cwd(), "cloudflare/migrations/0006_gateway_invocation_idempotency.sql"),
        "utf8"
      )
    );
    this.db.prepare("INSERT INTO tenants (id) VALUES (?)").run("tenant-a");
    this.db.prepare("INSERT INTO tenants (id) VALUES (?)").run("tenant-b");
  }

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new SqliteStatement<T>(this.db, sql);
  }

  async batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    return statements;
  }

  async exec(sql: string): Promise<unknown> {
    return this.db.exec(sql);
  }
}

const scope = { tenantId: "tenant-a", principalId: "owner-a", apiKeyId: "key-a" };
const nowMs = Date.parse("2026-10-08T12:00:00.000Z");

test("idempotency keys are tenant-scoped and conflict within a tenant on operation changes", async () => {
  const d1 = new SqliteD1();
  try {
    const first = await claimGatewayIdempotency(d1, {
      key: "gateway-operation-0001",
      scope,
      operation: {
        deviceId: "device-a",
        capability: "ollama:chat:model-a",
        payload: { prompt: "a" },
      },
      requestId: "request-a",
      claimToken: "claim-a",
      nowMs,
    });
    assert.equal(first.kind, "claimed");

    const otherTenantScope = { tenantId: "tenant-b", principalId: "owner-b", apiKeyId: "key-b" };
    const otherTenant = await claimGatewayIdempotency(d1, {
      key: "gateway-operation-0001",
      scope: otherTenantScope,
      operation: {
        deviceId: "device-a",
        capability: "ollama:chat:model-a",
        payload: { prompt: "a" },
      },
      requestId: "request-b",
      claimToken: "claim-b",
      nowMs,
    });
    assert.equal(otherTenant.kind, "claimed");

    const otherTenantComplete = await completeGatewayIdempotency(
      d1,
      otherTenant.claim,
      "claim-b",
      { tenant: "b" },
      200,
      nowMs
    );
    assert.equal(otherTenantComplete.kind, "replay");
    const otherTenantReplay = await claimGatewayIdempotency(d1, {
      key: "gateway-operation-0001",
      scope: otherTenantScope,
      operation: {
        deviceId: "device-a",
        capability: "ollama:chat:model-a",
        payload: { prompt: "a" },
      },
      requestId: "unused-request-b",
      claimToken: "unused-claim-b",
      nowMs,
    });
    assert.equal(otherTenantReplay.kind, "replay");
    if (otherTenantReplay.kind === "replay") {
      assert.deepEqual(otherTenantReplay.response, { tenant: "b" });
    }

    const firstComplete = await completeGatewayIdempotency(
      d1,
      first.claim,
      "claim-a",
      { tenant: "a" },
      200,
      nowMs
    );
    assert.equal(firstComplete.kind, "replay");
    const sameTenantReplay = await claimGatewayIdempotency(d1, {
      key: "gateway-operation-0001",
      scope,
      operation: {
        deviceId: "device-a",
        capability: "ollama:chat:model-a",
        payload: { prompt: "a" },
      },
      requestId: "unused-request-a",
      claimToken: "unused-claim-a",
      nowMs,
    });
    assert.equal(sameTenantReplay.kind, "replay");
    if (sameTenantReplay.kind === "replay") {
      assert.deepEqual(sameTenantReplay.response, { tenant: "a" });
    }

    const changedPayload = await claimGatewayIdempotency(d1, {
      key: "gateway-operation-0001",
      scope,
      operation: {
        deviceId: "device-a",
        capability: "ollama:chat:model-a",
        payload: { prompt: "b" },
      },
      requestId: "request-c",
      claimToken: "claim-c",
      nowMs,
    });
    assert.equal(changedPayload.kind, "conflict");
  } finally {
    d1.db.close();
  }
});

test("idempotency migration is safe to apply more than once", () => {
  const d1 = new SqliteD1();
  try {
    const migration = readFileSync(
      join(process.cwd(), "cloudflare/migrations/0006_gateway_invocation_idempotency.sql"),
      "utf8"
    );
    assert.doesNotThrow(() => d1.db.exec(migration));
    assert.doesNotThrow(() => d1.db.exec(migration));
  } finally {
    d1.db.close();
  }
});

test("oversized cached responses are rejected and leave the claim pending", async () => {
  const d1 = new SqliteD1();
  try {
    const claimResult = await claimGatewayIdempotency(d1, {
      key: "gateway-operation-0002",
      scope,
      operation: { deviceId: "device-a", capability: "ollama:chat:model-a", payload: {} },
      requestId: "request-large",
      claimToken: "claim-large",
      nowMs,
    });
    assert.equal(claimResult.kind, "claimed");
    if (claimResult.kind !== "claimed") return;

    const rejected = await completeGatewayIdempotency(
      d1,
      claimResult.claim,
      "claim-large",
      { value: "x".repeat(GATEWAY_IDEMPOTENCY_MAX_RESPONSE_BYTES) },
      200,
      nowMs + 1
    );
    assert.equal(rejected.kind, "capacity");
    const row = d1.db
      .prepare("SELECT state, response_json FROM cloud_gateway_idempotency WHERE key_hash = ?")
      .get(claimResult.claim.keyHash) as { state: string; response_json: string | null };
    assert.equal(row.state, "pending");
    assert.equal(row.response_json, null);
  } finally {
    d1.db.close();
  }
});

test("claims expire and per-tenant storage is capped", async () => {
  const d1 = new SqliteD1();
  try {
    const initial = await claimGatewayIdempotency(d1, {
      key: "gateway-expiry-0001",
      scope,
      operation: { deviceId: "device-a", capability: "ollama:chat:model-a", payload: {} },
      requestId: "request-expired",
      claimToken: "claim-expired",
      nowMs,
    });
    assert.equal(initial.kind, "claimed");

    const afterExpiry = await claimGatewayIdempotency(d1, {
      key: "gateway-expiry-0001",
      scope,
      operation: { deviceId: "device-a", capability: "ollama:chat:model-a", payload: {} },
      requestId: "request-fresh",
      claimToken: "claim-fresh",
      nowMs: nowMs + 10 * 60_000,
    });
    assert.equal(afterExpiry.kind, "claimed");
    if (afterExpiry.kind === "claimed") assert.equal(afterExpiry.claim.requestId, "request-fresh");

    let last: Awaited<ReturnType<typeof claimGatewayIdempotency>> | undefined;
    for (let index = 0; index < 127; index += 1) {
      last = await claimGatewayIdempotency(d1, {
        key: `gateway-capacity-${String(index).padStart(3, "0")}`,
        scope,
        operation: { deviceId: "device-a", capability: "ollama:chat:model-a", payload: { index } },
        requestId: `request-capacity-${index}`,
        claimToken: `claim-capacity-${index}`,
        nowMs: nowMs + 10 * 60_000 + 1,
      });
      assert.equal(last.kind, "claimed");
    }
    const full = await claimGatewayIdempotency(d1, {
      key: "gateway-capacity-overflow",
      scope,
      operation: { deviceId: "device-a", capability: "ollama:chat:model-a", payload: {} },
      requestId: "request-overflow",
      claimToken: "claim-overflow",
      nowMs: nowMs + 10 * 60_000 + 1,
    });
    assert.equal(full.kind, "capacity");
    const count = d1.db
      .prepare(
        "SELECT COUNT(*) AS count FROM cloud_gateway_idempotency WHERE tenant_id = 'tenant-a'"
      )
      .get() as { count: number };
    assert.equal(count.count, 128);
  } finally {
    d1.db.close();
  }
});
