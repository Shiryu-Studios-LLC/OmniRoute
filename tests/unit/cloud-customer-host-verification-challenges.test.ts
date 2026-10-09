import assert from "node:assert/strict";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { cleanupExpiredCloudCustomerHostVerificationChallenges } from "../../src/cloud/customerHostVerificationChallenges";

interface Challenge {
  hostname: string;
  expiresAtMs: number;
}

class ChallengeCleanupDb implements CloudDb {
  readonly challenges: Challenge[] = [
    { hostname: "expired-b.example", expiresAtMs: 99 },
    { hostname: "boundary.example", expiresAtMs: 100 },
    { hostname: "future.example", expiresAtMs: 101 },
  ];
  lastQuery?: string;
  lastBindings: unknown[] = [];
  failDelete = false;

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    this.lastQuery = sql;
    const database = this;
    const statement: CloudDbStatement<T> = {
      bind(...values) {
        database.lastBindings = values;
        return statement;
      },
      async first<U = T>() {
        return null as U | null;
      },
      async all<U = T>() {
        return { results: [] as U[], success: true };
      },
      async run() {
        if (database.failDelete) return { success: false, meta: { changes: 0 } };
        const [nowMs, batchSize] = database.lastBindings.map(Number);
        const expired = database.challenges
          .filter((challenge) => challenge.expiresAtMs <= nowMs)
          .sort(
            (left, right) =>
              left.expiresAtMs - right.expiresAtMs || left.hostname.localeCompare(right.hostname)
          )
          .slice(0, batchSize);
        for (const challenge of expired) {
          database.challenges.splice(database.challenges.indexOf(challenge), 1);
        }
        return { success: true, meta: { changes: expired.length } };
      },
    };
    return statement;
  }

  async batch(): Promise<unknown[]> {
    return [];
  }

  async exec(): Promise<unknown> {
    return undefined;
  }
}

test("expired customer-host challenge cleanup is bounded and includes the expiry boundary", async () => {
  const db = new ChallengeCleanupDb();
  const deleted = await cleanupExpiredCloudCustomerHostVerificationChallenges(db, 100, 1);

  assert.equal(deleted, 1);
  assert.deepEqual(db.lastBindings, [100, 1]);
  assert.match(db.lastQuery ?? "", /expires_at_ms <= \?/);
  assert.match(db.lastQuery ?? "", /ORDER BY expires_at_ms, hostname[\s\S]*LIMIT \?/);
  assert.deepEqual(
    db.challenges.map(({ hostname }) => hostname),
    ["boundary.example", "future.example"]
  );
  assert.equal(await cleanupExpiredCloudCustomerHostVerificationChallenges(db, 100, 10), 1);
  assert.deepEqual(
    db.challenges.map(({ hostname }) => hostname),
    ["future.example"]
  );
});

test("expired customer-host challenge cleanup validates bounds and reports D1 failures", async () => {
  const db = new ChallengeCleanupDb();
  await assert.rejects(
    cleanupExpiredCloudCustomerHostVerificationChallenges(db, 100, 0),
    /batchSize/
  );
  await assert.rejects(cleanupExpiredCloudCustomerHostVerificationChallenges(db, -1), /nowMs/);
  db.failDelete = true;
  await assert.rejects(
    cleanupExpiredCloudCustomerHostVerificationChallenges(db, 100),
    /cleanup returned invalid state/
  );
});
