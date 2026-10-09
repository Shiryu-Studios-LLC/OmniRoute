import assert from "node:assert/strict";
import test from "node:test";
import { runCloudMaintenanceTasks } from "../../src/cloud/maintenance";

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
      name: "first",
      async run() {
        completed += 1;
      },
    },
    {
      name: "second",
      async run() {
        completed += 1;
      },
    },
  ]);
  assert.equal(completed, 2);
});
