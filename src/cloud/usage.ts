import type { CloudDb } from "./db";

export interface CloudUsageRecord {
  id: string;
  tenantId: string;
  provider: string | null;
  model: string | null;
  connectionId: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  tokensReasoning: number;
  serviceTier: string;
  status: string | null;
  success: boolean;
  latencyMs: number;
  timeToFirstTokenMs: number;
  errorCode: string | null;
  comboStrategy: string | null;
  endpoint: string | null;
  timestamp: string;
}

export type CloudUsageRecordInput = Pick<CloudUsageRecord, "id" | "tenantId"> &
  Partial<Omit<CloudUsageRecord, "id" | "tenantId">>;

export interface CloudUsageFilter {
  provider?: string;
  from?: string;
  to?: string;
  before?: { timestamp: string; id: string };
  limit?: number;
}

interface UsageRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  provider: string | null;
  model: string | null;
  connection_id: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_creation: number;
  tokens_reasoning: number;
  service_tier: string;
  status: string | null;
  success: number;
  latency_ms: number;
  ttft_ms: number;
  error_code: string | null;
  combo_strategy: string | null;
  endpoint: string | null;
  timestamp: string;
}

const MAX_TEXT_LENGTH = 512;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

function requireId(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(`${label} must be a 1–128 character identifier`);
  }
  return value;
}

function optionalText(value: string | null | undefined, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`${label} must be a string of at most ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function optionalEndpoint(value: string | null | undefined): string | null {
  const endpoint = optionalText(value, "endpoint");
  return endpoint === null ? null : endpoint.split(/[?#]/, 1)[0];
}

function nonNegativeInteger(value: number | undefined, label: string): number {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > MAX_COUNTER) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return normalized;
}

function validTimestamp(value: string): string {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("timestamp must be a valid date string");
  }
  return new Date(value).toISOString();
}

function mapRow(row: UsageRow): CloudUsageRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider,
    model: row.model,
    connectionId: row.connection_id,
    apiKeyId: row.api_key_id,
    apiKeyName: row.api_key_name,
    tokensInput: Number(row.tokens_input),
    tokensOutput: Number(row.tokens_output),
    tokensCacheRead: Number(row.tokens_cache_read),
    tokensCacheCreation: Number(row.tokens_cache_creation),
    tokensReasoning: Number(row.tokens_reasoning),
    serviceTier: row.service_tier,
    status: row.status,
    success: row.success !== 0,
    latencyMs: Number(row.latency_ms),
    timeToFirstTokenMs: Number(row.ttft_ms),
    errorCode: row.error_code,
    comboStrategy: row.combo_strategy,
    endpoint: row.endpoint,
    timestamp: row.timestamp,
  };
}

function normalizeInput(input: CloudUsageRecordInput): CloudUsageRecord {
  if (typeof input.success !== "boolean" && input.success !== undefined) {
    throw new TypeError("success must be a boolean");
  }
  return {
    id: requireId(input.id, "id"),
    tenantId: requireId(input.tenantId, "tenantId"),
    provider: optionalText(input.provider, "provider"),
    model: optionalText(input.model, "model"),
    connectionId: optionalText(input.connectionId, "connectionId"),
    apiKeyId: optionalText(input.apiKeyId, "apiKeyId"),
    apiKeyName: optionalText(input.apiKeyName, "apiKeyName"),
    tokensInput: nonNegativeInteger(input.tokensInput, "tokensInput"),
    tokensOutput: nonNegativeInteger(input.tokensOutput, "tokensOutput"),
    tokensCacheRead: nonNegativeInteger(input.tokensCacheRead, "tokensCacheRead"),
    tokensCacheCreation: nonNegativeInteger(input.tokensCacheCreation, "tokensCacheCreation"),
    tokensReasoning: nonNegativeInteger(input.tokensReasoning, "tokensReasoning"),
    serviceTier: optionalText(input.serviceTier, "serviceTier") ?? "standard",
    status: optionalText(input.status, "status"),
    success: input.success ?? true,
    latencyMs: nonNegativeInteger(input.latencyMs, "latencyMs"),
    timeToFirstTokenMs: nonNegativeInteger(input.timeToFirstTokenMs, "timeToFirstTokenMs"),
    errorCode: optionalText(input.errorCode, "errorCode"),
    comboStrategy: optionalText(input.comboStrategy, "comboStrategy"),
    endpoint: optionalEndpoint(input.endpoint),
    timestamp: validTimestamp(input.timestamp ?? new Date().toISOString()),
  };
}

export async function appendCloudUsageRecord(
  db: CloudDb,
  input: CloudUsageRecordInput
): Promise<CloudUsageRecord> {
  const record = normalizeInput(input);
  await db
    .prepare(
      `INSERT INTO cloud_usage_history (
        id, tenant_id, provider, model, connection_id, api_key_id, api_key_name,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation,
        tokens_reasoning, service_tier, status, success, latency_ms, ttft_ms,
        error_code, combo_strategy, endpoint, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.tenantId,
      record.provider,
      record.model,
      record.connectionId,
      record.apiKeyId,
      record.apiKeyName,
      record.tokensInput,
      record.tokensOutput,
      record.tokensCacheRead,
      record.tokensCacheCreation,
      record.tokensReasoning,
      record.serviceTier,
      record.status,
      record.success ? 1 : 0,
      record.latencyMs,
      record.timeToFirstTokenMs,
      record.errorCode,
      record.comboStrategy,
      record.endpoint,
      record.timestamp
    )
    .run();
  return record;
}

export async function getCloudUsageRecord(
  db: CloudDb,
  tenantId: string,
  id: string
): Promise<CloudUsageRecord | null> {
  requireId(tenantId, "tenantId");
  requireId(id, "id");
  const row = await db
    .prepare("SELECT * FROM cloud_usage_history WHERE tenant_id = ? AND id = ? LIMIT 1")
    .bind(tenantId, id)
    .first<UsageRow>();
  return row ? mapRow(row) : null;
}

export async function listCloudUsageRecords(
  db: CloudDb,
  tenantId: string,
  filter: CloudUsageFilter = {}
): Promise<CloudUsageRecord[]> {
  requireId(tenantId, "tenantId");
  const limit = filter.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("limit must be an integer between 1 and 500");
  }
  const clauses = ["tenant_id = ?"];
  const values: unknown[] = [tenantId];
  if (filter.provider !== undefined) {
    clauses.push("provider = ?");
    values.push(optionalText(filter.provider, "provider"));
  }
  if (filter.from !== undefined) {
    clauses.push("timestamp >= ?");
    values.push(validTimestamp(filter.from));
  }
  if (filter.to !== undefined) {
    clauses.push("timestamp <= ?");
    values.push(validTimestamp(filter.to));
  }
  if (filter.before) {
    clauses.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
    const timestamp = validTimestamp(filter.before.timestamp);
    values.push(timestamp, timestamp, requireId(filter.before.id, "before.id"));
  }
  values.push(limit);
  const result = await db
    .prepare(
      `SELECT * FROM cloud_usage_history WHERE ${clauses.join(" AND ")}
       ORDER BY timestamp DESC, id DESC LIMIT ?`
    )
    .bind(...values)
    .all<UsageRow>();
  return result.results.map(mapRow);
}
