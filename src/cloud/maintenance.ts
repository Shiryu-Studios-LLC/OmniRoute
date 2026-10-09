export interface CloudMaintenanceTask {
  name: string;
  run: () => Promise<unknown>;
}

export interface CloudMaintenanceLogger {
  error: (message: string, details: { task: string }) => void;
}

/** Run every scheduled maintenance task and report failures with task-level context. */
export async function runCloudMaintenanceTasks(
  tasks: readonly CloudMaintenanceTask[],
  logger: CloudMaintenanceLogger = console
): Promise<void> {
  const outcomes = await Promise.all(
    tasks.map(async ({ name, run }) => {
      try {
        await run();
        return { name, failed: false };
      } catch {
        logger.error("Cloud maintenance task failed", { task: name });
        return { name, failed: true };
      }
    })
  );

  const failures = outcomes.filter((outcome) => outcome.failed).map((outcome) => outcome.name);
  if (failures.length > 0) {
    throw new Error(`Cloud maintenance tasks failed: ${failures.join(",")}`);
  }
}
