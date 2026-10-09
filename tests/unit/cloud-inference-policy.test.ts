import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { cleanupExpiredCloudInferenceResponses } from "../../src/cloud/inferenceIdempotency";
import {
  cleanupSettledCloudInferenceReservations,
  getCloudInferenceBudgetStatus,
  getCloudInferenceEntitlement,
  listCloudInferenceEntitlements,
  releaseCloudInferenceReservation,
  reserveCloudInferenceTokens,
  setCloudInferenceEntitlement,
  setCloudInferenceMonthlyBudget,
  settleCloudInferenceReservation,
} from "../../src/cloud/inferencePolicy";

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

  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    const result = this.db
      .prepare(this.sql)
      .run(...(this.values as (null | number | bigint | string | Uint8Array)[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteCloudDb implements CloudDb {
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new SqliteStatement<T>(this.db, sql);
  }

  async batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results: unknown[] = [];
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

const NOW = "2026-10-08T12:00:00.000Z";

async function makeDb(): Promise<SqliteCloudDb> {
  const db = new SqliteCloudDb();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0010_cloud_inference_policy.sql",
    "0011_cloud_inference_idempotency.sql",
    "0012_cloud_inference_idempotency_capacity.sql",
    "0013_cloud_inference_idempotency_tombstone_retention.sql",
    "0014_cloud_inference_reservation_retention.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  for (const [id, name, slug] of [
    ["tenant-a", "Tenant A", "tenant-a"],
    ["tenant-b", "Tenant B", "tenant-b"],
  ]) {
    await db
      .prepare(
        `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'customer', 1, ?, ?)`
      )
      .bind(id, name, slug, NOW, NOW)
      .run();
  }
  return db;
}

async function configure(
  db: CloudDb,
  tenantId = "tenant-a",
  monthlyTokenLimit = 100
): Promise<void> {
  await setCloudInferenceMonthlyBudget(db, { tenantId, monthlyTokenLimit, now: NOW });
  await setCloudInferenceEntitlement(db, {
    tenantId,
    provider: "openai",
    model: "gpt-4o-mini",
    enabled: true,
    maxInputTokens: 80,
    maxOutputTokens: 40,
    now: NOW,
  });
}

function reserve(
  db: CloudDb,
  options: Partial<Parameters<typeof reserveCloudInferenceTokens>[1]> = {}
) {
  return reserveCloudInferenceTokens(db, {
    tenantId: "tenant-a",
    reservationId: "request-0001",
    provider: "openai",
    model: "gpt-4o-mini",
    inputTokens: 30,
    maxOutputTokens: 20,
    now: NOW,
    ...options,
  });
}

test("cloud inference policy migration is idempotent and does not enable unconfigured access", async () => {
  const db = await makeDb();
  try {
    await db.exec(
      readFileSync(
        join(process.cwd(), "cloudflare/migrations/0010_cloud_inference_policy.sql"),
        "utf8"
      )
    );
    assert.equal(await getCloudInferenceEntitlement(db, "tenant-a", "openai", "gpt-4o-mini"), null);

    assert.deepEqual(
      await reserve(db),
      { kind: "denied" },
      "missing entitlement and budget deny by default"
    );
    await setCloudInferenceMonthlyBudget(db, {
      tenantId: "tenant-a",
      monthlyTokenLimit: 100,
      now: NOW,
    });
    assert.deepEqual(await reserve(db), { kind: "denied" }, "budget alone does not opt in a model");
    await setCloudInferenceEntitlement(db, {
      tenantId: "tenant-a",
      provider: "openai",
      model: "gpt-4o-mini",
      enabled: false,
      maxInputTokens: 80,
      maxOutputTokens: 40,
      now: NOW,
    });
    assert.deepEqual(await reserve(db), { kind: "denied" }, "disabled entitlements remain denied");
  } finally {
    db.db.close();
  }
});

test("reservations enforce both request caps and a tenant-wide monthly token budget", async () => {
  const db = await makeDb();
  try {
    await configure(db);
    assert.deepEqual(await reserve(db, { reservationId: "too-many-input", inputTokens: 81 }), {
      kind: "denied",
    });
    assert.deepEqual(await reserve(db, { reservationId: "too-many-output", maxOutputTokens: 41 }), {
      kind: "denied",
    });

    const accepted = await reserve(db);
    assert.equal(accepted.kind, "reserved");
    if (accepted.kind !== "reserved") return;
    assert.equal(accepted.reservation.tokensReserved, 50);
    const replay = await reserve(db);
    assert.equal(replay.kind, "replay");
    assert.equal(
      (await reserve(db, { inputTokens: 31 })).kind,
      "conflict",
      "the same tenant reservation ID cannot change its request"
    );

    const settled = await settleCloudInferenceReservation(db, {
      tenantId: "tenant-a",
      reservationId: "request-0001",
      actualInputTokens: 24,
      actualOutputTokens: 8,
      now: NOW,
    });
    assert.equal(settled.kind, "updated");
    assert.equal(
      (
        await settleCloudInferenceReservation(db, {
          tenantId: "tenant-a",
          reservationId: "request-0001",
          actualInputTokens: 24,
          actualOutputTokens: 8,
          now: NOW,
        })
      ).kind,
      "replay"
    );
    assert.equal(
      (
        await settleCloudInferenceReservation(db, {
          tenantId: "tenant-a",
          reservationId: "request-0001",
          actualInputTokens: 24,
          actualOutputTokens: 9,
          now: NOW,
        })
      ).kind,
      "conflict"
    );
    assert.equal(
      (
        await settleCloudInferenceReservation(db, {
          tenantId: "tenant-a",
          reservationId: "request-0001",
          actualInputTokens: 81,
          actualOutputTokens: 0,
          now: NOW,
        })
      ).kind,
      "conflict",
      "actual counts cannot exceed the pre-call caps"
    );

    assert.deepEqual(await getCloudInferenceBudgetStatus(db, "tenant-a", NOW), {
      tenantId: "tenant-a",
      monthUtc: "2026-10",
      monthlyTokenLimit: 100,
      reservedTokens: 0,
      settledTokens: 32,
      consumedTokens: 32,
      remainingTokens: 68,
    });
    assert.equal(
      (
        await reserve(db, {
          reservationId: "too-large-month",
          inputTokens: 80,
          maxOutputTokens: 21,
        })
      ).kind,
      "denied"
    );
  } finally {
    db.db.close();
  }
});

test("release is idempotent and returns reserved capacity without changing settled usage", async () => {
  const db = await makeDb();
  try {
    await configure(db, "tenant-a", 60);
    assert.equal((await reserve(db)).kind, "reserved");
    const released = await releaseCloudInferenceReservation(db, {
      tenantId: "tenant-a",
      reservationId: "request-0001",
      now: NOW,
    });
    assert.equal(released.kind, "updated");
    assert.equal(
      (
        await releaseCloudInferenceReservation(db, {
          tenantId: "tenant-a",
          reservationId: "request-0001",
          now: NOW,
        })
      ).kind,
      "replay"
    );
    assert.equal((await reserve(db, { reservationId: "request-0002" })).kind, "reserved");
    assert.equal(
      (
        await settleCloudInferenceReservation(db, {
          tenantId: "tenant-a",
          reservationId: "request-0001",
          actualInputTokens: 1,
          actualOutputTokens: 1,
          now: NOW,
        })
      ).kind,
      "conflict",
      "released reservations cannot be resurrected by settlement"
    );
  } finally {
    db.db.close();
  }
});

test("the conditional insert makes concurrent reservations respect one tenant budget", async () => {
  const db = await makeDb();
  try {
    await configure(db, "tenant-a", 100);
    const results = await Promise.all([
      reserve(db, { reservationId: "concurrent-0001", inputTokens: 40, maxOutputTokens: 20 }),
      reserve(db, { reservationId: "concurrent-0002", inputTokens: 40, maxOutputTokens: 20 }),
    ]);
    assert.equal(results.filter((result) => result.kind === "reserved").length, 1);
    assert.equal(results.filter((result) => result.kind === "denied").length, 1);
    assert.equal((await getCloudInferenceBudgetStatus(db, "tenant-a", NOW)).reservedTokens, 60);
  } finally {
    db.db.close();
  }
});

test("budgets, entitlements, reservations, and monthly totals are tenant and UTC-month scoped", async () => {
  const db = await makeDb();
  try {
    await configure(db, "tenant-a", 100);
    assert.equal((await reserve(db, { reservationId: "tenant-a-request" })).kind, "reserved");
    assert.deepEqual(
      await reserve(db, { tenantId: "tenant-b", reservationId: "tenant-a-request" }),
      {
        kind: "denied",
      }
    );
    assert.equal(
      (await getCloudInferenceBudgetStatus(db, "tenant-b", NOW)).monthlyTokenLimit,
      null
    );

    const november = "2026-11-01T00:00:00.000Z";
    assert.equal(
      (
        await reserve(db, {
          tenantId: "tenant-a",
          reservationId: "november-request",
          now: november,
        })
      ).kind,
      "reserved",
      "the next UTC month receives a fresh token allowance"
    );
    assert.equal(
      (
        await reserve(db, {
          tenantId: "tenant-a",
          reservationId: "tenant-a-request",
          now: november,
        })
      ).kind,
      "replay",
      "an old idempotency key replays its original month reservation instead of reserving twice"
    );
    assert.equal(
      (await getCloudInferenceBudgetStatus(db, "tenant-a", november)).reservedTokens,
      50
    );
  } finally {
    db.db.close();
  }
});

test("reservation retention honors month, age, active state, tombstone, and batch bounds", async () => {
  const db = await makeDb();
  try {
    await configure(db, "tenant-a", 1000);
    const september = "2026-09-01T12:00:00.000Z";
    const september2 = "2026-09-02T12:00:00.000Z";
    const september3 = "2026-09-03T12:00:00.000Z";
    const october = "2026-10-20T12:00:00.000Z";
    const november = "2026-11-05T12:00:00.000Z";
    const terminal = async (reservationId: string, at: string) => {
      assert.equal((await reserve(db, { reservationId, now: at })).kind, "reserved");
      assert.equal(
        (
          await settleCloudInferenceReservation(db, {
            tenantId: "tenant-a",
            reservationId,
            actualInputTokens: 8,
            actualOutputTokens: 3,
            now: at,
          })
        ).kind,
        "updated"
      );
    };
    await terminal("old-linked", september);
    await terminal("old-unlinked-a", september2);
    await terminal("old-unlinked-b", september3);
    await terminal("recent-old-month", october);
    assert.equal(
      (await reserve(db, { reservationId: "old-released", now: september3 })).kind,
      "reserved"
    );
    assert.equal(
      (
        await releaseCloudInferenceReservation(db, {
          tenantId: "tenant-a",
          reservationId: "old-released",
          now: september3,
        })
      ).kind,
      "updated"
    );
    assert.equal(
      (await reserve(db, { reservationId: "old-active", now: september })).kind,
      "reserved"
    );
    assert.equal(
      (await reserve(db, { reservationId: "current-month", now: november })).kind,
      "reserved"
    );
    assert.equal(
      (
        await settleCloudInferenceReservation(db, {
          tenantId: "tenant-a",
          reservationId: "current-month",
          actualInputTokens: 5,
          actualOutputTokens: 2,
          now: november,
        })
      ).kind,
      "updated"
    );

    const tombstoneCreated = Date.parse(september);
    await db
      .prepare(
        `INSERT INTO cloud_inference_idempotency (
      tenant_id, principal_id, api_key_id, idempotency_key_hash, request_hash, request_id,
      claim_token, state, claimed_at_ms, claim_expires_at_ms, response_expires_at_ms,
      response_status, response_body, created_at_ms, updated_at_ms, tombstone_expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'outcome_unavailable', ?, NULL, ?, NULL, NULL, ?, ?, ?)`
      )
      .bind(
        "tenant-a",
        "principal-a",
        "api-key-a",
        "a".repeat(64),
        "b".repeat(64),
        "old-linked",
        tombstoneCreated,
        tombstoneCreated,
        tombstoneCreated,
        tombstoneCreated,
        tombstoneCreated + 30 * 24 * 60 * 60 * 1000
      )
      .run();

    assert.equal(
      await cleanupSettledCloudInferenceReservations(db, { now: november, batchSize: 1 }),
      1
    );
    assert.ok(
      await db
        .prepare("SELECT 1 FROM cloud_inference_reservations WHERE reservation_id='old-linked'")
        .first()
    );
    assert.ok(
      await db
        .prepare(
          "SELECT 1 FROM cloud_inference_reservations WHERE reservation_id='recent-old-month'"
        )
        .first()
    );
    assert.ok(
      await db
        .prepare("SELECT 1 FROM cloud_inference_reservations WHERE reservation_id='current-month'")
        .first()
    );
    assert.ok(
      await db
        .prepare("SELECT 1 FROM cloud_inference_reservations WHERE reservation_id='old-active'")
        .first()
    );

    assert.equal(
      await cleanupExpiredCloudInferenceResponses(db, {
        nowMs: Date.parse(november),
        batchSize: 10,
      }),
      1,
      "the expired tombstone is removed first"
    );
    assert.equal(
      await cleanupSettledCloudInferenceReservations(db, { now: november, batchSize: 1 }),
      1
    );
    assert.equal(
      await cleanupSettledCloudInferenceReservations(db, { now: november, batchSize: 1 }),
      1
    );
    assert.equal(
      await cleanupSettledCloudInferenceReservations(db, { now: november, batchSize: 1 }),
      1
    );
    assert.equal(
      await cleanupSettledCloudInferenceReservations(db, { now: november, batchSize: 1 }),
      0
    );

    const retained = await db
      .prepare<{ reservation_id: string; status: string }>(
        "SELECT reservation_id,status FROM cloud_inference_reservations ORDER BY reservation_id"
      )
      .all();
    assert.deepEqual(
      retained.results.map((row) => [row.reservation_id, row.status]),
      [
        ["current-month", "settled"],
        ["old-active", "reserved"],
        ["recent-old-month", "settled"],
      ]
    );
    const budget = await getCloudInferenceBudgetStatus(db, "tenant-a", november);
    assert.equal(budget.reservedTokens, 0);
    assert.equal(budget.settledTokens, 7);
    assert.equal(
      (await reserve(db, { reservationId: "current-month", now: november })).kind,
      "replay",
      "current-month reservation IDs remain replayable after retention cleanup"
    );
  } finally {
    db.db.close();
  }
});

test("invalid limits and token counts are rejected before touching D1", async () => {
  const db = await makeDb();
  try {
    await assert.rejects(
      setCloudInferenceMonthlyBudget(db, { tenantId: "tenant-a", monthlyTokenLimit: -1, now: NOW }),
      /non-negative safe integer/
    );
    await assert.rejects(
      setCloudInferenceEntitlement(db, {
        tenantId: "tenant-a",
        provider: "openai",
        model: "gpt-4o-mini",
        enabled: true,
        maxInputTokens: Number.POSITIVE_INFINITY,
        maxOutputTokens: 10,
        now: NOW,
      }),
      /non-negative safe integer/
    );
    await assert.rejects(reserve(db, { inputTokens: 1.2 }), /non-negative safe integer/);
  } finally {
    db.db.close();
  }
});

test("entitlement listing rejects an unsuccessful D1 read", async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [], success: false };
        },
      };
    },
  } as unknown as CloudDb;

  await assert.rejects(listCloudInferenceEntitlements(db, "tenant-a"), {
    message: "D1 inference entitlements could not be read",
  });
});
