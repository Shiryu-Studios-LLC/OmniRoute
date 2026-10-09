import type { CloudDb, CloudDbStatement } from "./db";

export interface CloudComplianceAuditRecord {
  id: string;
  tenantId: string;
  timestamp: string;
  action: string;
  actor: string | null;
  target: string | null;
  details: unknown;
  ipAddress: string | null;
  resourceType: string | null;
  status: string | null;
  requestId: string | null;
  metadata: unknown;
}

export interface CloudComplianceAuditInput {
  id: string;
  tenantId: string;
  action: string;
  actor?: string | null;
  target?: string | null;
  details?: unknown;
  ipAddress?: string | null;
  resourceType?: string | null;
  status?: string | null;
  requestId?: string | null;
  metadata?: unknown;
  timestamp?: string;
}

export interface CloudComplianceAuditFilter {
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  timestamp: string;
  action: string;
  actor: string | null;
  target: string | null;
  details_json: string | null;
  ip_address: string | null;
  resource_type: string | null;
  status: string | null;
  request_id: string | null;
  metadata_json: string | null;
}

const MAX_FIELD_LENGTH = 512;
const MAX_AUDIT_STRING_LENGTH = 2048;
const MAX_JSON_BYTES = 32 * 1024;
const SENSITIVE_KEYS = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "setcookie",
  "clientsecret",
  "privatekey",
  "credential",
  "credentials",
  "prompt",
  "messages",
  "content",
  "requestbody",
  "responsebody",
]);

function requireId(value: string, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(`${field} must be a 1–128 character identifier`);
  }
  return value;
}

function optionalText(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_FIELD_LENGTH) {
    throw new TypeError(`${field} must be a string of at most ${MAX_FIELD_LENGTH} characters`);
  }
  return scrubText(value);
}

function validTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  if (timestamp.length > 40 || !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError("timestamp must be a valid date string");
  }
  return new Date(timestamp).toISOString();
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function scrubText(value: string): string {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/enc:v1:[0-9a-f:]+/gi, "[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[=:]\s*["']?)[^,\s"']+/gi,
      "$1[redacted]"
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/gi,
      "[redacted]"
    );
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new RangeError("audit value nesting exceeds 8 levels");
  if (typeof value === "string") {
    const sanitized = scrubText(value);
    if (sanitized.length > MAX_AUDIT_STRING_LENGTH) {
      throw new RangeError(`audit strings are limited to ${MAX_AUDIT_STRING_LENGTH} characters`);
    }
    return sanitized;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    if (value.length > 100) throw new RangeError("audit arrays are limited to 100 values");
    return value.map((entry) => sanitizeValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) throw new RangeError("audit objects are limited to 100 fields");
    return Object.fromEntries(
      entries.map(([key, nested]) => [
        key.slice(0, 128),
        SENSITIVE_KEYS.has(normalizeKey(key)) ||
        ["apikey", "token", "secret", "password", "credential"].some((suffix) =>
          normalizeKey(key).endsWith(suffix)
        )
          ? "[redacted]"
          : sanitizeValue(nested, depth + 1),
      ])
    );
  }
  throw new TypeError("audit values must be JSON-serializable primitives, arrays, or objects");
}

function serializeAuditValue(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const sanitized = sanitizeValue(value);
  const serialized = JSON.stringify(sanitized);
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
    throw new RangeError(`${field} exceeds the ${MAX_JSON_BYTES}-byte limit`);
  }
  return serialized;
}

function parseAuditValue(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function mapRow(row: AuditRow): CloudComplianceAuditRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    timestamp: row.timestamp,
    action: row.action,
    actor: row.actor,
    target: row.target,
    details: parseAuditValue(row.details_json),
    ipAddress: row.ip_address,
    resourceType: row.resource_type,
    status: row.status,
    requestId: row.request_id,
    metadata: parseAuditValue(row.metadata_json),
  };
}

export async function appendCloudComplianceAudit(
  db: CloudDb,
  input: CloudComplianceAuditInput
): Promise<CloudComplianceAuditRecord> {
  const prepared = prepareCloudComplianceAuditInsert(db, input);
  const result = await prepared.statement.run();
  if (!result.success) throw new Error("D1 compliance audit write failed");
  return prepared.record;
}

/** Build the standard sanitized audit statement for inclusion in a larger D1 batch. */
export function prepareCloudComplianceAuditInsert(
  db: CloudDb,
  input: CloudComplianceAuditInput,
  options: { requirePreviousStatementChange?: boolean } = {}
): { record: CloudComplianceAuditRecord; statement: CloudDbStatement } {
  requireId(input.id, "id");
  requireId(input.tenantId, "tenantId");
  if (
    typeof input.action !== "string" ||
    input.action.trim().length === 0 ||
    input.action.length > 128
  ) {
    throw new TypeError("action must contain 1–128 characters");
  }
  const record: CloudComplianceAuditRecord = {
    id: input.id,
    tenantId: input.tenantId,
    timestamp: validTimestamp(input.timestamp),
    action: scrubText(input.action.trim()),
    actor: optionalText(input.actor, "actor"),
    target: optionalText(input.target, "target"),
    details: input.details === undefined ? null : sanitizeValue(input.details),
    ipAddress: optionalText(input.ipAddress, "ipAddress"),
    resourceType: optionalText(input.resourceType, "resourceType"),
    status: optionalText(input.status, "status"),
    requestId: optionalText(input.requestId, "requestId"),
    metadata: input.metadata === undefined ? null : sanitizeValue(input.metadata),
  };
  const detailsJson = serializeAuditValue(record.details, "details");
  const metadataJson = serializeAuditValue(record.metadata, "metadata");
  const columns = `INSERT INTO cloud_compliance_audit (
        id, tenant_id, timestamp, action, actor, target, details_json,
        ip_address, resource_type, status, request_id, metadata_json
      )`;
  const sql = options.requirePreviousStatementChange
    ? `${columns}
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`
    : `${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const statement = db
    .prepare(sql)
    .bind(
      record.id,
      record.tenantId,
      record.timestamp,
      record.action,
      record.actor,
      record.target,
      detailsJson,
      record.ipAddress,
      record.resourceType,
      record.status,
      record.requestId,
      metadataJson
    );
  return { record, statement };
}

export async function listCloudComplianceAudit(
  db: CloudDb,
  tenantId: string,
  filter: CloudComplianceAuditFilter = {}
): Promise<CloudComplianceAuditRecord[]> {
  requireId(tenantId, "tenantId");
  const limit = filter.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("limit must be an integer between 1 and 500");
  }
  const clauses = ["tenant_id = ?"];
  const values: unknown[] = [tenantId];
  if (filter.action !== undefined) {
    clauses.push("action = ?");
    values.push(optionalText(filter.action, "action"));
  }
  if (filter.from !== undefined) {
    const from = validTimestamp(filter.from);
    clauses.push("timestamp >= ?");
    values.push(from);
  }
  if (filter.to !== undefined) {
    const to = validTimestamp(filter.to);
    clauses.push("timestamp <= ?");
    values.push(to);
  }
  values.push(limit);
  const result = await db
    .prepare(
      `SELECT * FROM cloud_compliance_audit WHERE ${clauses.join(" AND ")}
       ORDER BY timestamp DESC, id DESC LIMIT ?`
    )
    .bind(...values)
    .all<AuditRow>();
  return result.results.map(mapRow);
}
