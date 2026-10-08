import type { CloudDb } from "./db";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
/** Future Worker upstream calls must time out within 30 seconds; stale claims get a 5-minute grace. */
export const CLOUD_INFERENCE_RESERVATION_GRACE_MS = 5 * 60 * 1000;
export const MAX_CLOUD_INFERENCE_RESERVATION_CLEANUP_BATCH_SIZE = 500;

export interface CloudInferenceEntitlement {
  tenantId: string;
  provider: string;
  model: string;
  enabled: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudInferenceReservation {
  tenantId: string;
  reservationId: string;
  provider: string;
  model: string;
  monthUtc: string;
  inputTokens: number;
  outputTokensReserved: number;
  tokensReserved: number;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  actualTokens: number | null;
  status: "reserved" | "settled" | "released";
  createdAt: string;
  updatedAt: string;
}

export interface CloudInferenceBudgetStatus {
  tenantId: string;
  monthUtc: string;
  monthlyTokenLimit: number | null;
  reservedTokens: number;
  settledTokens: number;
  consumedTokens: number;
  remainingTokens: number | null;
}

export type CloudInferenceReserveResult =
  | { kind: "reserved" | "replay"; reservation: CloudInferenceReservation }
  | { kind: "denied" }
  | { kind: "conflict"; reservation: CloudInferenceReservation };

export type CloudInferenceTransitionResult =
  | { kind: "updated" | "replay"; reservation: CloudInferenceReservation }
  | { kind: "not_found" }
  | { kind: "conflict"; reservation: CloudInferenceReservation };

interface EntitlementRow extends Record<string, unknown> {
  tenant_id: string;
  provider: string;
  model: string;
  enabled: number;
  max_input_tokens: number;
  max_output_tokens: number;
  created_at: string;
  updated_at: string;
}

interface ReservationRow extends Record<string, unknown> {
  tenant_id: string;
  reservation_id: string;
  provider: string;
  model: string;
  month_utc: string;
  input_tokens: number;
  output_tokens_reserved: number;
  tokens_reserved: number;
  actual_input_tokens: number | null;
  actual_output_tokens: number | null;
  actual_tokens: number | null;
  status: "reserved" | "settled" | "released";
  created_at: string;
  updated_at: string;
}

function requireId(value: string, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a 1–128 character identifier`);
  }
  return value;
}

function requireProvider(value: string): string {
  if (typeof value !== "string" || !PROVIDER_PATTERN.test(value)) {
    throw new TypeError("provider must be a valid identifier");
  }
  return value;
}

function requireModel(value: string): string {
  if (typeof value !== "string" || !MODEL_PATTERN.test(value)) {
    throw new TypeError("model must be a valid identifier");
  }
  return value;
}

function requireTokens(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNTER) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function validTimestamp(value: string | Date | undefined): string {
  const date = value instanceof Date ? value : value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date.toISOString();
}

function monthUtc(timestamp: string): string {
  return timestamp.slice(0, 7);
}

function entitlementFromRow(row: EntitlementRow): CloudInferenceEntitlement {
  return {
    tenantId: row.tenant_id,
    provider: row.provider,
    model: row.model,
    enabled: row.enabled === 1,
    maxInputTokens: Number(row.max_input_tokens),
    maxOutputTokens: Number(row.max_output_tokens),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reservationFromRow(row: ReservationRow): CloudInferenceReservation {
  return {
    tenantId: row.tenant_id,
    reservationId: row.reservation_id,
    provider: row.provider,
    model: row.model,
    monthUtc: row.month_utc,
    inputTokens: Number(row.input_tokens),
    outputTokensReserved: Number(row.output_tokens_reserved),
    tokensReserved: Number(row.tokens_reserved),
    actualInputTokens: row.actual_input_tokens == null ? null : Number(row.actual_input_tokens),
    actualOutputTokens: row.actual_output_tokens == null ? null : Number(row.actual_output_tokens),
    actualTokens: row.actual_tokens == null ? null : Number(row.actual_tokens),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Configure one tenant/provider/model rule. A missing row is denied; callers
 * must explicitly enable the entitlement before a reservation can succeed.
 * This domain function intentionally has no HTTP/API exposure yet.
 */
export async function setCloudInferenceEntitlement(
  db: CloudDb,
  input: {
    tenantId: string;
    provider: string;
    model: string;
    enabled: boolean;
    maxInputTokens: number;
    maxOutputTokens: number;
    now?: string | Date;
  }
): Promise<CloudInferenceEntitlement> {
  const tenantId = requireId(input.tenantId, "tenantId");
  const provider = requireProvider(input.provider);
  const model = requireModel(input.model);
  if (typeof input.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
  const maxInputTokens = requireTokens(input.maxInputTokens, "maxInputTokens");
  const maxOutputTokens = requireTokens(input.maxOutputTokens, "maxOutputTokens");
  const now = validTimestamp(input.now);

  await db
    .prepare(
      `INSERT INTO cloud_inference_entitlements (
        tenant_id, provider, model, enabled, max_input_tokens, max_output_tokens, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, provider, model) DO UPDATE SET
        enabled = excluded.enabled,
        max_input_tokens = excluded.max_input_tokens,
        max_output_tokens = excluded.max_output_tokens,
        updated_at = excluded.updated_at`
    )
    .bind(
      tenantId,
      provider,
      model,
      input.enabled ? 1 : 0,
      maxInputTokens,
      maxOutputTokens,
      now,
      now
    )
    .run();

  const entitlement = await getCloudInferenceEntitlement(db, tenantId, provider, model);
  if (!entitlement) throw new Error("Cloud inference entitlement could not be stored");
  return entitlement;
}

export async function getCloudInferenceEntitlement(
  db: CloudDb,
  tenantId: string,
  provider: string,
  model: string
): Promise<CloudInferenceEntitlement | null> {
  requireId(tenantId, "tenantId");
  requireProvider(provider);
  requireModel(model);
  const row = await db
    .prepare<EntitlementRow>(
      `SELECT tenant_id, provider, model, enabled, max_input_tokens, max_output_tokens,
              created_at, updated_at
         FROM cloud_inference_entitlements
        WHERE tenant_id = ? AND provider = ? AND model = ? LIMIT 1`
    )
    .bind(tenantId, provider, model)
    .first();
  return row ? entitlementFromRow(row) : null;
}

export async function listCloudInferenceEntitlements(
  db: CloudDb,
  tenantId: string
): Promise<CloudInferenceEntitlement[]> {
  requireId(tenantId, "tenantId");
  const rows = await db
    .prepare<EntitlementRow>(
      `SELECT tenant_id, provider, model, enabled, max_input_tokens, max_output_tokens,
              created_at, updated_at
         FROM cloud_inference_entitlements
        WHERE tenant_id = ?
        ORDER BY provider ASC, model ASC`
    )
    .bind(tenantId)
    .all();
  return rows.results.map(entitlementFromRow);
}

/** Set the shared monthly token ceiling for all cloud provider/model pairs in a tenant. */
export async function setCloudInferenceMonthlyBudget(
  db: CloudDb,
  input: { tenantId: string; monthlyTokenLimit: number; now?: string | Date }
): Promise<void> {
  const tenantId = requireId(input.tenantId, "tenantId");
  const monthlyTokenLimit = requireTokens(input.monthlyTokenLimit, "monthlyTokenLimit");
  const now = validTimestamp(input.now);
  await db
    .prepare(
      `INSERT INTO cloud_inference_monthly_budgets (tenant_id, monthly_token_limit, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id) DO UPDATE SET
         monthly_token_limit = excluded.monthly_token_limit,
         updated_at = excluded.updated_at`
    )
    .bind(tenantId, monthlyTokenLimit, now, now)
    .run();
}

/**
 * Reserve prompt plus maximum completion tokens before an upstream call.
 * The one-statement conditional INSERT is the D1 atomicity boundary: SQLite
 * serializes writers, so concurrent calls re-evaluate the month total after
 * the preceding commit. The tenant-scoped primary key makes retries
 * idempotent; a reused ID with different request parameters is a conflict.
 */
export async function reserveCloudInferenceTokens(
  db: CloudDb,
  input: {
    tenantId: string;
    reservationId: string;
    provider: string;
    model: string;
    inputTokens: number;
    maxOutputTokens: number;
    now?: string | Date;
  }
): Promise<CloudInferenceReserveResult> {
  const tenantId = requireId(input.tenantId, "tenantId");
  const reservationId = requireId(input.reservationId, "reservationId");
  const provider = requireProvider(input.provider);
  const model = requireModel(input.model);
  const inputTokens = requireTokens(input.inputTokens, "inputTokens");
  const maxOutputTokens = requireTokens(input.maxOutputTokens, "maxOutputTokens");
  const tokensReserved = inputTokens + maxOutputTokens;
  if (!Number.isSafeInteger(tokensReserved))
    throw new TypeError("reservation token total is too large");
  const now = validTimestamp(input.now);
  const month = monthUtc(now);

  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO cloud_inference_reservations (
        tenant_id, reservation_id, provider, model, month_utc,
        input_tokens, output_tokens_reserved, tokens_reserved,
        actual_input_tokens, actual_output_tokens, actual_tokens, status, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'reserved', ?, ?
       WHERE EXISTS (
         SELECT 1
           FROM cloud_inference_entitlements e
           JOIN cloud_inference_monthly_budgets b ON b.tenant_id = e.tenant_id
           JOIN tenants t ON t.id = e.tenant_id
          WHERE e.tenant_id = ? AND e.provider = ? AND e.model = ?
            AND e.enabled = 1
            AND ? <= e.max_input_tokens
            AND ? <= e.max_output_tokens
            AND t.kind = 'customer' AND t.is_active = 1
            AND (
              SELECT COALESCE(SUM(
                CASE WHEN status = 'reserved' THEN tokens_reserved
                     WHEN status = 'settled' THEN actual_tokens
                     ELSE 0 END
              ), 0)
                FROM cloud_inference_reservations
               WHERE tenant_id = ? AND month_utc = ?
            ) + ? <= b.monthly_token_limit
       )`
    )
    .bind(
      tenantId,
      reservationId,
      provider,
      model,
      month,
      inputTokens,
      maxOutputTokens,
      tokensReserved,
      now,
      now,
      tenantId,
      provider,
      model,
      inputTokens,
      maxOutputTokens,
      tenantId,
      month,
      tokensReserved
    )
    .run();

  const reservation = await readReservation(db, tenantId, reservationId);
  if (!reservation) return { kind: "denied" };
  if (
    reservation.provider !== provider ||
    reservation.model !== model ||
    reservation.inputTokens !== inputTokens ||
    reservation.outputTokensReserved !== maxOutputTokens
  ) {
    return { kind: "conflict", reservation };
  }
  return {
    kind: Number(insert.meta?.changes ?? 0) === 1 ? "reserved" : "replay",
    reservation,
  };
}

/** Settle a reservation once using provider-reported counts; a retry must match exactly. */
export async function settleCloudInferenceReservation(
  db: CloudDb,
  input: {
    tenantId: string;
    reservationId: string;
    actualInputTokens: number;
    actualOutputTokens: number;
    now?: string | Date;
  }
): Promise<CloudInferenceTransitionResult> {
  const tenantId = requireId(input.tenantId, "tenantId");
  const reservationId = requireId(input.reservationId, "reservationId");
  const actualInputTokens = requireTokens(input.actualInputTokens, "actualInputTokens");
  const actualOutputTokens = requireTokens(input.actualOutputTokens, "actualOutputTokens");
  const actualTokens = actualInputTokens + actualOutputTokens;
  if (!Number.isSafeInteger(actualTokens))
    throw new TypeError("settlement token total is too large");
  const now = validTimestamp(input.now);
  const existing = await readReservation(db, tenantId, reservationId);
  if (!existing) return { kind: "not_found" };
  if (
    actualInputTokens > existing.inputTokens ||
    actualOutputTokens > existing.outputTokensReserved
  ) {
    return { kind: "conflict", reservation: existing };
  }
  if (existing.status === "settled") {
    return existing.actualInputTokens === actualInputTokens &&
      existing.actualOutputTokens === actualOutputTokens
      ? { kind: "replay", reservation: existing }
      : { kind: "conflict", reservation: existing };
  }
  if (existing.status !== "reserved") return { kind: "conflict", reservation: existing };

  const update = await db
    .prepare(
      `UPDATE cloud_inference_reservations
          SET actual_input_tokens = ?, actual_output_tokens = ?, actual_tokens = ?,
              status = 'settled', updated_at = ?
        WHERE tenant_id = ? AND reservation_id = ? AND status = 'reserved'
          AND actual_input_tokens IS NULL`
    )
    .bind(actualInputTokens, actualOutputTokens, actualTokens, now, tenantId, reservationId)
    .run();
  const settled = await readReservation(db, tenantId, reservationId);
  if (!settled) return { kind: "not_found" };
  if (
    settled.status !== "settled" ||
    settled.actualInputTokens !== actualInputTokens ||
    settled.actualOutputTokens !== actualOutputTokens
  ) {
    return { kind: "conflict", reservation: settled };
  }
  return {
    kind: Number(update.meta?.changes ?? 0) === 1 ? "updated" : "replay",
    reservation: settled,
  };
}

/** Release an unused reservation. Settled token usage is immutable. */
export async function releaseCloudInferenceReservation(
  db: CloudDb,
  input: { tenantId: string; reservationId: string; now?: string | Date }
): Promise<CloudInferenceTransitionResult> {
  const tenantId = requireId(input.tenantId, "tenantId");
  const reservationId = requireId(input.reservationId, "reservationId");
  const now = validTimestamp(input.now);
  const existing = await readReservation(db, tenantId, reservationId);
  if (!existing) return { kind: "not_found" };
  if (existing.status === "released") return { kind: "replay", reservation: existing };
  if (existing.status !== "reserved") return { kind: "conflict", reservation: existing };

  const update = await db
    .prepare(
      `UPDATE cloud_inference_reservations
          SET status = 'released', updated_at = ?
        WHERE tenant_id = ? AND reservation_id = ? AND status = 'reserved'`
    )
    .bind(now, tenantId, reservationId)
    .run();
  const released = await readReservation(db, tenantId, reservationId);
  if (!released) return { kind: "not_found" };
  if (released.status !== "released") return { kind: "conflict", reservation: released };
  return {
    kind: Number(update.meta?.changes ?? 0) === 1 ? "updated" : "replay",
    reservation: released,
  };
}

/** Return tenant-scoped monthly accounting totals; released reservations consume zero tokens. */
export async function getCloudInferenceBudgetStatus(
  db: CloudDb,
  tenantId: string,
  now: string | Date = new Date()
): Promise<CloudInferenceBudgetStatus> {
  requireId(tenantId, "tenantId");
  const timestamp = validTimestamp(now);
  const month = monthUtc(timestamp);
  const budget = await db
    .prepare<{ monthly_token_limit: number }>(
      "SELECT monthly_token_limit FROM cloud_inference_monthly_budgets WHERE tenant_id = ? LIMIT 1"
    )
    .bind(tenantId)
    .first();
  const totals = await db
    .prepare<{ reserved_tokens: number; settled_tokens: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'reserved' THEN tokens_reserved ELSE 0 END), 0) AS reserved_tokens,
         COALESCE(SUM(CASE WHEN status = 'settled' THEN actual_tokens ELSE 0 END), 0) AS settled_tokens
       FROM cloud_inference_reservations
       WHERE tenant_id = ? AND month_utc = ?`
    )
    .bind(tenantId, month)
    .first();
  const monthlyTokenLimit = budget ? Number(budget.monthly_token_limit) : null;
  const reservedTokens = Number(totals?.reserved_tokens ?? 0);
  const settledTokens = Number(totals?.settled_tokens ?? 0);
  const consumedTokens = reservedTokens + settledTokens;
  return {
    tenantId,
    monthUtc: month,
    monthlyTokenLimit,
    reservedTokens,
    settledTokens,
    consumedTokens,
    remainingTokens:
      monthlyTokenLimit === null ? null : Math.max(0, monthlyTokenLimit - consumedTokens),
  };
}

/**
 * Conservatively settle stale claims at their full reserved token caps without
 * deleting their idempotency rows. A worker can crash after provider dispatch,
 * so releasing an uncertain request could undercount provider usage.
 * Scheduled cleanup runs every 15 minutes and changes at most 500 rows per run.
 * The five-minute grace is ten times the documented 30-second maximum upstream
 * timeout for a future inference route; cleanup therefore recovers claims after
 * a crashed Worker while preserving ordinary in-flight calls. The conservative
 * settlement is token accounting, not a provider-reported usage or cost claim.
 */
export async function cleanupStaleCloudInferenceReservations(
  db: CloudDb,
  options: { now?: string | Date; graceMs?: number; batchSize?: number } = {}
): Promise<number> {
  const now = validTimestamp(options.now);
  const nowMs = Date.parse(now);
  const graceMs = options.graceMs ?? CLOUD_INFERENCE_RESERVATION_GRACE_MS;
  const batchSize = options.batchSize ?? MAX_CLOUD_INFERENCE_RESERVATION_CLEANUP_BATCH_SIZE;
  if (!Number.isSafeInteger(graceMs) || graceMs < CLOUD_INFERENCE_RESERVATION_GRACE_MS) {
    throw new RangeError("graceMs cannot be shorter than the inference reservation grace");
  }
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_CLOUD_INFERENCE_RESERVATION_CLEANUP_BATCH_SIZE
  ) {
    throw new RangeError(
      `batchSize must be between 1 and ${MAX_CLOUD_INFERENCE_RESERVATION_CLEANUP_BATCH_SIZE}`
    );
  }
  const staleBefore = new Date(nowMs - graceMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE cloud_inference_reservations
          SET actual_input_tokens = input_tokens,
              actual_output_tokens = output_tokens_reserved,
              actual_tokens = tokens_reserved,
              status = 'settled', updated_at = ?
        WHERE rowid IN (
          SELECT rowid FROM cloud_inference_reservations
           WHERE status = 'reserved' AND created_at <= ?
           ORDER BY created_at, tenant_id, reservation_id
           LIMIT ?
        )
          AND status = 'reserved'`
    )
    .bind(now, staleBefore, batchSize)
    .run();
  const changes = Number(result.meta?.changes ?? 0);
  if (!result.success || !Number.isSafeInteger(changes) || changes < 0 || changes > batchSize) {
    throw new Error("D1 inference reservation cleanup returned invalid state");
  }
  return changes;
}

async function readReservation(
  db: CloudDb,
  tenantId: string,
  reservationId: string
): Promise<CloudInferenceReservation | null> {
  const row = await db
    .prepare<ReservationRow>(
      `SELECT tenant_id, reservation_id, provider, model, month_utc,
              input_tokens, output_tokens_reserved, tokens_reserved,
              actual_input_tokens, actual_output_tokens, actual_tokens,
              status, created_at, updated_at
         FROM cloud_inference_reservations
        WHERE tenant_id = ? AND reservation_id = ? LIMIT 1`
    )
    .bind(tenantId, reservationId)
    .first();
  return row ? reservationFromRow(row) : null;
}
