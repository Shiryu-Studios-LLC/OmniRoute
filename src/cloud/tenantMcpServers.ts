import type { CloudDb, CloudDbStatement } from "./db";
import {
  prepareCloudComplianceAuditInsert,
  type CloudComplianceAuditInput,
} from "./complianceAudit";
import {
  decryptCloudCredential,
  encryptCloudCredential,
  isCloudCredentialEnvelope,
} from "./credentialEncryption";

export const CLOUD_MCP_TRANSPORTS = ["sse", "streamable_http"] as const;
export type CloudMcpTransport = (typeof CLOUD_MCP_TRANSPORTS)[number];

export interface CloudTenantMcpServer {
  id: string;
  tenantId: string;
  name: string;
  transport: CloudMcpTransport;
  endpoint: string;
  isActive: boolean;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CloudTenantMcpServerInput {
  name: string;
  transport: CloudMcpTransport;
  endpoint: string;
  isActive?: boolean;
  credential?: string | null;
}

export interface CloudTenantMcpActor {
  tenantId: string;
  principalId: string;
  membershipId: string;
  apiKeyId: string;
}

export interface CloudTenantMcpMutationContext {
  actor: CloudTenantMcpActor;
  now: string;
  audit: Omit<CloudComplianceAuditInput, "tenantId" | "actor" | "timestamp">;
}

interface ServerRow {
  id: string;
  tenant_id: string;
  name: string;
  transport: string;
  endpoint: string;
  credential_encrypted: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,128}$/;
const CREDENTIAL_MAX_LENGTH = 8_192;

export function validateCloudMcpServerInput(
  value: unknown,
  partial = false
): CloudTenantMcpServerInput | Partial<CloudTenantMcpServerInput> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["name", "transport", "endpoint", "isActive", "credential"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError("Unexpected MCP server field");
  }
  if (!partial && ["name", "transport", "endpoint"].some((key) => !(key in input))) {
    throw new TypeError("name, transport, and endpoint are required");
  }
  if (partial && Object.keys(input).length === 0) {
    throw new TypeError("At least one MCP server field is required");
  }

  const result: Partial<CloudTenantMcpServerInput> = {};
  if ("name" in input) {
    if (
      typeof input.name !== "string" ||
      input.name.trim() !== input.name ||
      !NAME_PATTERN.test(input.name)
    ) {
      throw new TypeError("name must contain 1–128 printable characters");
    }
    result.name = input.name;
  }
  if ("transport" in input) {
    if (
      typeof input.transport !== "string" ||
      !CLOUD_MCP_TRANSPORTS.includes(input.transport as CloudMcpTransport)
    ) {
      throw new TypeError("transport must be sse or streamable_http");
    }
    result.transport = input.transport as CloudMcpTransport;
  }
  if ("endpoint" in input) result.endpoint = validateCloudMcpEndpoint(input.endpoint);
  if ("isActive" in input) {
    if (typeof input.isActive !== "boolean") throw new TypeError("isActive must be a boolean");
    result.isActive = input.isActive;
  }
  if ("credential" in input) {
    if (
      input.credential !== null &&
      (typeof input.credential !== "string" ||
        input.credential.trim().length === 0 ||
        input.credential.length > CREDENTIAL_MAX_LENGTH)
    ) {
      throw new TypeError(
        "credential must be a non-empty string of at most 8192 characters or null"
      );
    }
    result.credential = input.credential as string | null;
  }
  return result as CloudTenantMcpServerInput;
}

export function validateCloudMcpEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048 || value.trim() !== value) {
    throw new TypeError("endpoint must be an HTTPS URL of at most 2048 characters");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("endpoint must be an HTTPS URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname.length === 0 ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    value.includes("?") ||
    value.includes("#") ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new TypeError("endpoint must be HTTPS without embedded credentials, query, or fragment");
  }
  return endpoint.toString();
}

function requireId(value: string, field: string): void {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${field} is invalid`);
}

function mapRow(row: ServerRow | null): CloudTenantMcpServer | null {
  if (!row || !CLOUD_MCP_TRANSPORTS.includes(row.transport as CloudMcpTransport)) return null;
  let endpoint: string;
  try {
    endpoint = validateCloudMcpEndpoint(row.endpoint);
  } catch {
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    transport: row.transport as CloudMcpTransport,
    endpoint,
    isActive: row.is_active === 1,
    hasCredential:
      typeof row.credential_encrypted === "string" && row.credential_encrypted.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function writeAuthorizedStatement(): string {
  return `EXISTS (
    SELECT 1
      FROM tenants tenant
      JOIN cloud_tenant_settings settings ON settings.tenant_id = tenant.id
      JOIN cloud_customer_memberships membership
        ON membership.tenant_id = tenant.id AND membership.id = ?
      JOIN cloud_customer_api_keys api_key
        ON api_key.tenant_id = tenant.id AND api_key.membership_id = membership.id
     WHERE tenant.id = ? AND tenant.kind = 'customer' AND tenant.is_active = 1
       AND settings.mcp_enabled = 1
       AND membership.principal_id = ? AND membership.role IN ('owner', 'admin')
       AND membership.is_active = 1
       AND api_key.id = ? AND api_key.revoked_at IS NULL
       AND (api_key.expires_at IS NULL OR api_key.expires_at > ?)
  )`;
}

function authorizationValues(actor: CloudTenantMcpActor, now: string): unknown[] {
  return [actor.membershipId, actor.tenantId, actor.principalId, actor.apiKeyId, now];
}

async function runMutationWithAudit(
  db: CloudDb,
  mutation: CloudDbStatement,
  context: CloudTenantMcpMutationContext
): Promise<boolean> {
  const { actor, now, audit } = context;
  const preparedAudit = prepareCloudComplianceAuditInsert(
    db,
    {
      ...audit,
      tenantId: actor.tenantId,
      actor: actor.principalId,
      timestamp: now,
    },
    { requirePreviousStatementChange: true }
  );
  const results = await db.batch([mutation, preparedAudit.statement]);
  const first = results[0] as { meta?: { changes?: number } } | undefined;
  return first?.meta?.changes === undefined ? true : Number(first.meta.changes) === 1;
}

async function encryptCredential(
  credential: string | null | undefined,
  key: string | undefined,
  tenantId: string,
  serverId: string
): Promise<string | null> {
  if (credential === undefined || credential === null) return null;
  if (isCloudCredentialEnvelope(credential)) {
    throw new TypeError("MCP credential must be provided as plaintext input");
  }
  return encryptCloudCredential(credential, key, {
    tenantId,
    connectionId: serverId,
    field: "mcpCredential",
  });
}

export async function listCloudTenantMcpServers(
  db: CloudDb,
  tenantId: string
): Promise<CloudTenantMcpServer[]> {
  requireId(tenantId, "tenantId");
  const result = await db
    .prepare<ServerRow>(
      `SELECT id, tenant_id, name, transport, endpoint, credential_encrypted,
              is_active, created_at, updated_at
         FROM cloud_tenant_mcp_servers
        WHERE tenant_id = ?
        ORDER BY name COLLATE NOCASE ASC, id ASC`
    )
    .bind(tenantId)
    .all();
  return result.results
    .map(mapRow)
    .filter((server): server is CloudTenantMcpServer => server !== null);
}

export async function getCloudTenantMcpServer(
  db: CloudDb,
  tenantId: string,
  id: string
): Promise<CloudTenantMcpServer | null> {
  requireId(tenantId, "tenantId");
  requireId(id, "id");
  const row = await db
    .prepare<ServerRow>(
      `SELECT id, tenant_id, name, transport, endpoint, credential_encrypted,
              is_active, created_at, updated_at
         FROM cloud_tenant_mcp_servers WHERE tenant_id = ? AND id = ? LIMIT 1`
    )
    .bind(tenantId, id)
    .first();
  return mapRow(row);
}

/** Server-side only credential access; callers must pass the authenticated tenant. */
export async function getCloudTenantMcpCredential(
  db: CloudDb,
  tenantId: string,
  id: string,
  key: string | undefined
): Promise<string | null> {
  requireId(tenantId, "tenantId");
  requireId(id, "id");
  const row = await db
    .prepare<{ credential_encrypted: string | null }>(
      `SELECT server.credential_encrypted
         FROM cloud_tenant_mcp_servers server
         JOIN cloud_tenant_settings settings ON settings.tenant_id = server.tenant_id
         JOIN tenants tenant ON tenant.id = server.tenant_id
        WHERE server.tenant_id = ? AND server.id = ? AND server.is_active = 1
          AND settings.mcp_enabled = 1 AND tenant.kind = 'customer' AND tenant.is_active = 1
        LIMIT 1`
    )
    .bind(tenantId, id)
    .first();
  if (!row?.credential_encrypted) return null;
  return decryptCloudCredential(row.credential_encrypted, key, {
    tenantId,
    connectionId: id,
    field: "mcpCredential",
  });
}

export async function createCloudTenantMcpServer(
  db: CloudDb,
  input: CloudTenantMcpServerInput,
  context: CloudTenantMcpMutationContext,
  encryptionKey: string | undefined
): Promise<CloudTenantMcpServer | null> {
  const serverId = crypto.randomUUID();
  const credentialEncrypted = await encryptCredential(
    input.credential,
    encryptionKey,
    context.actor.tenantId,
    serverId
  );
  const insert = db
    .prepare(
      `INSERT INTO cloud_tenant_mcp_servers
         (id, tenant_id, name, transport, endpoint, credential_encrypted,
          is_active, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${writeAuthorizedStatement()}`
    )
    .bind(
      serverId,
      context.actor.tenantId,
      input.name,
      input.transport,
      input.endpoint,
      credentialEncrypted,
      input.isActive === false ? 0 : 1,
      context.now,
      context.now,
      ...authorizationValues(context.actor, context.now)
    );
  const written = await runMutationWithAudit(db, insert, {
    ...context,
    audit: {
      ...context.audit,
      action: "cloud.mcp_server.create",
      target: serverId,
      resourceType: "mcp_server",
      status: "success",
    },
  });
  return written ? getCloudTenantMcpServer(db, context.actor.tenantId, serverId) : null;
}

export async function updateCloudTenantMcpServer(
  db: CloudDb,
  id: string,
  input: Partial<CloudTenantMcpServerInput>,
  context: CloudTenantMcpMutationContext,
  encryptionKey: string | undefined
): Promise<CloudTenantMcpServer | null> {
  requireId(id, "id");
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    assignments.push("name = ?");
    values.push(input.name);
  }
  if (input.transport !== undefined) {
    assignments.push("transport = ?");
    values.push(input.transport);
  }
  if (input.endpoint !== undefined) {
    assignments.push("endpoint = ?");
    values.push(input.endpoint);
  }
  if (input.isActive !== undefined) {
    assignments.push("is_active = ?");
    values.push(input.isActive ? 1 : 0);
  }
  if (input.credential !== undefined) {
    assignments.push("credential_encrypted = ?");
    values.push(
      await encryptCredential(input.credential, encryptionKey, context.actor.tenantId, id)
    );
  }
  if (assignments.length === 0) throw new TypeError("At least one MCP server field is required");
  assignments.push("updated_at = ?");
  values.push(
    context.now,
    context.actor.tenantId,
    id,
    ...authorizationValues(context.actor, context.now)
  );
  const update = db
    .prepare(
      `UPDATE cloud_tenant_mcp_servers SET ${assignments.join(", ")}
        WHERE tenant_id = ? AND id = ? AND ${writeAuthorizedStatement()}`
    )
    .bind(...values);
  const written = await runMutationWithAudit(db, update, {
    ...context,
    audit: {
      ...context.audit,
      action: "cloud.mcp_server.update",
      target: id,
      resourceType: "mcp_server",
      status: "success",
    },
  });
  return written ? getCloudTenantMcpServer(db, context.actor.tenantId, id) : null;
}

export async function deleteCloudTenantMcpServer(
  db: CloudDb,
  id: string,
  context: CloudTenantMcpMutationContext
): Promise<boolean> {
  requireId(id, "id");
  const remove = db
    .prepare(
      `DELETE FROM cloud_tenant_mcp_servers
        WHERE tenant_id = ? AND id = ? AND ${writeAuthorizedStatement()}`
    )
    .bind(context.actor.tenantId, id, ...authorizationValues(context.actor, context.now));
  return runMutationWithAudit(db, remove, {
    ...context,
    audit: {
      ...context.audit,
      action: "cloud.mcp_server.delete",
      target: id,
      resourceType: "mcp_server",
      status: "success",
    },
  });
}
