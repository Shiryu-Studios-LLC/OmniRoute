import type { CloudDb } from "./db";
import type { GatewayDeviceDirectory, GatewayDeviceRecord } from "./connectorGateway";
import { getCloudTenantById } from "./tenants";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface GatewayDeviceRow {
  id: string;
  tenant_id: string;
  credential_hash: string;
  capabilities_json: string;
  service_health_json: string | null;
  revoked_at: string | null;
}

function parseCapabilities(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length <= 64 &&
      parsed.every(
        (item) =>
          typeof item === "string" &&
          item.length > 0 &&
          item.length <= 128 &&
          !/[\u0000-\u001f\u007f]/.test(item)
      )
    ) {
      return [...new Set(parsed)];
    }
  } catch {
    // Malformed persisted capabilities fail closed.
  }
  return [];
}

function mapDevice(row: GatewayDeviceRow): GatewayDeviceRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    credentialHash: row.credential_hash,
    capabilities: parseCapabilities(row.capabilities_json),
    serviceHealth: parseServiceHealth(row.service_health_json),
    revokedAt: row.revoked_at,
  };
}

function parseServiceHealth(value: string | null): { ollama: boolean; comfyui: boolean } | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 2 &&
      Object.keys(parsed).every((key) => key === "ollama" || key === "comfyui") &&
      typeof (parsed as Record<string, unknown>).ollama === "boolean" &&
      typeof (parsed as Record<string, unknown>).comfyui === "boolean"
    ) {
      return {
        ollama: (parsed as { ollama: boolean }).ollama,
        comfyui: (parsed as { comfyui: boolean }).comfyui,
      };
    }
  } catch {
    // Malformed persisted metadata fails closed.
  }
  return null;
}

function validateDeviceFields(input: {
  id: string;
  credentialHash: string;
  capabilities: string[];
}): void {
  if (!DEVICE_ID_PATTERN.test(input.id)) throw new TypeError("Invalid device ID");
  if (!HASH_PATTERN.test(input.credentialHash))
    throw new TypeError("Invalid device credential hash");
  if (
    !Array.isArray(input.capabilities) ||
    input.capabilities.length > 64 ||
    input.capabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        capability.trim() !== capability ||
        capability.length < 1 ||
        capability.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(capability)
    )
  ) {
    throw new TypeError("Invalid device capabilities");
  }
}

/** Create a tenant-bound device directory entry from a trusted server integration. */
export async function registerCloudGatewayDevice(
  db: CloudDb,
  input: {
    tenantId: string;
    id: string;
    credentialHash: string;
    capabilities: string[];
    now?: string;
  }
): Promise<GatewayDeviceRecord> {
  validateDeviceFields(input);
  const tenant = await getCloudTenantById(db, input.tenantId);
  if (!tenant?.isActive) throw new TypeError("Tenant is unavailable");
  await db
    .prepare(
      `INSERT INTO cloud_gateway_devices
         (id, tenant_id, credential_hash, capabilities_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      tenant.id,
      input.credentialHash,
      JSON.stringify([...new Set(input.capabilities)]),
      input.now ?? new Date().toISOString()
    )
    .run();
  const device = await getCloudGatewayDevice(db, input.id);
  if (!device) throw new Error("Failed to register gateway device");
  return device;
}

export async function getCloudGatewayDevice(
  db: CloudDb,
  deviceId: string
): Promise<GatewayDeviceRecord | null> {
  if (!DEVICE_ID_PATTERN.test(deviceId)) return null;
  const row = await db
    .prepare<GatewayDeviceRow>(
      `SELECT d.id, d.tenant_id, d.credential_hash, d.capabilities_json,
              d.service_health_json, d.revoked_at
         FROM cloud_gateway_devices d
         JOIN tenants t ON t.id = d.tenant_id
        WHERE d.id = ? AND t.is_active = 1
        LIMIT 1`
    )
    .bind(deviceId)
    .first<GatewayDeviceRow>();
  return row ? mapDevice(row) : null;
}

/** Return tenant-owned device metadata without credential material. */
export async function listCloudGatewayDevices(
  db: CloudDb,
  tenantId: string
): Promise<
  Array<{
    id: string;
    capabilities: string[];
    serviceHealth: { ollama: boolean; comfyui: boolean } | null;
    revokedAt: string | null;
  }>
> {
  const rows = await db
    .prepare<GatewayDeviceRow>(
      `SELECT d.id, d.tenant_id, d.credential_hash, d.capabilities_json,
              d.service_health_json, d.revoked_at
         FROM cloud_gateway_devices d
        WHERE d.tenant_id = ? ORDER BY d.id`
    )
    .bind(tenantId)
    .all<GatewayDeviceRow>();
  return rows.results.map((row) => {
    const device = mapDevice(row);
    return {
      id: device.id,
      capabilities: device.capabilities,
      serviceHealth: device.serviceHealth,
      revokedAt: device.revokedAt,
    };
  });
}

export async function updateCloudGatewayDeviceCapabilities(
  db: CloudDb,
  deviceId: string,
  capabilities: string[],
  lastSeenAt = new Date().toISOString(),
  serviceHealth?: { ollama: boolean; comfyui: boolean }
): Promise<boolean> {
  if (!DEVICE_ID_PATTERN.test(deviceId)) return false;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > 64 ||
    capabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        capability.trim() !== capability ||
        capability.length < 1 ||
        capability.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(capability)
    )
  ) {
    throw new TypeError("Invalid device capabilities");
  }
  if (
    serviceHealth !== undefined &&
    (!serviceHealth ||
      typeof serviceHealth.ollama !== "boolean" ||
      typeof serviceHealth.comfyui !== "boolean" ||
      Object.keys(serviceHealth).length !== 2 ||
      Object.keys(serviceHealth).some((key) => key !== "ollama" && key !== "comfyui"))
  )
    throw new TypeError("Invalid device service health");
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_devices AS d
          SET capabilities_json = ?, service_health_json = ?,
              status = 'online', last_seen_at = ?
        WHERE d.id = ? AND d.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = d.tenant_id AND t.is_active = 1)`
    )
    .bind(
      JSON.stringify([...new Set(capabilities)]),
      serviceHealth === undefined ? null : JSON.stringify(serviceHealth),
      lastSeenAt,
      deviceId
    )
    .run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}

export async function revokeCloudGatewayDevice(
  db: CloudDb,
  tenantId: string,
  deviceId: string,
  revokedAt: string
): Promise<boolean> {
  if (!DEVICE_ID_PATTERN.test(deviceId)) return false;
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_devices
          SET revoked_at = COALESCE(revoked_at, ?), status = 'offline'
        WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`
    )
    .bind(revokedAt, tenantId, deviceId)
    .run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}

/** List tenant-owned device IDs for lifecycle operations without exposing credential material. */
export async function listCloudGatewayDeviceIds(db: CloudDb, tenantId: string): Promise<string[]> {
  const result = await db
    .prepare<{ id: string }>("SELECT id FROM cloud_gateway_devices WHERE tenant_id = ? ORDER BY id")
    .bind(tenantId)
    .all<{ id: string }>();
  return result.results.map((row) => row.id);
}

/** Permanently revoke one device credential before a replacement is installed. */
export async function revokeCloudGatewayDeviceCredential(
  db: CloudDb,
  tenantId: string,
  deviceId: string,
  revokedAt: string
): Promise<boolean> {
  if (!DEVICE_ID_PATTERN.test(deviceId)) return false;
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_devices
          SET revoked_at = COALESCE(revoked_at, ?), status = 'offline'
        WHERE tenant_id = ? AND id = ?`
    )
    .bind(revokedAt, tenantId, deviceId)
    .run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}

/** Install a new tenant-scoped credential hash after the prior session was invalidated. */
export async function rotateCloudGatewayDeviceCredential(
  db: CloudDb,
  input: { tenantId: string; deviceId: string; credentialHash: string }
): Promise<boolean> {
  if (!DEVICE_ID_PATTERN.test(input.deviceId) || !HASH_PATTERN.test(input.credentialHash)) {
    throw new TypeError("Invalid device credential rotation");
  }
  const existing = await db
    .prepare<{ credential_hash: string }>(
      "SELECT credential_hash FROM cloud_gateway_devices WHERE tenant_id = ? AND id = ? LIMIT 1"
    )
    .bind(input.tenantId, input.deviceId)
    .first<{ credential_hash: string }>();
  if (!existing) return false;
  if (existing.credential_hash === input.credentialHash) {
    throw new TypeError("New device credential must differ from the existing credential");
  }
  const result = await db
    .prepare(
      `UPDATE cloud_gateway_devices
          SET credential_hash = ?, revoked_at = NULL, status = 'offline', last_seen_at = NULL
        WHERE tenant_id = ? AND id = ? AND revoked_at IS NOT NULL`
    )
    .bind(input.credentialHash, input.tenantId, input.deviceId)
    .run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}

export class D1GatewayDeviceDirectory implements GatewayDeviceDirectory {
  constructor(private readonly db: CloudDb) {}

  getDevice(deviceId: string): Promise<GatewayDeviceRecord | null> {
    return getCloudGatewayDevice(this.db, deviceId);
  }

  revokeDevice(tenantId: string, deviceId: string, revokedAt: string): Promise<boolean> {
    return revokeCloudGatewayDevice(this.db, tenantId, deviceId, revokedAt);
  }

  updateCapabilities(
    deviceId: string,
    capabilities: string[],
    lastSeenAt?: string,
    serviceHealth?: { ollama: boolean; comfyui: boolean }
  ): Promise<boolean> {
    return updateCloudGatewayDeviceCapabilities(
      this.db,
      deviceId,
      capabilities,
      lastSeenAt,
      serviceHealth
    );
  }
}
