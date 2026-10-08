import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "@/cloud/db";
import {
  cleanupStaleCloudInferenceReservations,
  getCloudInferenceBudgetStatus,
  reserveCloudInferenceTokens,
  setCloudInferenceEntitlement,
  setCloudInferenceMonthlyBudget,
} from "@/cloud/inferencePolicy";
import { cleanupExpiredCloudRateLimits } from "@/cloud/rateLimit";

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
    for (const name of [
      "0001_cloud_runtime.sql",
      "0002_cloud_usage_audit_rate_limits.sql",
      "0003_cloud_platform_tenant.sql",
      "0009_cloud_rate_limit_retention.sql",
      "0010_cloud_inference_policy.sql",
    ]) {
      this.db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", name), "utf8"));
    }
    this.db
      .prepare(
        `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
         VALUES ('tenant-a', 'Alpha', 'alpha', 'customer', 1, '2026-10-08', '2026-10-08')`
      )
      .run();
  }

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new SqliteStatement<T>(this.db, sql);
  }

  async batch(): Promise<unknown[]> {
    throw new Error("batch is unused by rate-limit cleanup");
  }

  async exec(sql: string): Promise<unknown> {
    return this.db.exec(sql);
  }
}

const NOW_MS = Date.parse("2026-10-08T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function insertBucket(
  db: SqliteD1,
  input: { hash: string; startedAtMs: number; windowMs: number; tenantId?: string }
): void {
  db.db
    .prepare(
      `INSERT INTO cloud_rate_limits (
        tenant_id, bucket_hash, window_started_at_ms, window_ms, limit_count, request_count, updated_at
      ) VALUES (?, ?, ?, ?, 10, 1, '2026-10-08T12:00:00.000Z')`
    )
    .run(input.tenantId ?? "tenant-a", input.hash, input.startedAtMs, input.windowMs);
}

test("rate-limit retention preserves active and recently expired windows", async () => {
  const fixture = new SqliteD1();
  try {
    insertBucket(fixture, { hash: "active-short", startedAtMs: NOW_MS - 30_000, windowMs: 60_000 });
    insertBucket(fixture, {
      hash: "active-long",
      startedAtMs: NOW_MS - HOUR_MS,
      windowMs: 7 * 24 * HOUR_MS,
    });
    insertBucket(fixture, {
      hash: "recently-expired",
      startedAtMs: NOW_MS - 24 * HOUR_MS - 30_000,
      windowMs: 60_000,
    });
    insertBucket(fixture, {
      hash: "stale",
      startedAtMs: NOW_MS - 26 * HOUR_MS,
      windowMs: 60_000,
    });

    assert.equal(await cleanupExpiredCloudRateLimits(fixture, { nowMs: NOW_MS }), 1);
    const remaining = fixture.db
      .prepare("SELECT bucket_hash FROM cloud_rate_limits ORDER BY bucket_hash")
      .all() as Array<{ bucket_hash: string }>;
    assert.deepEqual(
      remaining.map((row) => row.bucket_hash),
      ["active-long", "active-short", "recently-expired"]
    );
  } finally {
    fixture.db.close();
  }
});

test("rate-limit retention deletes no more than one configured batch per run", async () => {
  const fixture = new SqliteD1();
  try {
    for (let index = 0; index < 5; index += 1) {
      insertBucket(fixture, {
        hash: `stale-${index}`,
        startedAtMs: NOW_MS - 26 * HOUR_MS,
        windowMs: 60_000,
      });
    }
    insertBucket(fixture, { hash: "active", startedAtMs: NOW_MS - 30_000, windowMs: 60_000 });

    assert.equal(await cleanupExpiredCloudRateLimits(fixture, { nowMs: NOW_MS, batchSize: 2 }), 2);
    assert.equal(await cleanupExpiredCloudRateLimits(fixture, { nowMs: NOW_MS, batchSize: 2 }), 2);
    assert.equal(await cleanupExpiredCloudRateLimits(fixture, { nowMs: NOW_MS, batchSize: 2 }), 1);
    assert.equal(await cleanupExpiredCloudRateLimits(fixture, { nowMs: NOW_MS, batchSize: 2 }), 0);
    const remaining = fixture.db
      .prepare("SELECT bucket_hash FROM cloud_rate_limits")
      .all() as Array<{ bucket_hash: string }>;
    assert.deepEqual(
      remaining.map((row) => row.bucket_hash),
      ["active"]
    );
  } finally {
    fixture.db.close();
  }
});

test("stale inference cleanup charges abandoned claims at their reserved caps and preserves recent calls", async () => {
  const fixture = new SqliteD1();
  try {
    await setCloudInferenceMonthlyBudget(fixture, {
      tenantId: "tenant-a",
      monthlyTokenLimit: 1000,
      now: new Date(NOW_MS - 6 * 60_000),
    });
    await setCloudInferenceEntitlement(fixture, {
      tenantId: "tenant-a",
      provider: "openai",
      model: "gpt-4o-mini",
      enabled: true,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      now: new Date(NOW_MS - 6 * 60_000),
    });
    const makeReservation = (reservationId: string, createdMs: number) =>
      reserveCloudInferenceTokens(fixture, {
        tenantId: "tenant-a",
        reservationId,
        provider: "openai",
        model: "gpt-4o-mini",
        inputTokens: 10,
        maxOutputTokens: 10,
        now: new Date(createdMs),
      });

    assert.equal(
      (await makeReservation("stale-reservation", NOW_MS - 6 * 60_000)).kind,
      "reserved"
    );
    assert.equal(
      (await makeReservation("recent-reservation", NOW_MS - 4 * 60_000)).kind,
      "reserved"
    );
    assert.equal((await makeReservation("active-reservation", NOW_MS)).kind, "reserved");

    assert.equal(
      await cleanupStaleCloudInferenceReservations(fixture, { now: new Date(NOW_MS) }),
      1
    );
    const rows = fixture.db
      .prepare(
        "SELECT reservation_id, status FROM cloud_inference_reservations ORDER BY reservation_id"
      )
      .all() as Array<{ reservation_id: string; status: string }>;
    assert.deepEqual(
      rows.map((row) => ({ reservation_id: row.reservation_id, status: row.status })),
      [
        { reservation_id: "active-reservation", status: "reserved" },
        { reservation_id: "recent-reservation", status: "reserved" },
        { reservation_id: "stale-reservation", status: "settled" },
      ]
    );
    const stale = fixture.db
      .prepare(
        `SELECT actual_input_tokens, actual_output_tokens, actual_tokens
           FROM cloud_inference_reservations WHERE tenant_id = 'tenant-a'
             AND reservation_id = 'stale-reservation'`
      )
      .get() as {
      actual_input_tokens: number;
      actual_output_tokens: number;
      actual_tokens: number;
    };
    assert.deepEqual(
      { ...stale },
      {
        actual_input_tokens: 10,
        actual_output_tokens: 10,
        actual_tokens: 20,
      }
    );
    assert.deepEqual(await getCloudInferenceBudgetStatus(fixture, "tenant-a", new Date(NOW_MS)), {
      tenantId: "tenant-a",
      monthUtc: "2026-10",
      monthlyTokenLimit: 1000,
      reservedTokens: 40,
      settledTokens: 20,
      consumedTokens: 60,
      remainingTokens: 940,
    });
    assert.equal(
      (await makeReservation("stale-reservation", NOW_MS)).kind,
      "replay",
      "cleanup preserves the idempotency row and cannot retry an uncertain provider operation"
    );
    const replay = await reserveCloudInferenceTokens(fixture, {
      tenantId: "tenant-a",
      reservationId: "stale-reservation",
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 10,
      maxOutputTokens: 10,
      now: new Date(NOW_MS),
    });
    assert.equal(replay.kind, "replay");
    if (replay.kind === "replay") assert.equal(replay.reservation.status, "settled");
  } finally {
    fixture.db.close();
  }
});

test("stale inference cleanup settles no more than the configured batch", async () => {
  const fixture = new SqliteD1();
  try {
    await setCloudInferenceMonthlyBudget(fixture, {
      tenantId: "tenant-a",
      monthlyTokenLimit: 1000,
      now: new Date(NOW_MS - 10 * 60_000),
    });
    await setCloudInferenceEntitlement(fixture, {
      tenantId: "tenant-a",
      provider: "openai",
      model: "gpt-4o-mini",
      enabled: true,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      now: new Date(NOW_MS - 10 * 60_000),
    });
    for (let index = 0; index < 5; index += 1) {
      await reserveCloudInferenceTokens(fixture, {
        tenantId: "tenant-a",
        reservationId: `abandoned-${index}`,
        provider: "openai",
        model: "gpt-4o-mini",
        inputTokens: 10,
        maxOutputTokens: 10,
        now: new Date(NOW_MS - 10 * 60_000),
      });
    }
    assert.equal(
      await cleanupStaleCloudInferenceReservations(fixture, {
        now: new Date(NOW_MS),
        batchSize: 2,
      }),
      2
    );
    assert.equal(
      await cleanupStaleCloudInferenceReservations(fixture, {
        now: new Date(NOW_MS),
        batchSize: 2,
      }),
      2
    );
    assert.equal(
      await cleanupStaleCloudInferenceReservations(fixture, {
        now: new Date(NOW_MS),
        batchSize: 2,
      }),
      1
    );
    assert.equal(
      await cleanupStaleCloudInferenceReservations(fixture, {
        now: new Date(NOW_MS),
        batchSize: 2,
      }),
      0
    );
    const settled = fixture.db
      .prepare(
        "SELECT COUNT(*) AS count FROM cloud_inference_reservations WHERE status = 'settled'"
      )
      .get() as { count: number };
    assert.equal(settled.count, 5);
  } finally {
    fixture.db.close();
  }
});
