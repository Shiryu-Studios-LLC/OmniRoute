import type { CloudDb } from "./db";
import { CLOUD_IMAGE_MAX_ARTIFACT_BYTES } from "../shared/imageJobContract";

export const CLOUD_IMAGE_JOB_TIMEOUT_MS = 5 * 60_000;
export const CLOUD_IMAGE_JOB_RETENTION_MS = 24 * 60 * 60_000;

const CLOUD_IMAGE_JOB_CAPACITY_ERRORS = new Set([
  "gateway image job tenant capacity reached",
  "gateway image job device capacity reached",
  "gateway image job tenant retention capacity reached",
  "gateway image job global retention capacity reached",
]);

/** Capacity triggers are expected admission failures; other D1 errors indicate service failure. */
export function isCloudImageJobCapacityError(error: unknown): boolean {
  return error instanceof Error && CLOUD_IMAGE_JOB_CAPACITY_ERRORS.has(error.message);
}

export type CloudImageJobState =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

export type CloudImageJobFailureCode =
  | "execution_failed"
  | "capability_unavailable"
  | "artifact_upload_failed"
  | "cancelled"
  | "expired";

export interface CloudImageJob {
  jobId: string;
  tenantId: string;
  principalId: string;
  apiKeyId: string;
  deviceId: string;
  sessionId: string;
  requestId: string;
  idempotencyHash: string;
  fingerprintHash: string;
  state: CloudImageJobState;
  objectKey: string;
  artifactContentType: string | null;
  artifactBytes: number | null;
  artifactSha256: string | null;
  promptId: string | null;
  errorCode: CloudImageJobFailureCode | null;
  createdAt: string;
  expiresAt: string;
  retentionExpiresAt: string;
  completedAt: string | null;
}

interface CloudImageJobRow {
  job_id: string;
  tenant_id: string;
  principal_id: string;
  api_key_id: string;
  device_id: string;
  session_id: string;
  request_id: string;
  idempotency_hash: string;
  fingerprint_hash: string;
  state: CloudImageJobState;
  object_key: string;
  artifact_content_type: string | null;
  artifact_bytes: number | null;
  artifact_sha256: string | null;
  prompt_id: string | null;
  error_code: CloudImageJobFailureCode | null;
  created_at: string;
  expires_at: string;
  retention_expires_at: string;
  completed_at: string | null;
}

function mapRow(row: CloudImageJobRow): CloudImageJob {
  return {
    jobId: row.job_id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    apiKeyId: row.api_key_id,
    deviceId: row.device_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    idempotencyHash: row.idempotency_hash,
    fingerprintHash: row.fingerprint_hash,
    state: row.state,
    objectKey: row.object_key,
    artifactContentType: row.artifact_content_type,
    artifactBytes: row.artifact_bytes,
    artifactSha256: row.artifact_sha256,
    promptId: row.prompt_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    retentionExpiresAt: row.retention_expires_at,
    completedAt: row.completed_at,
  };
}

export interface NewCloudImageJob {
  jobId: string;
  tenantId: string;
  principalId: string;
  apiKeyId: string;
  deviceId: string;
  sessionId: string;
  idempotencyHash: string;
  fingerprintHash: string;
  objectKey: string;
  createdAt: string;
  expiresAt: string;
  retentionExpiresAt: string;
}

/** Inserts a tenant-owned job subject to migration-enforced concurrency and retention caps. */
export async function createCloudImageJob(
  db: CloudDb,
  input: NewCloudImageJob
): Promise<{ created: boolean; job: CloudImageJob | null }> {
  await expireStaleCloudImageJobs(db, input.createdAt, 500);
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO cloud_gateway_image_jobs (
         job_id, tenant_id, principal_id, api_key_id, device_id, session_id,
         request_id, idempotency_hash, fingerprint_hash, state, object_key,
         created_at, expires_at, retention_expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
    )
    .bind(
      input.jobId,
      input.tenantId,
      input.principalId,
      input.apiKeyId,
      input.deviceId,
      input.sessionId,
      input.jobId,
      input.idempotencyHash,
      input.fingerprintHash,
      input.objectKey,
      input.createdAt,
      input.expiresAt,
      input.retentionExpiresAt
    )
    .run();
  const changes = insert.meta?.changes;
  if (
    !insert.success ||
    typeof changes !== "number" ||
    !Number.isSafeInteger(changes) ||
    changes < 0 ||
    changes > 1
  ) {
    throw new Error("D1 gateway image-job insert failed");
  }
  const job = await getCloudImageJobByIdempotencyHash(db, input.idempotencyHash);
  return { created: job?.jobId === input.jobId, job };
}

/** Release active concurrency slots for timed-out generations in a bounded pass. */
export async function expireStaleCloudImageJobs(
  db: CloudDb,
  now: string,
  limit = 500
): Promise<number> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(500, Math.max(1, limit)) : 500;
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_image_jobs
          SET state = 'expired', error_code = 'expired', completed_at = ?
        WHERE job_id IN (
          SELECT job_id FROM cloud_gateway_image_jobs
           WHERE state IN ('queued', 'running') AND expires_at <= ?
           ORDER BY expires_at LIMIT ?
        )`
    )
    .bind(now, now, boundedLimit)
    .run();
  const changes = result.meta?.changes;
  if (
    !result.success ||
    typeof changes !== "number" ||
    !Number.isSafeInteger(changes) ||
    changes < 0 ||
    changes > boundedLimit
  ) {
    throw new Error("D1 gateway image-job expiry returned invalid state");
  }
  return changes;
}

export async function getCloudImageJob(db: CloudDb, jobId: string): Promise<CloudImageJob | null> {
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) return null;
  const row = await db
    .prepare<CloudImageJobRow>("SELECT * FROM cloud_gateway_image_jobs WHERE job_id = ? LIMIT 1")
    .bind(jobId)
    .first();
  return row ? mapRow(row) : null;
}

export async function getCloudImageJobByIdempotencyHash(
  db: CloudDb,
  hash: string
): Promise<CloudImageJob | null> {
  const row = await db
    .prepare<CloudImageJobRow>(
      "SELECT * FROM cloud_gateway_image_jobs WHERE idempotency_hash = ? LIMIT 1"
    )
    .bind(hash)
    .first();
  return row ? mapRow(row) : null;
}

export async function markCloudImageJobRunning(
  db: CloudDb,
  jobId: string,
  sessionId: string,
  now: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_image_jobs
          SET state = 'running'
        WHERE job_id = ? AND session_id = ? AND state = 'queued' AND expires_at > ?`
    )
    .bind(jobId, sessionId, now)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function cancelCloudImageJob(
  db: CloudDb,
  jobId: string,
  identity: { tenantId: string; principalId: string; apiKeyId: string },
  now: string
): Promise<CloudImageJob | null> {
  await db
    .prepare(
      `UPDATE cloud_gateway_image_jobs
          SET state = 'cancelled', error_code = 'cancelled', completed_at = ?
        WHERE job_id = ? AND tenant_id = ? AND principal_id = ? AND api_key_id = ?
          AND state IN ('queued', 'running') AND expires_at > ?`
    )
    .bind(now, jobId, identity.tenantId, identity.principalId, identity.apiKeyId, now)
    .run();
  return getCloudImageJob(db, jobId);
}

/** Expires active jobs lazily so reads and control checks are authoritative without a timer. */
export async function expireCloudImageJobIfNeeded(
  db: CloudDb,
  job: CloudImageJob,
  now: string
): Promise<CloudImageJob> {
  if ((job.state !== "queued" && job.state !== "running") || job.expiresAt > now) return job;
  await db
    .prepare(
      `UPDATE cloud_gateway_image_jobs
          SET state = 'expired', error_code = 'expired', completed_at = ?
        WHERE job_id = ? AND state IN ('queued', 'running') AND expires_at <= ?`
    )
    .bind(now, job.jobId, now)
    .run();
  return (await getCloudImageJob(db, job.jobId)) ?? job;
}

export async function attachCloudImageArtifact(
  db: CloudDb,
  input: {
    jobId: string;
    sessionId: string;
    uploadToken: string;
    contentType: "image/png" | "image/jpeg" | "image/webp";
    bytes: number;
    sha256: string;
    now: string;
  }
): Promise<boolean> {
  if (
    input.bytes < 1 ||
    input.bytes > CLOUD_IMAGE_MAX_ARTIFACT_BYTES ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  )
    return false;
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_image_jobs
          SET artifact_content_type = ?, artifact_bytes = ?, artifact_sha256 = ?,
              artifact_upload_token = NULL
        WHERE job_id = ? AND session_id = ? AND state IN ('queued', 'running')
          AND expires_at > ? AND artifact_bytes IS NULL AND artifact_upload_token = ?`
    )
    .bind(
      input.contentType,
      input.bytes,
      input.sha256,
      input.jobId,
      input.sessionId,
      input.now,
      input.uploadToken
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function reserveCloudImageArtifactUpload(
  db: CloudDb,
  input: { jobId: string; sessionId: string; uploadToken: string; now: string }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_image_jobs
          SET artifact_upload_token = ?
        WHERE job_id = ? AND session_id = ? AND state IN ('queued', 'running')
          AND expires_at > ? AND artifact_bytes IS NULL AND artifact_upload_token IS NULL`
    )
    .bind(input.uploadToken, input.jobId, input.sessionId, input.now)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function releaseCloudImageArtifactUpload(
  db: CloudDb,
  jobId: string,
  uploadToken: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE cloud_gateway_image_jobs SET artifact_upload_token = NULL
        WHERE job_id = ? AND artifact_upload_token = ? AND artifact_bytes IS NULL`
    )
    .bind(jobId, uploadToken)
    .run();
}

export async function completeCloudImageJob(
  db: CloudDb,
  input: { jobId: string; sessionId: string; promptId: string; now: string }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_image_jobs
          SET state = 'succeeded', prompt_id = ?, completed_at = ?
        WHERE job_id = ? AND session_id = ? AND state IN ('queued', 'running')
          AND expires_at > ? AND artifact_bytes IS NOT NULL`
    )
    .bind(input.promptId, input.now, input.jobId, input.sessionId, input.now)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function failCloudImageJob(
  db: CloudDb,
  input: {
    jobId: string;
    sessionId: string;
    code: CloudImageJobFailureCode;
    now: string;
  }
): Promise<boolean> {
  if (
    !new Set<CloudImageJobFailureCode>([
      "execution_failed",
      "capability_unavailable",
      "artifact_upload_failed",
      "cancelled",
      "expired",
    ]).has(input.code)
  )
    return false;
  const state =
    input.code === "cancelled" ? "cancelled" : input.code === "expired" ? "expired" : "failed";
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_image_jobs
          SET state = ?, error_code = ?, completed_at = ?
        WHERE job_id = ? AND session_id = ? AND state IN ('queued', 'running')
          AND ((? = 'expired' AND expires_at <= ?) OR (? <> 'expired' AND expires_at > ?))`
    )
    .bind(
      state,
      input.code,
      input.now,
      input.jobId,
      input.sessionId,
      input.code,
      input.now,
      input.code,
      input.now
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export interface GatewayImageArtifactBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<unknown | null>;
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array> | null;
    size?: number;
    httpEtag?: string;
    httpMetadata?: { contentType?: string };
  } | null>;
  delete(key: string | string[]): Promise<void>;
}

/** Delete expired artifact objects and metadata in bounded batches; safe to rerun. */
export async function cleanupExpiredCloudImageJobs(
  db: CloudDb,
  bucket: GatewayImageArtifactBucket,
  now = new Date().toISOString(),
  limit = 100
): Promise<number> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(500, Math.max(1, limit)) : 100;
  await expireStaleCloudImageJobs(db, now, boundedLimit);
  const rows = await db
    .prepare<{ job_id: string; object_key: string }>(
      `SELECT job_id, object_key FROM cloud_gateway_image_jobs
        WHERE retention_expires_at <= ? ORDER BY retention_expires_at LIMIT ?`
    )
    .bind(now, boundedLimit)
    .all<{ job_id: string; object_key: string }>();
  if (!rows.success || !Array.isArray(rows.results) || rows.results.length > boundedLimit) {
    throw new Error("D1 gateway image-job cleanup read failed");
  }
  if (rows.results.length === 0) return 0;
  await bucket.delete(rows.results.map((row) => row.object_key));
  const placeholders = rows.results.map(() => "?").join(",");
  const result = await db
    .prepare(
      `DELETE FROM cloud_gateway_image_jobs WHERE job_id IN (${placeholders}) AND retention_expires_at <= ?`
    )
    .bind(...rows.results.map((row) => row.job_id), now)
    .run();
  const changes = result.meta?.changes;
  if (
    !result.success ||
    typeof changes !== "number" ||
    !Number.isSafeInteger(changes) ||
    changes < 0 ||
    changes > rows.results.length
  ) {
    throw new Error("D1 gateway image-job cleanup delete failed");
  }
  return changes;
}
