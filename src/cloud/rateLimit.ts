import type { CloudDb } from "./db";

export interface CloudRateLimitInput {
  tenantId: string;
  /** Stable logical bucket label or identifier; the raw value is never stored. */
  bucketKey: string;
  limit: number;
  windowMs: number;
  /** Deterministic unit-test clock override; omit in production. */
  nowMs?: number;
}

export interface CloudRateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  windowStartedAtMs: number;
  resetAtMs: number;
}

interface RateLimitRow extends Record<string, unknown> {
  request_count: number;
  window_started_at_ms: number;
  window_ms: number;
  limit_count: number;
}

const MAX_LIMIT = 1_000_000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BUCKET_KEY_LENGTH = 512;
export const CLOUD_RATE_LIMIT_RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_RATE_LIMIT_CLEANUP_BATCH_SIZE = 1_000;

/** Read the visitor address only on Workers requests carrying edge `cf` metadata. */
export function cloudflareClientIpBucket(request: Request): string | null {
  const workerMetadata = (request as Request & { cf?: unknown }).cf;
  if (!workerMetadata || typeof workerMetadata !== "object") return null;
  const address = request.headers.get("cf-connecting-ip")?.trim();
  if (!address || address.length > 45 || !/^[A-Fa-f0-9:.]+$/.test(address)) return null;
  return `cloudflare-ip:${address.toLowerCase()}`;
}

function requireTenantId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError("tenantId must be a 1–128 character identifier");
  }
  return value;
}

async function hashBucketKey(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Atomically consumes one request from a tenant-specific D1 window.
 *
 * There is deliberately no process-local fallback: callers fail if D1 cannot
 * perform the upsert. Use low-cardinality logical bucket keys rather than raw
 * credentials; the key is hashed before it is persisted in D1.
 */
export async function consumeCloudRateLimit(
  db: CloudDb,
  input: CloudRateLimitInput
): Promise<CloudRateLimitResult> {
  const tenantId = requireTenantId(input.tenantId);
  if (
    typeof input.bucketKey !== "string" ||
    input.bucketKey.length < 1 ||
    input.bucketKey.length > MAX_BUCKET_KEY_LENGTH
  ) {
    throw new TypeError(`bucketKey must contain 1–${MAX_BUCKET_KEY_LENGTH} characters`);
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (!Number.isInteger(input.windowMs) || input.windowMs < 1 || input.windowMs > MAX_WINDOW_MS) {
    throw new RangeError(`windowMs must be an integer between 1 and ${MAX_WINDOW_MS}`);
  }
  if (
    input.nowMs !== undefined &&
    (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0 || input.nowMs > 8_640_000_000_000_000)
  ) {
    throw new RangeError(
      "nowMs must be a non-negative millisecond timestamp within the date range"
    );
  }
  const bucketHash = await hashBucketKey(input.bucketKey);
  const clock =
    input.nowMs === undefined ? "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)" : "?";
  const values: unknown[] = [tenantId, bucketHash];
  if (input.nowMs !== undefined) values.push(input.nowMs);
  values.push(input.windowMs, input.limit);
  if (input.nowMs !== undefined) values.push(input.nowMs, input.nowMs, input.nowMs);

  const result = await db
    .prepare(
      `INSERT INTO cloud_rate_limits (
        tenant_id, bucket_hash, window_started_at_ms, window_ms, limit_count, request_count, updated_at
      ) VALUES (?, ?, ${clock}, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (tenant_id, bucket_hash) DO UPDATE SET
        window_started_at_ms = CASE
          WHEN window_ms <> excluded.window_ms
            OR limit_count <> excluded.limit_count
            OR ${clock} - window_started_at_ms >= window_ms
          THEN ${clock} ELSE window_started_at_ms END,
        window_ms = excluded.window_ms,
        limit_count = excluded.limit_count,
        request_count = CASE
          WHEN window_ms <> excluded.window_ms
            OR limit_count <> excluded.limit_count
            OR ${clock} - window_started_at_ms >= window_ms
          THEN 1 ELSE MIN(request_count + 1, excluded.limit_count + 1) END,
        updated_at = excluded.updated_at
      RETURNING request_count, window_started_at_ms, window_ms, limit_count`
    )
    .bind(...values)
    .all<RateLimitRow>();

  const row = result.results[0];
  if (!row) throw new Error("D1 rate-limit upsert returned no row");
  const count = Number(row.request_count);
  const windowStartedAtMs = Number(row.window_started_at_ms);
  const limit = Number(row.limit_count);
  const windowMs = Number(row.window_ms);
  if (![count, windowStartedAtMs, limit, windowMs].every(Number.isSafeInteger)) {
    throw new Error("D1 rate-limit upsert returned invalid state");
  }
  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    windowStartedAtMs,
    resetAtMs: windowStartedAtMs + windowMs,
  };
}

/**
 * Delete a bounded batch of rate-limit buckets whose windows ended at least
 * one grace period ago. Ordering and filtering use the indexed window end,
 * so short windows can be reclaimed after the grace period without scanning
 * every long-window bucket.
 */
export async function cleanupExpiredCloudRateLimits(
  db: CloudDb,
  options: { nowMs?: number; batchSize?: number; retentionMs?: number } = {}
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const batchSize = options.batchSize ?? 500;
  const retentionMs = options.retentionMs ?? CLOUD_RATE_LIMIT_RETENTION_GRACE_MS;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000) {
    throw new RangeError(
      "nowMs must be a non-negative millisecond timestamp within the date range"
    );
  }
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_RATE_LIMIT_CLEANUP_BATCH_SIZE
  ) {
    throw new RangeError(
      `batchSize must be an integer between 1 and ${MAX_RATE_LIMIT_CLEANUP_BATCH_SIZE}`
    );
  }
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0 || retentionMs > MAX_WINDOW_MS) {
    throw new RangeError(`retentionMs must be an integer between 0 and ${MAX_WINDOW_MS}`);
  }
  const staleBeforeMs = nowMs - retentionMs;
  if (staleBeforeMs <= 0) return 0;

  const result = await db
    .prepare(
      `DELETE FROM cloud_rate_limits
        WHERE rowid IN (
          SELECT rowid FROM cloud_rate_limits
           WHERE window_started_at_ms + window_ms <= ?
           ORDER BY window_started_at_ms + window_ms, tenant_id, bucket_hash
           LIMIT ?
        )`
    )
    .bind(staleBeforeMs, batchSize)
    .run();
  const changes = Number(result.meta?.changes ?? 0);
  if (!result.success || !Number.isSafeInteger(changes) || changes < 0 || changes > batchSize) {
    throw new Error("D1 rate-limit cleanup returned invalid state");
  }
  return changes;
}
