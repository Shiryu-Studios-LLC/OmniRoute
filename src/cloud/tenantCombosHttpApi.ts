import { ROUTING_STRATEGY_VALUES } from "@/shared/constants/routingStrategies";
import { prepareCloudComplianceAuditInsert } from "./complianceAudit";
import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import type { CloudDb } from "./db";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";

export const CLOUD_CUSTOMER_COMBOS_PATH = "/__cloud/v1/customer/combos";
const MAX_BODY_BYTES = 64 * 1024;
const strategies = new Set<string>(ROUTING_STRATEGY_VALUES);

export interface CloudCustomerCombosApiOptions {
  db?: CloudDb;
  now?: () => Date;
}

interface ComboData {
  name: string;
  description?: string;
  models: unknown[];
  strategy: string;
  config?: Record<string, unknown>;
  isActive: boolean;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function safeCombo(row: Record<string, unknown>) {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(String(row.data_json)) as Record<string, unknown>;
  } catch {
    throw new Error("Stored combo data is invalid");
  }
  return {
    id: String(row.id),
    name: String(row.name),
    description: data.description ?? "",
    models: data.models,
    strategy: data.strategy,
    config: data.config ?? {},
    isActive: Number(row.is_active) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      /(?:api.?key|secret|token|credential|password)/i.test(key) || containsSensitiveField(nested)
  );
}

function validateCombo(value: unknown, patch: boolean): ComboData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["name", "description", "models", "strategy", "config", "isActive"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (containsSensitiveField(body)) return null;
  if (patch && Object.keys(body).length === 0) return null;
  if (
    "name" in body &&
    (typeof body.name !== "string" || !/^[\w./\-[\] ]{1,100}$/.test(body.name.trim()))
  )
    return null;
  if (
    "description" in body &&
    (typeof body.description !== "string" || body.description.length > 2000)
  )
    return null;
  if ("models" in body) {
    if (!Array.isArray(body.models) || body.models.length === 0 || body.models.length > 50)
      return null;
    for (const model of body.models) {
      if (typeof model === "string") {
        if (!model.trim() || model.length > 300) return null;
      } else if (!model || typeof model !== "object" || Array.isArray(model)) return null;
      else {
        const item = model as Record<string, unknown>;
        if (item.kind === "combo-ref") {
          if (
            typeof item.comboName !== "string" ||
            !item.comboName.trim() ||
            item.comboName.length > 100
          )
            return null;
        } else if (typeof item.model !== "string" || !item.model.trim() || item.model.length > 300)
          return null;
      }
    }
  }
  if ("strategy" in body && (typeof body.strategy !== "string" || !strategies.has(body.strategy)))
    return null;
  if ("config" in body) {
    if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) return null;
    const encoded = JSON.stringify(body.config);
    if (
      encoded.length > 32_000 ||
      /"(?:api.?key|secret|token|credential|password)"\s*:/i.test(encoded)
    )
      return null;
  }
  if ("isActive" in body && typeof body.isActive !== "boolean") return null;
  if (!patch && (!body.name || !Array.isArray(body.models) || !body.strategy)) return null;
  return {
    name: typeof body.name === "string" ? body.name.trim() : "",
    ...(typeof body.description === "string" ? { description: body.description.trim() } : {}),
    models: Array.isArray(body.models) ? body.models : [],
    strategy: typeof body.strategy === "string" ? body.strategy : "priority",
    ...(body.config && typeof body.config === "object" && !Array.isArray(body.config)
      ? { config: body.config as Record<string, unknown> }
      : {}),
    isActive: typeof body.isActive === "boolean" ? body.isActive : true,
  };
}

async function readJson(request: Request): Promise<unknown | Response> {
  if (
    request.headers.get("content-type")?.toLowerCase().split(";", 1)[0].trim() !==
    "application/json"
  )
    return json({ error: "Expected application/json" }, 415);
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES)
    return json({ error: "Request body is too large" }, 413);
  if (!request.body) return json({ error: "Invalid JSON body" }, 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return json({ error: "Request body is too large" }, 413);
      }
      chunks.push(value);
    }
  } catch {
    return json({ error: "Request body could not be read" }, 400);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* cancelled reader */
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
}

function idFromPath(pathname: string): string | null | undefined {
  if (pathname === CLOUD_CUSTOMER_COMBOS_PATH) return null;
  if (!pathname.startsWith(`${CLOUD_CUSTOMER_COMBOS_PATH}/`)) return undefined;
  const id = pathname.slice(CLOUD_CUSTOMER_COMBOS_PATH.length + 1);
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
}

function isUniqueNameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: cloud_tenant_combos\.tenant_id, cloud_tenant_combos\.name/i.test(
      error.message
    )
  );
}

function batchChangedExactlyOnce(results: unknown[], expectedStatements: number): boolean {
  if (results.length !== expectedStatements) return false;
  const normalized = results as Array<{ success?: unknown; meta?: { changes?: unknown } } | null>;
  return (
    normalized.every((result) => result?.success === true) &&
    normalized.every((result) => Number(result?.meta?.changes ?? 0) === 1)
  );
}

function audit(
  db: CloudDb,
  identity: { tenantId: string; principalId: string },
  request: Request,
  action: string,
  id: string,
  timestamp: string
) {
  return prepareCloudComplianceAuditInsert(
    db,
    {
      id: crypto.randomUUID(),
      tenantId: identity.tenantId,
      timestamp,
      action,
      actor: identity.principalId,
      target: id,
      resourceType: "cloud-tenant-combo",
      status: "success",
      requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
    },
    { requirePreviousStatementChange: true }
  ).statement;
}

export async function handleCloudCustomerCombosRequest(
  request: Request,
  options: CloudCustomerCombosApiOptions
): Promise<Response | null> {
  const url = new URL(request.url);
  const id = idFromPath(url.pathname);
  if (id === undefined) return null;
  if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method))
    return json({ error: "Method not allowed" }, 405);
  if (!options.db) return json({ error: "Cloud database is not configured" }, 503);
  const db = options.db;
  const now = options.now ?? (() => new Date());
  try {
    const ip = cloudflareClientIpBucket(request);
    const limit = await consumeCloudRateLimit(db, {
      tenantId: "tenant_shiryu_admin",
      bucketKey: `customer-combos-auth:${ip ?? "fallback"}`,
      limit: ip ? 600 : 100,
      windowMs: 60_000,
      nowMs: now().getTime(),
    });
    if (!limit.allowed) return json({ error: "Authentication rate limit exceeded" }, 429);
  } catch {
    return json({ error: "Authentication rate limit is unavailable" }, 503);
  }
  const match = /^Bearer (orc_live_[A-Za-z0-9_-]{1,96})$/.exec(
    request.headers.get("Authorization") ?? ""
  );
  if (!match) return json({ error: "Unauthorized" }, 401);
  let identity;
  try {
    identity = await authenticateCloudCustomerApiKey(db, match[1], now().toISOString());
  } catch {
    return json({ error: "Customer authentication is unavailable" }, 503);
  }
  if (!identity) return json({ error: "Unauthorized" }, 401);
  if (identity.role !== "owner" && identity.role !== "admin")
    return json({ error: "Owner or admin membership is required" }, 403);
  try {
    const limit = await consumeCloudRateLimit(db, {
      tenantId: identity.tenantId,
      bucketKey: "customer-combos",
      limit: 60,
      windowMs: 60_000,
      nowMs: now().getTime(),
    });
    if (!limit.allowed) return json({ error: "Customer combo rate limit exceeded" }, 429);
    if (request.method === "GET") {
      const result = id
        ? await db
            .prepare<Record<string, unknown>>(
              "SELECT id, name, data_json, is_active, created_at, updated_at FROM cloud_tenant_combos WHERE tenant_id = ? AND id = ?"
            )
            .bind(identity.tenantId, id)
            .first()
        : null;
      if (id) return result ? json(safeCombo(result)) : json({ error: "Combo not found" }, 404);
      const rows = await db
        .prepare<Record<string, unknown>>(
          "SELECT id, name, data_json, is_active, created_at, updated_at FROM cloud_tenant_combos WHERE tenant_id = ? ORDER BY name"
        )
        .bind(identity.tenantId)
        .all();
      if (!rows.success) return json({ error: "Combo list is unavailable" }, 503);
      return json((rows.results ?? []).map(safeCombo));
    }
    if (request.method === "POST") {
      if (id) return json({ error: "Invalid combo path" }, 404);
      const parsed = await readJson(request);
      if (parsed instanceof Response) return parsed;
      const data = validateCombo(parsed, false);
      if (!data) return json({ error: "Invalid combo payload" }, 400);
      const comboId = crypto.randomUUID();
      const timestamp = now().toISOString();
      try {
        const results = await db.batch([
          db
            .prepare(
              "INSERT INTO cloud_tenant_combos (id, tenant_id, name, data_json, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
              comboId,
              identity.tenantId,
              data.name,
              JSON.stringify(data),
              data.isActive ? 1 : 0,
              timestamp,
              timestamp
            ),
          audit(db, identity, request, "cloud.tenant_combo.create", comboId, timestamp),
        ]);
        if (!batchChangedExactlyOnce(results, 2))
          return json({ error: "Combo could not be created" }, 503);
      } catch (error) {
        if (isUniqueNameError(error))
          return json({ error: "A combo with this name already exists" }, 409);
        throw error;
      }
      return json({ id: comboId, ...data, createdAt: timestamp, updatedAt: timestamp }, 201);
    }
    if (!id) return json({ error: "Combo id is required" }, 404);
    const exists = await db
      .prepare<{ id: string }>("SELECT id FROM cloud_tenant_combos WHERE tenant_id = ? AND id = ?")
      .bind(identity.tenantId, id)
      .first();
    if (!exists) return json({ error: "Combo not found" }, 404);
    const timestamp = now().toISOString();
    if (request.method === "DELETE") {
      const results = await db.batch([
        db
          .prepare("DELETE FROM cloud_tenant_combos WHERE tenant_id = ? AND id = ?")
          .bind(identity.tenantId, id),
        audit(db, identity, request, "cloud.tenant_combo.delete", id, timestamp),
      ]);
      if (!batchChangedExactlyOnce(results, 2))
        return json({ error: "Combo could not be removed" }, 503);
      return json({ deleted: true });
    }
    const parsed = await readJson(request);
    if (parsed instanceof Response) return parsed;
    const patch = validateCombo(parsed, true);
    if (!patch) return json({ error: "Invalid combo payload" }, 400);
    const current = await db
      .prepare<Record<string, unknown>>(
        "SELECT id, name, data_json, is_active, created_at, updated_at FROM cloud_tenant_combos WHERE tenant_id = ? AND id = ?"
      )
      .bind(identity.tenantId, id)
      .first();
    if (!current) return json({ error: "Combo not found" }, 404);
    const prior = JSON.parse(String(current.data_json)) as ComboData;
    const data = {
      ...prior,
      ...patch,
      name: patch.name || prior.name,
      models: "models" in (parsed as object) ? patch.models : prior.models,
      strategy: "strategy" in (parsed as object) ? patch.strategy : prior.strategy,
      isActive: "isActive" in (parsed as object) ? patch.isActive : Number(current.is_active) === 1,
    };
    try {
      const results = await db.batch([
        db
          .prepare(
            "UPDATE cloud_tenant_combos SET name = ?, data_json = ?, is_active = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
          )
          .bind(
            data.name,
            JSON.stringify(data),
            data.isActive ? 1 : 0,
            timestamp,
            identity.tenantId,
            id
          ),
        audit(db, identity, request, "cloud.tenant_combo.update", id, timestamp),
      ]);
      if (!batchChangedExactlyOnce(results, 2))
        return json({ error: "Combo could not be updated" }, 503);
    } catch (error) {
      if (isUniqueNameError(error))
        return json({ error: "A combo with this name already exists" }, 409);
      throw error;
    }
    return json({ id, ...data, createdAt: String(current.created_at), updatedAt: timestamp });
  } catch {
    return json({ error: "Customer combo request could not be completed" }, 503);
  }
}
