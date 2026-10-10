import type { CloudDb } from "./db";
import {
  appendCloudMaintenanceRun,
  cleanupExpiredCloudMaintenanceRuns,
  type CloudMaintenanceRunDetails,
  type CloudMaintenanceTaskKey,
} from "./maintenanceRunLedger";

export interface CloudMaintenanceTask {
  name: CloudMaintenanceTaskKey;
  run: () => Promise<unknown>;
}

function maintenanceDetails(value: unknown): CloudMaintenanceRunDetails | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const result = value as Partial<CloudMaintenanceRunDetails>;
  if (
    !Number.isSafeInteger(result.scanned) ||
    !Number.isSafeInteger(result.rewrapped) ||
    !Number.isSafeInteger(result.failed) ||
    !Number.isSafeInteger(result.conflicts) ||
    typeof result.hasMore !== "boolean"
  ) {
    return undefined;
  }
  return {
    scanned: result.scanned as number,
    rewrapped: result.rewrapped as number,
    failed: result.failed as number,
    conflicts: result.conflicts as number,
    hasMore: result.hasMore,
  };
}

export interface CloudMaintenanceLogger {
  error: (message: string, details: { task: string }) => void;
}

export interface CloudMaintenanceOptions {
  db?: CloudDb;
  now?: () => number;
}

/** Run every scheduled maintenance task and report failures with task-level context. */
export async function runCloudMaintenanceTasks(
  tasks: readonly CloudMaintenanceTask[],
  logger: CloudMaintenanceLogger = console,
  options: CloudMaintenanceOptions = {}
): Promise<void> {
  let ledgerFailureLogged = false;
  const outcomes = await Promise.all(
    tasks.map(async ({ name, run }) => {
      const startedAtMs = options.now?.() ?? Date.now();
      let failed = false;
      let details: CloudMaintenanceRunDetails | undefined;
      try {
        details = maintenanceDetails(await run());
      } catch {
        failed = true;
        logger.error("Cloud maintenance task failed", { task: name });
      }
      const finishedAtMs = options.now?.() ?? Date.now();
      if (options.db) {
        try {
          await appendCloudMaintenanceRun(options.db, {
            taskKey: name,
            startedAtMs,
            finishedAtMs,
            durationMs: Math.max(0, finishedAtMs - startedAtMs),
            outcome: failed ? "failed" : "succeeded",
            ...(details ? { details } : {}),
          });
        } catch {
          if (!ledgerFailureLogged) {
            ledgerFailureLogged = true;
            logger.error("Cloud maintenance telemetry write failed", { task: name });
          }
        }
      }
      return { name, failed };
    })
  );

  const failures = outcomes.filter((outcome) => outcome.failed).map((outcome) => outcome.name);
  if (options.db) {
    try {
      await cleanupExpiredCloudMaintenanceRuns(options.db, { nowMs: options.now?.() });
    } catch {
      if (!ledgerFailureLogged) {
        ledgerFailureLogged = true;
        logger.error("Cloud maintenance telemetry retention failed", {
          task: "expired-maintenance-runs",
        });
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Cloud maintenance tasks failed: ${failures.join(",")}`);
  }
}
