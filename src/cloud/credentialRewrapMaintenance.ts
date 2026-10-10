import type { CloudCredentialContext, CloudCredentialKeyring } from "./credentialEncryption";
import {
  CloudCredentialEncryptionError,
  isCloudCredentialEncryptionKey,
  rewrapCloudCredential,
} from "./credentialEncryption";
import type { CloudDb } from "./db";

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;

interface CredentialRow {
  rowid: number;
  tenant_id: string;
  envelope: string;
}

interface CredentialColumn {
  table: string;
  column: string;
  rowKeyColumn: string;
  context: (row: CredentialRow & Record<string, unknown>) => CloudCredentialContext;
}

function providerContext(row: CredentialRow & Record<string, unknown>, field: string) {
  return { tenantId: row.tenant_id, connectionId: String(row.id), field };
}

const CREDENTIAL_COLUMNS: readonly CredentialColumn[] = [
  ...(["access_token", "refresh_token", "api_key", "id_token"] as const).map((column) => ({
    table: "provider_connections",
    column,
    rowKeyColumn: "id",
    context: (row: CredentialRow & Record<string, unknown>) =>
      providerContext(
        row,
        (
          {
            access_token: "accessToken",
            refresh_token: "refreshToken",
            api_key: "apiKey",
            id_token: "idToken",
          } as const
        )[column]
      ),
  })),
  {
    table: "provider_connections",
    column: "provider_specific_data",
    rowKeyColumn: "id",
    context: (row) => providerContext(row, "providerSpecificData"),
  },
  {
    table: "provider_nodes",
    column: "custom_headers_json",
    rowKeyColumn: "id",
    context: (row) => ({
      tenantId: row.tenant_id,
      connectionId: String(row.id),
      field: "customHeadersJson",
    }),
  },
  {
    table: "cloud_tenant_oidc_configs",
    column: "client_secret_encrypted",
    rowKeyColumn: "tenant_id",
    context: (row) => ({
      tenantId: row.tenant_id,
      connectionId: "tenant-oidc",
      field: "clientSecret",
    }),
  },
  {
    table: "cloud_tenant_oidc_config_drafts",
    column: "client_secret_encrypted",
    rowKeyColumn: "tenant_id",
    context: (row) => ({
      tenantId: row.tenant_id,
      connectionId: "tenant-oidc-pending-draft",
      field: "clientSecret",
    }),
  },
  {
    table: "cloud_tenant_mcp_servers",
    column: "credential_encrypted",
    rowKeyColumn: "id",
    context: (row) => ({
      tenantId: row.tenant_id,
      connectionId: String(row.id),
      field: "mcpCredential",
    }),
  },
  {
    table: "cloud_frontdesk_configs",
    column: "customer_api_key_encrypted",
    rowKeyColumn: "hostname",
    context: (row) => ({
      tenantId: row.tenant_id,
      connectionId: String(row.hostname),
      field: "customer_api_key",
    }),
  },
  {
    table: "cloud_frontdesk_configs",
    column: "dashboard_token_encrypted",
    rowKeyColumn: "hostname",
    context: (row) => ({
      tenantId: row.tenant_id,
      connectionId: String(row.hostname),
      field: "dashboard_token",
    }),
  },
  {
    table: "cloud_tenant_oidc_login_states",
    column: "code_verifier_encrypted",
    rowKeyColumn: "state_hash",
    context: (row) => ({
      tenantId: row.tenant_id,
      connectionId: `oidc-state-${String(row.state_hash)}`,
      field: "pkceVerifier",
    }),
  },
];

export interface CloudCredentialRewrapResult {
  scanned: number;
  rewrapped: number;
  failed: number;
  conflicts: number;
  hasMore: boolean;
}

/** Rewrap one bounded page from each Cloud credential column using CAS updates. */
export async function rewrapCloudCredentialRows(
  db: CloudDb,
  keyring: CloudCredentialKeyring | undefined,
  options: { batchSize?: number } = {}
): Promise<CloudCredentialRewrapResult> {
  if (!keyring || !isCloudCredentialEncryptionKey(keyring) || !keyring.activeKeyId) {
    return { scanned: 0, rewrapped: 0, failed: 0, conflicts: 0, hasMore: false };
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }

  const activePrefix = `enc:v3:${keyring.activeKeyId}:`;
  const perColumnLimit = Math.max(1, Math.ceil(batchSize / CREDENTIAL_COLUMNS.length));
  const result: CloudCredentialRewrapResult = {
    scanned: 0,
    rewrapped: 0,
    failed: 0,
    conflicts: 0,
    hasMore: false,
  };

  for (const spec of CREDENTIAL_COLUMNS) {
    const remaining = batchSize - result.scanned;
    if (remaining <= 0) break;
    const limit = Math.min(remaining, perColumnLimit);
    const cursorKey = `${spec.table}.${spec.column}`;
    const cursorRow = await db
      .prepare<{ last_rowid: number }>(
        `SELECT last_rowid FROM cloud_credential_rewrap_cursors
          WHERE active_key_id = ? AND credential_column = ?`
      )
      .bind(keyring.activeKeyId, cursorKey)
      .first();
    let cursor = Number(cursorRow?.last_rowid ?? 0);
    let query = await selectCredentialPage(db, spec, cursor, activePrefix, limit);
    if (query.results.length === 0 && cursor > 0) {
      await updateCredentialCursor(db, keyring.activeKeyId, cursorKey, 0);
      cursor = 0;
      query = await selectCredentialPage(db, spec, cursor, activePrefix, limit);
    }

    for (const row of query.results) {
      result.scanned += 1;
      let replacement: string;
      try {
        replacement = await rewrapCloudCredential(row.envelope, keyring, spec.context(row));
      } catch (error) {
        if (error instanceof CloudCredentialEncryptionError) {
          result.failed += 1;
          await updateCredentialCursor(db, keyring.activeKeyId, cursorKey, row.rowid);
          continue;
        }
        throw new Error("Cloud credential rewrap encryption failed");
      }

      const update = await db
        .prepare(
          `UPDATE ${spec.table}
              SET ${spec.column} = ?
            WHERE rowid = ? AND ${spec.column} = ?`
        )
        .bind(replacement, row.rowid, row.envelope)
        .run();
      if (!update.success) throw new Error("Cloud credential rewrap update failed");
      const changes = Number(update.meta?.changes ?? 0);
      if (changes === 1) result.rewrapped += 1;
      else if (changes === 0) result.conflicts += 1;
      else throw new Error("Cloud credential rewrap update returned invalid state");
      await updateCredentialCursor(db, keyring.activeKeyId, cursorKey, row.rowid);
    }
  }

  for (const spec of CREDENTIAL_COLUMNS) {
    const pending = await db
      .prepare<{ present: number }>(
        `SELECT 1 AS present
           FROM ${spec.table}
          WHERE ${spec.column} IS NOT NULL
            AND (substr(${spec.column}, 1, 7) = 'enc:v2:' OR substr(${spec.column}, 1, 7) = 'enc:v3:')
            AND substr(${spec.column}, 1, ?) <> ?
          LIMIT 1`
      )
      .bind(activePrefix.length, activePrefix)
      .first();
    if (pending) {
      result.hasMore = true;
      break;
    }
  }
  return result;
}

async function selectCredentialPage(
  db: CloudDb,
  spec: CredentialColumn,
  afterRowid: number,
  activePrefix: string,
  limit: number
) {
  const query = await db
    .prepare<CredentialRow & Record<string, unknown>>(
      `SELECT rowid, tenant_id, ${spec.rowKeyColumn}, ${spec.column} AS envelope
         FROM ${spec.table}
        WHERE rowid > ?
          AND ${spec.column} IS NOT NULL
          AND (substr(${spec.column}, 1, 7) = 'enc:v2:' OR substr(${spec.column}, 1, 7) = 'enc:v3:')
          AND substr(${spec.column}, 1, ?) <> ?
        ORDER BY rowid
        LIMIT ?`
    )
    .bind(afterRowid, activePrefix.length, activePrefix, limit)
    .all();
  if (!query.success) throw new Error("Cloud credential rewrap query failed");
  return query;
}

async function updateCredentialCursor(
  db: CloudDb,
  activeKeyId: string,
  credentialColumn: string,
  lastRowid: number
): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO cloud_credential_rewrap_cursors (active_key_id, credential_column, last_rowid)
       VALUES (?, ?, ?)
       ON CONFLICT(active_key_id, credential_column) DO UPDATE SET last_rowid = excluded.last_rowid`
    )
    .bind(activeKeyId, credentialColumn, lastRowid)
    .run();
  if (!result.success) throw new Error("Cloud credential rewrap cursor update failed");
}
