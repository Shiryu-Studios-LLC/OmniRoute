import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "@/cloud/db";
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
