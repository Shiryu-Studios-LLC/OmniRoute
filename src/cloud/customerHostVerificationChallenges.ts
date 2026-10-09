import type { CloudDb } from "./db";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

/** Delete one bounded batch of expired customer-host DNS challenges. */
export async function cleanupExpiredCloudCustomerHostVerificationChallenges(
  db: CloudDb,
  nowMs = Date.now(),
  batchSize = DEFAULT_BATCH_SIZE
): Promise<number> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIMESTAMP_MS) {
    throw new RangeError(
      "nowMs must be a non-negative millisecond timestamp within the date range"
    );
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }

  const result = await db
    .prepare(
      `DELETE FROM cloud_customer_host_verification_challenges
        WHERE hostname IN (
          SELECT hostname FROM cloud_customer_host_verification_challenges
           WHERE expires_at_ms <= ?
           ORDER BY expires_at_ms, hostname
           LIMIT ?
        )`
    )
    .bind(nowMs, batchSize)
    .run();
  const changes = Number(result.meta?.changes ?? 0);
  if (!result.success || !Number.isSafeInteger(changes) || changes < 0 || changes > batchSize) {
    throw new Error("D1 customer-host challenge cleanup returned invalid state");
  }
  return changes;
}
