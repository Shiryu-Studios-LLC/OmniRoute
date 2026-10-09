import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { getDbInstance } from "./core";
import { assertTenantScope, currentDbTenantId } from "./tenantScope";
import {
  constantTimeHexEqual,
  localAgentCredentialDigest,
  signLocalAgentHeartbeat,
  type LocalAgentHeartbeatPayload,
} from "../localAgent/protocol";

const HEARTBEAT_MAX_SKEW_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
// A stopped or crashed agent cannot publish an offline heartbeat. Treat its
// last reported status as offline after a short liveness grace period.
const LOCAL_AGENT_OFFLINE_AFTER_MS = 5 * 60 * 1000;

const createSchema = z
  .object({ tenantId: z.string().min(1).optional(), name: z.string().trim().min(1).max(128) })
  .strict();
const heartbeatSchema = z
  .object({
    status: z.enum(["online", "busy", "offline"]),
    capabilities: z.array(z.string().trim().min(1).max(80)).max(64),
    serviceHealth: z.object({ ollama: z.boolean(), comfyui: z.boolean() }).strict().optional(),
  })
  .strict();
const serviceHealthSchema = z.object({ ollama: z.boolean(), comfyui: z.boolean() }).strict();

export interface LocalAgentDevice {
  id: string;
  tenantId: string;
  name: string;
  status: "online" | "busy" | "offline";
  capabilities: string[];
  serviceHealth: { ollama: boolean; comfyui: boolean } | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface LocalAgentRegistration {
  device: LocalAgentDevice;
  /** Returned once at registration. Persist only in the local agent's secret store. */
  credential: string;
}

interface DeviceRow {
  id: string;
  tenant_id: string;
  name: string;
  credential_hash: string;
  status: string;
  capabilities_json: string;
  service_health_json: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

function toDevice(row: DeviceRow): LocalAgentDevice {
  let capabilities: string[] = [];
  let serviceHealth: LocalAgentDevice["serviceHealth"] = null;
  try {
    const parsed: unknown = JSON.parse(row.capabilities_json);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      capabilities = parsed;
    }
  } catch {
    // Treat malformed persisted metadata as empty; never expose raw DB content.
  }
  if (row.service_health_json) {
    try {
      const parsed: unknown = JSON.parse(row.service_health_json);
      const result = serviceHealthSchema.safeParse(parsed);
      if (result.success) serviceHealth = result.data;
    } catch {
      // Treat malformed persisted metadata as unavailable; never expose raw DB content.
    }
  }
  const lastSeenAtMs = row.last_seen_at ? Date.parse(row.last_seen_at) : Number.NaN;
  const heartbeatIsFresh =
    Number.isFinite(lastSeenAtMs) && Date.now() - lastSeenAtMs <= LOCAL_AGENT_OFFLINE_AFTER_MS;
  const reportedStatus = row.status === "online" || row.status === "busy" ? row.status : "offline";
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    status: heartbeatIsFresh ? reportedStatus : "offline",
    capabilities,
    serviceHealth,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

/** Register a tenant-owned outbound agent. The generated credential is returned once. */
export function registerLocalAgent(input: {
  tenantId?: string;
  name: string;
}): LocalAgentRegistration {
  const data = createSchema.parse(input);
  const tenantId = assertTenantScope(data.tenantId);
  const db = getDbInstance();
  const id = randomUUID();
  const credential = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO local_agent_devices
       (id, tenant_id, name, credential_hash, status, capabilities_json, created_at)
     VALUES (?, ?, ?, ?, 'offline', '[]', ?)`
  ).run(id, tenantId, data.name, localAgentCredentialDigest(credential), now);
  const device = getLocalAgent(id);
  if (!device) throw new Error("Failed to register local agent");
  return { device, credential };
}

/** List only devices owned by the current tenant. Credentials are never returned. */
export function listLocalAgents(): LocalAgentDevice[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT id, tenant_id, name, credential_hash, status, capabilities_json, service_health_json,
              created_at, last_seen_at, revoked_at
         FROM local_agent_devices WHERE tenant_id = ? ORDER BY created_at DESC`
    )
    .all(currentDbTenantId()) as DeviceRow[];
  return rows.map(toDevice);
}

export function getLocalAgent(id: string): LocalAgentDevice | null {
  const row = getDbInstance()
    .prepare(
      `SELECT id, tenant_id, name, credential_hash, status, capabilities_json, service_health_json,
              created_at, last_seen_at, revoked_at
         FROM local_agent_devices WHERE tenant_id = ? AND id = ?`
    )
    .get(currentDbTenantId(), id) as DeviceRow | undefined;
  return row ? toDevice(row) : null;
}

/** Resolve the tenant from a live device credential without accepting tenant input. */
export function getLocalAgentTenantForCredential(id: string, credential: string): string | null {
  const row = getDbInstance()
    .prepare(
      `SELECT tenant_id, credential_hash, revoked_at
         FROM local_agent_devices WHERE id = ? LIMIT 1`
    )
    .get(id) as
    { tenant_id: string; credential_hash: string; revoked_at: string | null } | undefined;
  if (!row || row.revoked_at) return null;
  const presentedDigest = localAgentCredentialDigest(credential);
  return constantTimeHexEqual(row.credential_hash, presentedDigest) ? row.tenant_id : null;
}

/** Revoke a device credential. Revocation also marks the device offline. */
export function revokeLocalAgent(id: string): boolean {
  const now = new Date().toISOString();
  const result = getDbInstance()
    .prepare(
      `UPDATE local_agent_devices SET revoked_at = COALESCE(revoked_at, ?), status = 'offline'
        WHERE tenant_id = ? AND id = ?`
    )
    .run(now, currentDbTenantId(), id);
  return result.changes > 0;
}

export interface LocalAgentHeartbeatRequest {
  deviceId: string;
  credential: string;
  timestamp: number;
  nonce: string;
  signature: string;
  payload: LocalAgentHeartbeatPayload;
  nowMs?: number;
}

/**
 * Verify a tenant/device-bound signed heartbeat. A unique persisted nonce prevents
 * replay across requests and process restarts. No inbound connection is initiated.
 */
export function acceptLocalAgentHeartbeat(request: LocalAgentHeartbeatRequest): LocalAgentDevice {
  const payload = heartbeatSchema.parse(request.payload);
  if (!Number.isSafeInteger(request.timestamp)) throw new Error("Invalid heartbeat timestamp");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(request.nonce)) throw new Error("Invalid heartbeat nonce");
  const nowMs = request.nowMs ?? Date.now();
  if (Math.abs(nowMs - request.timestamp) > HEARTBEAT_MAX_SKEW_MS) {
    throw new Error("Heartbeat timestamp outside allowed window");
  }
  const tenantId = currentDbTenantId();
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT id, tenant_id, name, credential_hash, status, capabilities_json, service_health_json,
              created_at, last_seen_at, revoked_at
         FROM local_agent_devices WHERE tenant_id = ? AND id = ?`
    )
    .get(tenantId, request.deviceId) as DeviceRow | undefined;
  if (!row || row.revoked_at) throw new Error("Local agent is unavailable");
  const presentedDigest = localAgentCredentialDigest(request.credential);
  if (!constantTimeHexEqual(row.credential_hash, presentedDigest)) {
    throw new Error("Invalid local agent credential");
  }
  const expectedSignature = signLocalAgentHeartbeat(
    request.credential,
    request.timestamp,
    request.nonce,
    payload
  );
  if (!constantTimeHexEqual(expectedSignature, request.signature)) {
    throw new Error("Invalid local agent signature");
  }

  const seenAt = new Date(nowMs).toISOString();
  const accept = db.transaction(() => {
    db.prepare(`DELETE FROM local_agent_heartbeat_nonces WHERE expires_at <= ?`).run(seenAt);
    db.prepare(
      `INSERT INTO local_agent_heartbeat_nonces (tenant_id, device_id, nonce, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(tenantId, request.deviceId, request.nonce, new Date(nowMs + NONCE_TTL_MS).toISOString());
    const result = db
      .prepare(
        `UPDATE local_agent_devices
            SET status = ?, capabilities_json = ?, service_health_json = ?, last_seen_at = ?
          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`
      )
      .run(
        payload.status,
        JSON.stringify([...payload.capabilities].sort()),
        payload.serviceHealth ? JSON.stringify(payload.serviceHealth) : null,
        seenAt,
        tenantId,
        request.deviceId
      );
    if (result.changes !== 1) throw new Error("Local agent is unavailable");
  });
  try {
    accept();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      throw new Error("Heartbeat replay rejected");
    }
    throw error;
  }
  const updated = getLocalAgent(request.deviceId);
  if (!updated) throw new Error("Local agent is unavailable");
  return updated;
}
