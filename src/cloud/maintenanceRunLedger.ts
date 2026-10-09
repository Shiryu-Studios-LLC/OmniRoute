import type { CloudDb } from "./db";

export const CLOUD_MAINTENANCE_TASK_KEYS = [
  "expired-rate-limits",
  "expired-gateway-pairings",
  "stale-inference-reservations",
  "settled-inference-reservations",
  "expired-inference-responses",
  "expired-oidc-artifacts",
] as const;

export type CloudMaintenanceTaskKey = (typeof CLOUD_MAINTENANCE_TASK_KEYS)[number];
export type CloudMaintenanceOutcome = "succeeded" | "failed";

export interface CloudMaintenanceRunRecord {
  id: number;
  taskKey: CloudMaintenanceTaskKey;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  outcome: CloudMaintenanceOutcome;
}

export interface CloudMaintenanceRunInput {
  taskKey: CloudMaintenanceTaskKey;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  outcome: CloudMaintenanceOutcome;
}

const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;
export const CLOUD_MAINTENANCE_RUNS_MAX_PAGE_SIZE = 100;

function validateRun(input: CloudMaintenanceRunInput): CloudMaintenanceRunInput {
  if (!(CLOUD_MAINTENANCE_TASK_KEYS as readonly string[]).includes(input.taskKey)) {
    throw new TypeError("taskKey must be a known cloud maintenance task");
  }
  for (const [label, value] of [
    ["startedAtMs", input.startedAtMs],
    ["finishedAtMs", input.finishedAtMs],
    ["durationMs", input.durationMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
      throw new RangeError(`${label} must be a non-negative safe integer`);
    }
  }
  if (input.finishedAtMs < input.startedAtMs || input.durationMs > MAX_TIMESTAMP_MS) {
    throw new RangeError("maintenance run timing is invalid");
  }
  if (input.outcome !== "succeeded" && input.outcome !== "failed") {
    throw new TypeError("outcome must be succeeded or failed");
  }
  return input;
}

/** Persist bounded, low-cardinality task status without exception or request data. */
export async function appendCloudMaintenanceRun(
  db: CloudDb,
  input: CloudMaintenanceRunInput
): Promise<void> {
  const run = validateRun(input);
  const result = await db
    .prepare(
      `INSERT INTO cloud_maintenance_runs (
        task_key, started_at_ms, finished_at_ms, duration_ms, outcome
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(run.taskKey, run.startedAtMs, run.finishedAtMs, run.durationMs, run.outcome)
    .run();
  if (!result.success) throw new Error("D1 maintenance telemetry write failed");
}

/** Delete at most one bounded batch of maintenance records older than the retention window. */
export async function cleanupExpiredCloudMaintenanceRuns(
  db: CloudDb,
  options: { nowMs?: number; batchSize?: number; retentionMs?: number } = {}
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIMESTAMP_MS) {
    throw new RangeError(
      "nowMs must be a non-negative millisecond timestamp within the date range"
    );
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0 || retentionMs > MAX_TIMESTAMP_MS) {
    throw new RangeError("retentionMs must be a non-negative safe integer");
  }
  const staleBeforeMs = nowMs - retentionMs;
  if (staleBeforeMs <= 0) return 0;

  const result = await db
    .prepare(
      `DELETE FROM cloud_maintenance_runs
        WHERE id IN (
          SELECT id FROM cloud_maintenance_runs
           WHERE finished_at_ms < ?
           ORDER BY finished_at_ms, id
           LIMIT ?
        )`
    )
    .bind(staleBeforeMs, batchSize)
    .run();
  const changes = Number(result.meta?.changes ?? 0);
  if (!result.success || !Number.isSafeInteger(changes) || changes < 0 || changes > batchSize) {
    throw new Error("D1 maintenance retention cleanup returned invalid state");
  }
  return changes;
}

/** Read only a small, bounded page of operational run metadata. */
export async function listCloudMaintenanceRuns(
  db: CloudDb,
  limit = 50
): Promise<CloudMaintenanceRunRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > CLOUD_MAINTENANCE_RUNS_MAX_PAGE_SIZE) {
    throw new RangeError(
      `limit must be an integer between 1 and ${CLOUD_MAINTENANCE_RUNS_MAX_PAGE_SIZE}`
    );
  }
  const result = await db
    .prepare<{
      id: number;
      task_key: CloudMaintenanceTaskKey;
      started_at_ms: number;
      finished_at_ms: number;
      duration_ms: number;
      outcome: CloudMaintenanceOutcome;
    }>(
      `SELECT id, task_key, started_at_ms, finished_at_ms, duration_ms, outcome
         FROM cloud_maintenance_runs
        ORDER BY finished_at_ms DESC, id DESC
        LIMIT ?`
    )
    .bind(limit)
    .all();
  if (!result.success) throw new Error("D1 maintenance telemetry read failed");
  return result.results.map((row) => ({
    id: row.id,
    taskKey: row.task_key,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    durationMs: row.duration_ms,
    outcome: row.outcome,
  }));
}
