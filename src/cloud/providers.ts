import type { CloudDb } from "./db";
import {
  validateProviderExecutionContract,
  type ProviderExecutionLocation,
  type ProviderOwnershipMode,
} from "./providerExecution";

export interface CloudProviderConnection {
  id: string;
  tenantId: string;
  provider: string;
  authType: string | null;
  name: string | null;
  email: string | null;
  priority: number;
  isActive: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  tokenExpiresAt: string | null;
  scope: string | null;
  projectId: string | null;
  testStatus: string | null;
  errorCode: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  apiKey: string | null;
  idToken: string | null;
  providerSpecificData: unknown;
  expiresIn: number | null;
  displayName: string | null;
  globalPriority: number | null;
  defaultModel: string | null;
  tokenType: string | null;
  credentialOwnership: ProviderOwnershipMode;
  executionLocation: ProviderExecutionLocation;
  createdAt: string;
  updatedAt: string;
}

export interface CloudProviderConnectionInput {
  id: string;
  tenantId: string;
  provider: string;
  authType?: string | null;
  name?: string | null;
  email?: string | null;
  priority?: number;
  isActive?: boolean;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: string | null;
  tokenExpiresAt?: string | null;
  scope?: string | null;
  projectId?: string | null;
  testStatus?: string | null;
  errorCode?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  apiKey?: string | null;
  idToken?: string | null;
  providerSpecificData?: unknown;
  expiresIn?: number | null;
  displayName?: string | null;
  globalPriority?: number | null;
  defaultModel?: string | null;
  tokenType?: string | null;
  credentialOwnership?: ProviderOwnershipMode;
  executionLocation?: ProviderExecutionLocation;
  createdAt?: string;
  updatedAt?: string;
}

export interface CloudProviderNode {
  id: string;
  tenantId: string;
  type: string;
  name: string;
  prefix: string | null;
  apiType: string | null;
  baseUrl: string | null;
  chatPath: string | null;
  modelsPath: string | null;
  iconUrl: string | null;
  customHeadersJson: string | null;
  credentialOwnership: ProviderOwnershipMode;
  executionLocation: ProviderExecutionLocation;
  createdAt: string;
  updatedAt: string;
}

export interface CloudProviderNodeInput {
  id: string;
  tenantId: string;
  type: string;
  name: string;
  prefix?: string | null;
  apiType?: string | null;
  baseUrl?: string | null;
  chatPath?: string | null;
  modelsPath?: string | null;
  iconUrl?: string | null;
  customHeadersJson?: string | null;
  credentialOwnership?: ProviderOwnershipMode;
  executionLocation?: ProviderExecutionLocation;
  createdAt?: string;
  updatedAt?: string;
}

function bool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === "1";
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeProviderSpecificData(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string" && /^enc:v[12]:/.test(value)) return value;
  return JSON.stringify(value);
}

function connectionFromRow(row: Record<string, unknown>): CloudProviderConnection {
  const executionContract = validateProviderExecutionContract({
    credentialOwnership:
      row.credential_ownership == null ? undefined : String(row.credential_ownership),
    executionLocation: row.execution_location == null ? undefined : String(row.execution_location),
  });
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    provider: String(row.provider),
    authType: row.auth_type == null ? null : String(row.auth_type),
    name: row.name == null ? null : String(row.name),
    email: row.email == null ? null : String(row.email),
    priority: Number(row.priority ?? 0),
    isActive: bool(row.is_active, true),
    accessToken: row.access_token == null ? null : String(row.access_token),
    refreshToken: row.refresh_token == null ? null : String(row.refresh_token),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    tokenExpiresAt: row.token_expires_at == null ? null : String(row.token_expires_at),
    scope: row.scope == null ? null : String(row.scope),
    projectId: row.project_id == null ? null : String(row.project_id),
    testStatus: row.test_status == null ? null : String(row.test_status),
    errorCode: row.error_code == null ? null : String(row.error_code),
    lastError: row.last_error == null ? null : String(row.last_error),
    lastErrorAt: row.last_error_at == null ? null : String(row.last_error_at),
    apiKey: row.api_key == null ? null : String(row.api_key),
    idToken: row.id_token == null ? null : String(row.id_token),
    providerSpecificData: parseJson(row.provider_specific_data),
    expiresIn: row.expires_in == null ? null : Number(row.expires_in),
    displayName: row.display_name == null ? null : String(row.display_name),
    globalPriority: row.global_priority == null ? null : Number(row.global_priority),
    defaultModel: row.default_model == null ? null : String(row.default_model),
    tokenType: row.token_type == null ? null : String(row.token_type),
    ...executionContract,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function nodeFromRow(row: Record<string, unknown>): CloudProviderNode {
  const executionContract = validateProviderExecutionContract({
    credentialOwnership:
      row.credential_ownership == null ? undefined : String(row.credential_ownership),
    executionLocation: row.execution_location == null ? undefined : String(row.execution_location),
  });
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    type: String(row.type),
    name: String(row.name),
    prefix: row.prefix == null ? null : String(row.prefix),
    apiType: row.api_type == null ? null : String(row.api_type),
    baseUrl: row.base_url == null ? null : String(row.base_url),
    chatPath: row.chat_path == null ? null : String(row.chat_path),
    modelsPath: row.models_path == null ? null : String(row.models_path),
    iconUrl: row.icon_url == null ? null : String(row.icon_url),
    customHeadersJson: row.custom_headers_json == null ? null : String(row.custom_headers_json),
    ...executionContract,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getCloudProviderConnections(
  db: CloudDb,
  tenantId: string,
  filter: { provider?: string; isActive?: boolean; authType?: string } = {}
): Promise<CloudProviderConnection[]> {
  const conditions = ["tenant_id = ?"];
  const values: unknown[] = [tenantId];

  if (filter.provider) {
    conditions.push("provider = ?");
    values.push(filter.provider);
  }
  if (filter.isActive !== undefined) {
    conditions.push("is_active = ?");
    values.push(filter.isActive ? 1 : 0);
  }
  if (filter.authType) {
    conditions.push("auth_type = ?");
    values.push(filter.authType);
  }

  const result = await db
    .prepare(
      `SELECT * FROM provider_connections
       WHERE ${conditions.join(" AND ")}
       ORDER BY priority ASC, updated_at DESC`
    )
    .bind(...values)
    .all<Record<string, unknown>>();

  if (!result.success) throw new Error("D1 provider connection read failed");
  return result.results.map(connectionFromRow);
}

export async function getCloudProviderConnectionById(
  db: CloudDb,
  tenantId: string,
  id: string
): Promise<CloudProviderConnection | null> {
  const row = await db
    .prepare("SELECT * FROM provider_connections WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, id)
    .first<Record<string, unknown>>();

  return row ? connectionFromRow(row) : null;
}

export async function createCloudProviderConnection(
  db: CloudDb,
  input: CloudProviderConnectionInput
): Promise<CloudProviderConnection> {
  const result = await prepareCloudProviderConnectionInsert(db, input).run();
  if (!result.success) throw new Error("D1 provider connection write failed");
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("D1 provider connection insert returned invalid state");
  }

  const created = await getCloudProviderConnectionById(db, input.tenantId, input.id);
  if (!created) throw new Error("Provider connection was inserted but could not be read back");
  return created;
}

/** Build the canonical provider insert for atomic D1 mutation+audit batches. */
export function prepareCloudProviderConnectionInsert(
  db: CloudDb,
  input: CloudProviderConnectionInput
) {
  const executionContract = validateProviderExecutionContract(input);
  const now = input.updatedAt ?? input.createdAt ?? new Date().toISOString();
  const createdAt = input.createdAt ?? now;

  return db
    .prepare(
      `INSERT INTO provider_connections (
        id, tenant_id, provider, auth_type, name, email, priority, is_active,
        access_token, refresh_token, expires_at, token_expires_at, scope, project_id,
        test_status, error_code, last_error, last_error_at, api_key, id_token,
        provider_specific_data, expires_in, display_name, global_priority,
        default_model, token_type, credential_ownership, execution_location, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.tenantId,
      input.provider,
      input.authType ?? null,
      input.name ?? null,
      input.email ?? null,
      input.priority ?? 0,
      input.isActive === false ? 0 : 1,
      input.accessToken ?? null,
      input.refreshToken ?? null,
      input.expiresAt ?? null,
      input.tokenExpiresAt ?? null,
      input.scope ?? null,
      input.projectId ?? null,
      input.testStatus ?? null,
      input.errorCode ?? null,
      input.lastError ?? null,
      input.lastErrorAt ?? null,
      input.apiKey ?? null,
      input.idToken ?? null,
      serializeProviderSpecificData(input.providerSpecificData),
      input.expiresIn ?? null,
      input.displayName ?? null,
      input.globalPriority ?? null,
      input.defaultModel ?? null,
      input.tokenType ?? null,
      executionContract.credentialOwnership,
      executionContract.executionLocation,
      createdAt,
      now
    );
}

export async function updateCloudProviderConnection(
  db: CloudDb,
  tenantId: string,
  id: string,
  patch: Partial<Omit<CloudProviderConnectionInput, "id" | "tenantId">>
): Promise<CloudProviderConnection | null> {
  const existing = await getCloudProviderConnectionById(db, tenantId, id);
  if (!existing) return null;

  const merged: CloudProviderConnectionInput = {
    ...existing,
    ...patch,
    id,
    tenantId,
    updatedAt: new Date().toISOString(),
  };
  const result = await prepareCloudProviderConnectionUpdate(db, tenantId, id, merged).run();
  if (!result.success) throw new Error("D1 provider connection update failed");
  const changes = Number(result.meta?.changes ?? 0);
  if (!Number.isSafeInteger(changes) || changes < 0 || changes > 1) {
    throw new Error("D1 provider connection update returned invalid state");
  }
  if (changes === 0) return null;
  return getCloudProviderConnectionById(db, tenantId, id);
}

/** Build the canonical provider update for atomic D1 mutation+audit batches. */
export function prepareCloudProviderConnectionUpdate(
  db: CloudDb,
  tenantId: string,
  id: string,
  merged: CloudProviderConnectionInput,
  expected?: {
    provider?: string;
    credentialOwnership?: ProviderOwnershipMode;
    executionLocation?: ProviderExecutionLocation;
  }
) {
  const executionContract = validateProviderExecutionContract(merged);

  const conditions = ["tenant_id = ?", "id = ?"];
  const conditionValues: unknown[] = [tenantId, id];
  if (expected?.provider !== undefined) {
    conditions.push("provider = ?");
    conditionValues.push(expected.provider);
  }
  if (expected?.credentialOwnership !== undefined) {
    conditions.push("credential_ownership = ?");
    conditionValues.push(expected.credentialOwnership);
  }
  if (expected?.executionLocation !== undefined) {
    conditions.push("execution_location = ?");
    conditionValues.push(expected.executionLocation);
  }

  return db
    .prepare(
      `UPDATE provider_connections SET
        provider = ?, auth_type = ?, name = ?, email = ?, priority = ?, is_active = ?,
        access_token = ?, refresh_token = ?, expires_at = ?, token_expires_at = ?,
        scope = ?, project_id = ?, test_status = ?, error_code = ?, last_error = ?,
        last_error_at = ?, api_key = ?, id_token = ?, provider_specific_data = ?,
        expires_in = ?, display_name = ?, global_priority = ?, default_model = ?,
        token_type = ?, credential_ownership = ?, execution_location = ?, updated_at = ?
       WHERE ${conditions.join(" AND ")}`
    )
    .bind(
      merged.provider,
      merged.authType ?? null,
      merged.name ?? null,
      merged.email ?? null,
      merged.priority ?? 0,
      merged.isActive === false ? 0 : 1,
      merged.accessToken ?? null,
      merged.refreshToken ?? null,
      merged.expiresAt ?? null,
      merged.tokenExpiresAt ?? null,
      merged.scope ?? null,
      merged.projectId ?? null,
      merged.testStatus ?? null,
      merged.errorCode ?? null,
      merged.lastError ?? null,
      merged.lastErrorAt ?? null,
      merged.apiKey ?? null,
      merged.idToken ?? null,
      serializeProviderSpecificData(merged.providerSpecificData),
      merged.expiresIn ?? null,
      merged.displayName ?? null,
      merged.globalPriority ?? null,
      merged.defaultModel ?? null,
      merged.tokenType ?? null,
      executionContract.credentialOwnership,
      executionContract.executionLocation,
      merged.updatedAt,
      ...conditionValues
    );
}

export async function deleteCloudProviderConnection(
  db: CloudDb,
  tenantId: string,
  id: string
): Promise<boolean> {
  const result = await prepareCloudProviderConnectionDelete(db, tenantId, id).run();
  if (!result.success) throw new Error("D1 provider connection delete failed");
  const changes = Number(result.meta?.changes ?? 0);
  if (!Number.isSafeInteger(changes) || changes < 0 || changes > 1) {
    throw new Error("D1 provider connection delete returned invalid state");
  }
  return changes === 1;
}

/** Build the tenant-qualified provider delete for atomic D1 mutation+audit batches. */
export function prepareCloudProviderConnectionDelete(
  db: CloudDb,
  tenantId: string,
  id: string,
  expected?: {
    provider?: string;
    credentialOwnership?: ProviderOwnershipMode;
    executionLocation?: ProviderExecutionLocation;
  }
) {
  const conditions = ["tenant_id = ?", "id = ?"];
  const values: unknown[] = [tenantId, id];
  if (expected?.provider !== undefined) {
    conditions.push("provider = ?");
    values.push(expected.provider);
  }
  if (expected?.credentialOwnership !== undefined) {
    conditions.push("credential_ownership = ?");
    values.push(expected.credentialOwnership);
  }
  if (expected?.executionLocation !== undefined) {
    conditions.push("execution_location = ?");
    values.push(expected.executionLocation);
  }
  return db
    .prepare(`DELETE FROM provider_connections WHERE ${conditions.join(" AND ")}`)
    .bind(...values);
}

export async function getCloudProviderNodes(
  db: CloudDb,
  tenantId: string
): Promise<CloudProviderNode[]> {
  const result = await db
    .prepare("SELECT * FROM provider_nodes WHERE tenant_id = ? ORDER BY name ASC")
    .bind(tenantId)
    .all<Record<string, unknown>>();

  if (!result.success) throw new Error("D1 provider node read failed");
  return result.results.map(nodeFromRow);
}

export async function getCloudProviderNodeById(
  db: CloudDb,
  tenantId: string,
  id: string
): Promise<CloudProviderNode | null> {
  const row = await db
    .prepare("SELECT * FROM provider_nodes WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, id)
    .first<Record<string, unknown>>();

  return row ? nodeFromRow(row) : null;
}

export async function createCloudProviderNode(
  db: CloudDb,
  input: CloudProviderNodeInput
): Promise<CloudProviderNode> {
  const executionContract = validateProviderExecutionContract(input);
  const now = input.updatedAt ?? input.createdAt ?? new Date().toISOString();
  const createdAt = input.createdAt ?? now;

  const result = await db
    .prepare(
      `INSERT INTO provider_nodes (
        id, tenant_id, type, name, prefix, api_type, base_url,
        chat_path, models_path, icon_url, custom_headers_json, credential_ownership, execution_location,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.tenantId,
      input.type,
      input.name,
      input.prefix ?? null,
      input.apiType ?? null,
      input.baseUrl ?? null,
      input.chatPath ?? null,
      input.modelsPath ?? null,
      input.iconUrl ?? null,
      input.customHeadersJson ?? null,
      executionContract.credentialOwnership,
      executionContract.executionLocation,
      createdAt,
      now
    )
    .run();
  if (!result.success) throw new Error("D1 provider node write failed");
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("D1 provider node insert returned invalid state");
  }

  const created = await getCloudProviderNodeById(db, input.tenantId, input.id);
  if (!created) throw new Error("Provider node was inserted but could not be read back");
  return created;
}

export async function updateCloudProviderNode(
  db: CloudDb,
  tenantId: string,
  id: string,
  patch: Partial<Omit<CloudProviderNodeInput, "id" | "tenantId">>
): Promise<CloudProviderNode | null> {
  const existing = await getCloudProviderNodeById(db, tenantId, id);
  if (!existing) return null;

  const merged: CloudProviderNodeInput = {
    ...existing,
    ...patch,
    id,
    tenantId,
    updatedAt: new Date().toISOString(),
  };
  const executionContract = validateProviderExecutionContract(merged);

  const result = await db
    .prepare(
      `UPDATE provider_nodes SET
        type = ?, name = ?, prefix = ?, api_type = ?, base_url = ?,
        chat_path = ?, models_path = ?, icon_url = ?, custom_headers_json = ?, credential_ownership = ?,
        execution_location = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    )
    .bind(
      merged.type,
      merged.name,
      merged.prefix ?? null,
      merged.apiType ?? null,
      merged.baseUrl ?? null,
      merged.chatPath ?? null,
      merged.modelsPath ?? null,
      merged.iconUrl ?? null,
      merged.customHeadersJson ?? null,
      executionContract.credentialOwnership,
      executionContract.executionLocation,
      merged.updatedAt,
      tenantId,
      id
    )
    .run();
  if (!result.success) throw new Error("D1 provider node update failed");
  const changes = Number(result.meta?.changes ?? 0);
  if (!Number.isSafeInteger(changes) || changes < 0 || changes > 1) {
    throw new Error("D1 provider node update returned invalid state");
  }
  if (changes === 0) return null;

  return getCloudProviderNodeById(db, tenantId, id);
}

export async function deleteCloudProviderNode(
  db: CloudDb,
  tenantId: string,
  id: string
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM provider_nodes WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, id)
    .run();
  if (!result.success) throw new Error("D1 provider node delete failed");
  const changes = Number(result.meta?.changes ?? 0);
  if (!Number.isSafeInteger(changes) || changes < 0 || changes > 1) {
    throw new Error("D1 provider node delete returned invalid state");
  }
  return changes === 1;
}
