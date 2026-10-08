/**
 * Tenant-scoped registry for remote MCP endpoints.
 *
 * Only network transports that can be invoked by a cloud runtime are accepted.
 * Credentials can be written through create/update and are encrypted at rest.
 * Safe metadata and discovery responses deliberately omit them; the separate
 * credential reader is restricted to trusted server-side tenant context.
 */
import { randomUUID } from "crypto";
import { z } from "zod";
import { getDbInstance } from "./core";
import { assertTenantScope, currentDbTenantId } from "./tenantScope";
import { decrypt, encrypt, isEncryptionEnabled, looksEncrypted } from "./encryption";

export const CLOUD_MCP_TRANSPORTS = ["sse", "streamable_http"] as const;
export type CloudMcpTransport = (typeof CLOUD_MCP_TRANSPORTS)[number];

export interface TenantMcpServer {
  id: string;
  tenantId: string;
  name: string;
  transport: CloudMcpTransport;
  endpoint: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTenantMcpServerInput {
  tenantId?: string;
  name: string;
  transport: CloudMcpTransport;
  endpoint: string;
  isActive?: boolean;
  credential?: string | null;
}

export interface UpdateTenantMcpServerInput {
  tenantId?: string;
  name?: string;
  transport?: CloudMcpTransport;
  endpoint?: string;
  isActive?: boolean;
  credential?: string | null;
}

const nameSchema = z.string().trim().min(1).max(128);
const transportSchema = z.enum(CLOUD_MCP_TRANSPORTS);
const endpointSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    try {
      const endpoint = new URL(value);
      return (
        endpoint.protocol === "https:" &&
        endpoint.username.length === 0 &&
        endpoint.password.length === 0 &&
        endpoint.search.length === 0 &&
        endpoint.hash.length === 0
      );
    } catch {
      return false;
    }
  }, "MCP endpoint must be an HTTPS URL without embedded credentials, query, or fragment");

const createSchema = z
  .object({
    tenantId: z.string().min(1).optional(),
    name: nameSchema,
    transport: transportSchema,
    endpoint: endpointSchema,
    isActive: z.boolean().optional(),
    credential: z.string().trim().min(1).max(8_192).nullable().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    tenantId: z.string().min(1).optional(),
    name: nameSchema.optional(),
    transport: transportSchema.optional(),
    endpoint: endpointSchema.optional(),
    isActive: z.boolean().optional(),
    credential: z.string().trim().min(1).max(8_192).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.transport !== undefined ||
      value.endpoint !== undefined ||
      value.isActive !== undefined ||
      value.credential !== undefined,
    "At least one MCP server field must be provided"
  );

interface TenantMcpServerRow {
  id: string;
  tenant_id: string;
  name: string;
  transport: string;
  endpoint: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function toTenantMcpServer(row: TenantMcpServerRow | undefined): TenantMcpServer | null {
  if (
    !row ||
    !CLOUD_MCP_TRANSPORTS.includes(row.transport as CloudMcpTransport) ||
    typeof row.endpoint !== "string"
  ) {
    return null;
  }

  // Legacy rows may contain unsafe or malformed endpoints. Keep them out of
  // cloud discovery until they are explicitly repaired through this API.
  const parsedEndpoint = endpointSchema.safeParse(row.endpoint);
  if (!parsedEndpoint.success) return null;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    transport: row.transport as CloudMcpTransport,
    endpoint: parsedEndpoint.data,
    isActive: row.is_active !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encryptServerCredential(credential: string | null | undefined): string | null {
  if (credential === undefined || credential === null) return null;
  if (looksEncrypted(credential)) {
    throw new Error("MCP credential must be provided as plaintext input");
  }
  if (!isEncryptionEnabled()) {
    throw new Error("STORAGE_ENCRYPTION_KEY is required to store MCP credentials");
  }
  const encrypted = encrypt(credential);
  if (typeof encrypted !== "string" || !looksEncrypted(encrypted)) {
    throw new Error("MCP credential encryption failed");
  }
  return encrypted;
}

/** Create an MCP endpoint owned by the current tenant. */
export function createTenantMcpServer(input: CreateTenantMcpServerInput): TenantMcpServer {
  const data = createSchema.parse(input);
  const tenantId = assertTenantScope(data.tenantId);
  const db = getDbInstance();
  const id = randomUUID();
  const now = new Date().toISOString();
  const credentialEncrypted = encryptServerCredential(data.credential);

  db.prepare(
    `INSERT INTO tenant_mcp_servers
       (id, tenant_id, name, transport, endpoint, command, args_json, headers_json,
        credential_encrypted,
        environment_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?)`
  ).run(
    id,
    tenantId,
    data.name,
    data.transport,
    data.endpoint,
    credentialEncrypted,
    data.isActive === false ? 0 : 1,
    now,
    now
  );

  const created = getTenantMcpServerById(id);
  if (!created) throw new Error("Failed to create tenant MCP server");
  return created;
}

/** List safe MCP endpoint metadata for the current tenant. */
export function getTenantMcpServers(
  options: { includeInactive?: boolean } = {}
): TenantMcpServer[] {
  const db = getDbInstance();
  const rows = options.includeInactive
    ? (db
        .prepare(
          `SELECT id, tenant_id, name, transport, endpoint, is_active, created_at, updated_at
           FROM tenant_mcp_servers
           WHERE tenant_id = ? AND transport IN ('sse', 'streamable_http')
           ORDER BY name COLLATE NOCASE ASC, id ASC`
        )
        .all(currentDbTenantId()) as TenantMcpServerRow[])
    : (db
        .prepare(
          `SELECT id, tenant_id, name, transport, endpoint, is_active, created_at, updated_at
           FROM tenant_mcp_servers
           WHERE tenant_id = ? AND is_active = 1 AND transport IN ('sse', 'streamable_http')
           ORDER BY name COLLATE NOCASE ASC, id ASC`
        )
        .all(currentDbTenantId()) as TenantMcpServerRow[]);

  return rows.map(toTenantMcpServer).filter((server): server is TenantMcpServer => server !== null);
}

/** Discovery view: only active, cloud-safe endpoints belonging to this tenant. */
export function discoverTenantMcpServers(): TenantMcpServer[] {
  return getTenantMcpServers();
}

/** Look up one server without revealing whether another tenant owns the ID. */
export function getTenantMcpServerById(id: string): TenantMcpServer | null {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT id, tenant_id, name, transport, endpoint, is_active, created_at, updated_at
       FROM tenant_mcp_servers WHERE id = ? AND tenant_id = ? LIMIT 1`
    )
    .get(id, currentDbTenantId()) as TenantMcpServerRow | undefined;
  return toTenantMcpServer(row);
}

/** Update a server only when it belongs to the current tenant. */
export function updateTenantMcpServer(
  id: string,
  input: UpdateTenantMcpServerInput
): TenantMcpServer | null {
  const data = updateSchema.parse(input);
  assertTenantScope(data.tenantId);
  const current = getTenantMcpServerById(id);
  if (!current) return null;

  const next = {
    name: data.name ?? current.name,
    transport: data.transport ?? current.transport,
    endpoint: data.endpoint ?? current.endpoint,
    isActive: data.isActive ?? current.isActive,
    updatedAt: new Date().toISOString(),
  };
  const credentialEncrypted =
    data.credential === undefined ? undefined : encryptServerCredential(data.credential);

  if (credentialEncrypted === undefined) {
    getDbInstance()
      .prepare(
        `UPDATE tenant_mcp_servers
         SET name = ?, transport = ?, endpoint = ?, is_active = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
      .run(
        next.name,
        next.transport,
        next.endpoint,
        next.isActive ? 1 : 0,
        next.updatedAt,
        id,
        currentDbTenantId()
      );
  } else {
    getDbInstance()
      .prepare(
        `UPDATE tenant_mcp_servers
         SET name = ?, transport = ?, endpoint = ?, is_active = ?,
             credential_encrypted = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
      .run(
        next.name,
        next.transport,
        next.endpoint,
        next.isActive ? 1 : 0,
        credentialEncrypted,
        next.updatedAt,
        id,
        currentDbTenantId()
      );
  }

  return getTenantMcpServerById(id);
}

/**
 * Read a credential for trusted server-side execution only. The tenant comes
 * from authenticated database context; this value must never be returned from
 * a management/discovery API or written to logs.
 */
export function getTenantMcpServerCredential(id: string): string | null {
  const row = getDbInstance()
    .prepare(
      `SELECT credential_encrypted FROM tenant_mcp_servers
       WHERE id = ? AND tenant_id = ? AND is_active = 1 LIMIT 1`
    )
    .get(id, currentDbTenantId()) as { credential_encrypted: string | null } | undefined;
  if (!row?.credential_encrypted) return null;
  if (!looksEncrypted(row.credential_encrypted)) {
    throw new Error("MCP credential is not stored as encrypted data");
  }
  const credential = decrypt(row.credential_encrypted, { quiet: true });
  if (!credential) throw new Error("MCP credential could not be decrypted");
  return credential;
}

/** Delete a server only when it belongs to the current tenant. */
export function deleteTenantMcpServer(id: string): boolean {
  const result = getDbInstance()
    .prepare("DELETE FROM tenant_mcp_servers WHERE id = ? AND tenant_id = ?")
    .run(id, currentDbTenantId());
  return result.changes > 0;
}
