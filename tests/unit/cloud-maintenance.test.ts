import assert from "node:assert/strict";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { runCloudMaintenanceTasks } from "../../src/cloud/maintenance";
import {
  cleanupExpiredCloudMaintenanceRuns,
  listCloudMaintenanceRuns,
} from "../../src/cloud/maintenanceRunLedger";

interface StoredRun {
  task: string;
  startedAt: number;
  finishedAt: number;
  duration: number;
  outcome: string;
}

class MaintenanceDb implements CloudDb {
  readonly runs: StoredRun[] = [];
  failWrites = false;
  failRetention = false;
  failReads = false;

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    let values: unknown[] = [];
    const statement: CloudDbStatement<T> = {
      bind(...bound) {
        values = bound;
        return statement;
      },
      async first<U = T>() {
        return null as U | null;
      },
      async all<U = T>() {
        if (thisDb.failReads) {
          return { results: [] as U[], success: false };
        }
        return { results: [] as U[], success: true };
      },
      async run() {
        if (thisDb.failWrites) throw new Error("sensitive D1 binding details");
        if (sql.includes("INSERT INTO cloud_maintenance_runs")) {
          thisDb.runs.push({
            task: String(values[0]),
            startedAt: Number(values[1]),
            finishedAt: Number(values[2]),
            duration: Number(values[3]),
            outcome: String(values[4]),
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM cloud_maintenance_runs")) {
          if (thisDb.failRetention) throw new Error("sensitive D1 retention details");
          const cutoff = Number(values[0]);
          const limit = Number(values[1]);
          const expired = thisDb.runs
            .filter((run) => run.finishedAt < cutoff)
            .sort((a, b) => a.finishedAt - b.finishedAt)
            .slice(0, limit);
          for (const run of expired) {
            thisDb.runs.splice(thisDb.runs.indexOf(run), 1);
          }
          return { success: true, meta: { changes: expired.length } };
        }
        throw new Error("Unexpected maintenance test query");
      },
    };
    const thisDb = this;
    return statement;
  }

  async batch(): Promise<unknown[]> {
    return [];
  }

  async exec(): Promise<unknown> {
    return undefined;
  }
}

test("cloud maintenance reports task-level failures without exposing exception details", async () => {
  const completed: string[] = [];
  const logs: Array<{ message: string; task: string }> = [];

  await assert.rejects(
    runCloudMaintenanceTasks(
      [
        {
          name: "expired-rate-limits",
          async run() {
            completed.push("expired-rate-limits");
          },
        },
        {
          name: "stale-inference-reservations",
          async run() {
            completed.push("stale-inference-reservations");
            throw new Error("sensitive D1 query and binding details");
          },
        },
        {
          name: "expired-oidc-artifacts",
          async run() {
            completed.push("expired-oidc-artifacts");
          },
        },
      ],
      {
        error(message, details) {
          logs.push({ message, task: details.task });
        },
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Cloud maintenance tasks failed: stale-inference-reservations");
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    }
  );

  assert.deepEqual(completed, [
    "expired-rate-limits",
    "stale-inference-reservations",
    "expired-oidc-artifacts",
  ]);
  assert.deepEqual(logs, [
    { message: "Cloud maintenance task failed", task: "stale-inference-reservations" },
  ]);
});

test("cloud maintenance resolves when all cleanup tasks succeed", async () => {
  let completed = 0;
  await runCloudMaintenanceTasks([
    {
      name: "expired-rate-limits",
      async run() {
        completed += 1;
      },
    },
    {
      name: "expired-gateway-pairings",
      async run() {
        completed += 1;
      },
    },
  ]);
  assert.equal(completed, 2);
});

test("maintenance ledger records only static outcomes and bounded retention deletes an ordered batch", async () => {
  const db = new MaintenanceDb();
  for (const finishedAtMs of [1_000, 2_000, 8_000]) {
    await runCloudMaintenanceTasks(
      [
        {
          name: "expired-rate-limits",
          async run() {},
        },
      ],
      { error() {} },
      {
        db,
        now: () => finishedAtMs,
      }
    );
  }

  assert.deepEqual(db.runs, [
    {
      task: "expired-rate-limits",
      startedAt: 1_000,
      finishedAt: 1_000,
      duration: 0,
      outcome: "succeeded",
    },
    {
      task: "expired-rate-limits",
      startedAt: 2_000,
      finishedAt: 2_000,
      duration: 0,
      outcome: "succeeded",
    },
    {
      task: "expired-rate-limits",
      startedAt: 8_000,
      finishedAt: 8_000,
      duration: 0,
      outcome: "succeeded",
    },
  ]);

  const deleted = await cleanupExpiredCloudMaintenanceRuns(db, {
    nowMs: 10_000,
    retentionMs: 5_000,
    batchSize: 1,
  });
  assert.equal(deleted, 1);
  assert.deepEqual(
    db.runs.map((run) => run.finishedAt),
    [2_000, 8_000]
  );
});

test("maintenance ledger records task failures without storing exception details", async () => {
  const db = new MaintenanceDb();
  await assert.rejects(
    runCloudMaintenanceTasks(
      [
        {
          name: "expired-gateway-pairings",
          async run() {
            throw new Error("endpoint secret and request data");
          },
        },
      ],
      { error() {} },
      { db, now: () => 7_000 }
    ),
    /Cloud maintenance tasks failed: expired-gateway-pairings/
  );
  assert.deepEqual(db.runs, [
    {
      task: "expired-gateway-pairings",
      startedAt: 7_000,
      finishedAt: 7_000,
      duration: 0,
      outcome: "failed",
    },
  ]);
  assert.equal(JSON.stringify(db.runs).includes("endpoint"), false);
});

test("maintenance ledger storage failures do not prevent tasks or hide cleanup failures", async () => {
  const db = new MaintenanceDb();
  db.failWrites = true;
  const completed: string[] = [];
  const logs: Array<{ message: string; task: string }> = [];
  let timestamp = 5_000;

  await assert.rejects(
    runCloudMaintenanceTasks(
      [
        {
          name: "expired-rate-limits",
          async run() {
            completed.push("expired-rate-limits");
          },
        },
        {
          name: "stale-inference-reservations",
          async run() {
            completed.push("stale-inference-reservations");
            throw new Error("sensitive cleanup error");
          },
        },
      ],
      {
        error(message, details) {
          logs.push({ message, task: details.task });
        },
      },
      { db, now: () => timestamp++ }
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Cloud maintenance tasks failed: stale-inference-reservations");
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    }
  );

  assert.deepEqual(completed, ["expired-rate-limits", "stale-inference-reservations"]);
  assert.equal(
    logs.some(({ message }) => message === "Cloud maintenance telemetry write failed"),
    true
  );
  assert.equal(
    logs.some(({ message }) => message.includes("sensitive")),
    false
  );
});

test("maintenance retention failure is logged without hiding task failures", async () => {
  const db = new MaintenanceDb();
  db.failRetention = true;
  const completed: string[] = [];
  const logs: Array<{ message: string; task: string }> = [];

  await assert.rejects(
    runCloudMaintenanceTasks(
      [
        {
          name: "expired-rate-limits",
          async run() {
            completed.push("expired-rate-limits");
          },
        },
        {
          name: "stale-inference-reservations",
          async run() {
            completed.push("stale-inference-reservations");
            throw new Error("sensitive cleanup query details");
          },
        },
      ],
      {
        error(message, details) {
          logs.push({ message, task: details.task });
        },
      },
      { db, now: () => 40 * 24 * 60 * 60 * 1000 }
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Cloud maintenance tasks failed: stale-inference-reservations");
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    }
  );

  assert.deepEqual(completed, ["expired-rate-limits", "stale-inference-reservations"]);
  assert.deepEqual(
    db.runs.map(({ task, outcome }) => ({ task, outcome })),
    [
      { task: "expired-rate-limits", outcome: "succeeded" },
      { task: "stale-inference-reservations", outcome: "failed" },
    ]
  );
  assert.deepEqual(logs, [
    { message: "Cloud maintenance task failed", task: "stale-inference-reservations" },
    { message: "Cloud maintenance telemetry retention failed", task: "expired-maintenance-runs" },
  ]);
  assert.equal(JSON.stringify(logs).includes("sensitive"), false);
});

test("maintenance history read fails closed when D1 reports an unsuccessful query", async () => {
  const db = new MaintenanceDb();
  db.failReads = true;

  await assert.rejects(listCloudMaintenanceRuns(db, 10), {
    message: "D1 maintenance telemetry read failed",
  });
});
