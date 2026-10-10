import assert from "node:assert/strict";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import {
  decryptCloudCredential,
  encryptCloudCredential,
} from "../../src/cloud/credentialEncryption";
import { rewrapCloudCredentialRows } from "../../src/cloud/credentialRewrapMaintenance";

const legacyKey = Buffer.alloc(32, 31).toString("base64");
const oldV3Key = Buffer.alloc(32, 32).toString("base64");
const newKey = Buffer.alloc(32, 33).toString("base64");
const ring = {
  legacyKey,
  keys: { "old-key": oldV3Key, "new-key": newKey },
  activeKeyId: "new-key",
};

interface ConnectionRow {
  rowid: number;
  id: string;
  tenant_id: string;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  id_token: string | null;
  provider_specific_data: string | null;
}

class RewrapDb implements CloudDb {
  readonly connections: ConnectionRow[] = [];
  readonly tables = new Map<string, Array<Record<string, unknown>>>();
  readonly cursors = new Map<string, number>();
  statements = 0;
  conflictOnNextUpdate = false;

  private rowsFor(table: string): Array<Record<string, unknown>> {
    return table === "provider_connections"
      ? (this.connections as Array<Record<string, unknown>>)
      : (this.tables.get(table) ?? []);
  }

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    this.statements += 1;
    let values: unknown[] = [];
    const statement: CloudDbStatement<T> = {
      bind(...bound) {
        values = bound;
        return statement;
      },
      async first<U = T>() {
        if (sql.includes("FROM cloud_credential_rewrap_cursors")) {
          const key = `${String(values[0])}:${String(values[1])}`;
          const last_rowid = thisDb.cursors.get(key);
          return (last_rowid === undefined ? null : { last_rowid }) as U | null;
        }
        const match = /FROM ([a-z_]+)[\s\S]*?(?:WHERE|AND) ([a-z_]+) IS NOT NULL/.exec(sql);
        const table = match?.[1];
        const column = match?.[2];
        const isCursorQuery = sql.includes("rowid > ?");
        const cursor = isCursorQuery ? Number(values[0]) : 0;
        const activePrefix = String(values.at(-1));
        const found =
          table && column
            ? thisDb.rowsFor(table).some((row) => {
                const value = row[column];
                return (
                  (!isCursorQuery || Number(row.rowid) > cursor) &&
                  typeof value === "string" &&
                  (value.startsWith("enc:v2:") || value.startsWith("enc:v3:")) &&
                  (isCursorQuery || !value.startsWith(activePrefix))
                );
              })
            : false;
        return (found ? { present: 1 } : null) as U | null;
      },
      async all<U = T>() {
        const match = /FROM ([a-z_]+)[\s\S]*?(?:WHERE|AND) ([a-z_]+) IS NOT NULL/.exec(sql);
        const table = match?.[1];
        const column = match?.[2];
        if (!table || !column) return { results: [] as U[], success: true };
        const cursor = Number(values[0]);
        const limit = Number(values.at(-1));
        const results = thisDb
          .rowsFor(table)
          .filter((row) => {
            const value = row[column];
            return (
              Number(row.rowid) > cursor &&
              typeof value === "string" &&
              (value.startsWith("enc:v2:") || value.startsWith("enc:v3:"))
            );
          })
          .sort((left, right) => Number(left.rowid) - Number(right.rowid))
          .slice(0, limit)
          .map((row) => ({ ...row, envelope: row[column] }));
        return { results: results as U[], success: true };
      },
      async run() {
        if (sql.includes("INSERT INTO cloud_credential_rewrap_cursors")) {
          thisDb.cursors.set(`${String(values[0])}:${String(values[1])}`, Number(values[2]));
          return { success: true, meta: { changes: 1 } };
        }
        const match = /UPDATE ([a-z_]+)\s+SET ([a-z_]+) = \?\s+WHERE rowid = \? AND \2 = \?/.exec(
          sql
        );
        if (!match) throw new Error("Unexpected statement");
        const table = match[1];
        const column = match[2];
        const row = thisDb
          .rowsFor(table)
          .find((candidate) => candidate.rowid === Number(values[1]));
        if (!row || row[column] !== values[2]) return { success: true, meta: { changes: 0 } };
        if (thisDb.conflictOnNextUpdate) {
          thisDb.conflictOnNextUpdate = false;
          row[column] = "enc:v3:new-key:concurrent-user-value";
          return { success: true, meta: { changes: 0 } };
        }
        row[column] = String(values[0]);
        return { success: true, meta: { changes: 1 } };
      },
    };
    const thisDb = this;
    return statement;
  }

  async batch(): Promise<unknown[]> {
    return [];
  }

  async exec(): Promise<unknown> {
    return undefined;
  }
}

function connection(rowid: number, id: string, tenant_id: string): ConnectionRow {
  return {
    rowid,
    id,
    tenant_id,
    access_token: null,
    refresh_token: null,
    api_key: null,
    id_token: null,
    provider_specific_data: null,
  };
}

test("credential maintenance rewraps v2 and prior v3 rows without exposing plaintext", async () => {
  const db = new RewrapDb();
  const first = connection(1, "connection-v2", "tenant-a");
  const second = connection(2, "connection-v3", "tenant-b");
  first.api_key = await encryptCloudCredential("private-v2-secret", legacyKey, {
    tenantId: first.tenant_id,
    connectionId: first.id,
    field: "apiKey",
  });
  second.api_key = await encryptCloudCredential(
    "private-v3-secret",
    {
      legacyKey,
      keys: { "old-key": oldV3Key },
      activeKeyId: "old-key",
    },
    {
      tenantId: second.tenant_id,
      connectionId: second.id,
      field: "apiKey",
    }
  );
  db.connections.push(first, second);

  const result = await rewrapCloudCredentialRows(db, ring);
  assert.deepEqual(result, {
    scanned: 2,
    rewrapped: 2,
    failed: 0,
    conflicts: 0,
    hasMore: false,
  });
  assert.match(first.api_key ?? "", /^enc:v3:new-key:/);
  assert.match(second.api_key ?? "", /^enc:v3:new-key:/);
  assert.equal(
    await decryptCloudCredential(first.api_key ?? "", ring, {
      tenantId: first.tenant_id,
      connectionId: first.id,
      field: "apiKey",
    }),
    "private-v2-secret"
  );
  assert.equal(
    await decryptCloudCredential(second.api_key ?? "", ring, {
      tenantId: second.tenant_id,
      connectionId: second.id,
      field: "apiKey",
    }),
    "private-v3-secret"
  );
  assert.equal(JSON.stringify(result).includes("private-"), false);
});

test("credential maintenance preserves the original AAD context for every stored Cloud credential", async () => {
  const db = new RewrapDb();
  const credentials: Array<{
    table: string;
    row: Record<string, unknown>;
    column: string;
    field: string;
    connectionId: string;
  }> = [
    ...[
      ["access_token", "accessToken"],
      ["refresh_token", "refreshToken"],
      ["api_key", "apiKey"],
      ["id_token", "idToken"],
      ["provider_specific_data", "providerSpecificData"],
    ].map(([column, field], index) => ({
      table: "provider_connections",
      row: {
        rowid: index + 1,
        id: `provider-${index}`,
        tenant_id: "tenant-provider",
        [column]: null,
      },
      column,
      field,
      connectionId: `provider-${index}`,
    })),
    {
      table: "provider_nodes",
      row: {
        rowid: 1,
        tenant_id: "tenant-node",
        id: "node-1",
        custom_headers_json: null,
      },
      column: "custom_headers_json",
      field: "customHeadersJson",
      connectionId: "node-1",
    },
    {
      table: "cloud_tenant_oidc_configs",
      row: { rowid: 1, tenant_id: "tenant-oidc", client_secret_encrypted: null },
      column: "client_secret_encrypted",
      field: "clientSecret",
      connectionId: "tenant-oidc",
    },
    {
      table: "cloud_tenant_oidc_config_drafts",
      row: { rowid: 1, tenant_id: "tenant-draft", client_secret_encrypted: null },
      column: "client_secret_encrypted",
      field: "clientSecret",
      connectionId: "tenant-oidc-pending-draft",
    },
    {
      table: "cloud_tenant_mcp_servers",
      row: { rowid: 1, tenant_id: "tenant-mcp", id: "mcp-1", credential_encrypted: null },
      column: "credential_encrypted",
      field: "mcpCredential",
      connectionId: "mcp-1",
    },
    {
      table: "cloud_frontdesk_configs",
      row: {
        rowid: 1,
        tenant_id: "tenant-frontdesk",
        hostname: "front.example",
        customer_api_key_encrypted: null,
      },
      column: "customer_api_key_encrypted",
      field: "customer_api_key",
      connectionId: "front.example",
    },
    {
      table: "cloud_frontdesk_configs",
      row: {
        rowid: 2,
        tenant_id: "tenant-frontdesk",
        hostname: "front.example",
        dashboard_token_encrypted: null,
      },
      column: "dashboard_token_encrypted",
      field: "dashboard_token",
      connectionId: "front.example",
    },
    {
      table: "cloud_tenant_oidc_login_states",
      row: {
        rowid: 1,
        tenant_id: "tenant-state",
        state_hash: "state-hash",
        code_verifier_encrypted: null,
      },
      column: "code_verifier_encrypted",
      field: "pkceVerifier",
      connectionId: "oidc-state-state-hash",
    },
  ];

  for (const [index, credential] of credentials.entries()) {
    credential.row[credential.column] = await encryptCloudCredential(`secret-${index}`, legacyKey, {
      tenantId: String(credential.row.tenant_id),
      connectionId: credential.connectionId,
      field: credential.field,
    });
    if (credential.table === "provider_connections") {
      db.connections.push(credential.row as unknown as ConnectionRow);
    } else {
      const rows = db.tables.get(credential.table) ?? [];
      rows.push(credential.row);
      db.tables.set(credential.table, rows);
    }
  }

  const result = await rewrapCloudCredentialRows(db, ring, { batchSize: 20 });
  assert.equal(result.scanned, credentials.length);
  assert.equal(result.rewrapped, credentials.length);
  assert.equal(result.failed, 0);
  assert.equal(result.hasMore, false);
  for (const [index, credential] of credentials.entries()) {
    const row =
      credential.table === "provider_connections"
        ? db.connections.find((candidate) => candidate.id === credential.row.id)
        : db.tables
            .get(credential.table)
            ?.find((candidate) => candidate.rowid === credential.row.rowid);
    const envelope = row?.[credential.column];
    assert.equal(typeof envelope, "string");
    assert.match(envelope as string, /^enc:v3:new-key:/);
    assert.equal(
      await decryptCloudCredential(envelope as string, ring, {
        tenantId: String(credential.row.tenant_id),
        connectionId: credential.connectionId,
        field: credential.field,
      }),
      `secret-${index}`
    );
  }
});

test("credential maintenance continues in bounded batches and never overwrites a concurrent update", async () => {
  const db = new RewrapDb();
  const first = connection(1, "connection-one", "tenant-a");
  const second = connection(2, "connection-two", "tenant-a");
  first.access_token = await encryptCloudCredential("first-secret", legacyKey, {
    tenantId: first.tenant_id,
    connectionId: first.id,
    field: "accessToken",
  });
  second.access_token = await encryptCloudCredential("second-secret", legacyKey, {
    tenantId: second.tenant_id,
    connectionId: second.id,
    field: "accessToken",
  });
  db.connections.push(first, second);

  const firstRun = await rewrapCloudCredentialRows(db, ring, { batchSize: 1 });
  assert.equal(firstRun.scanned, 1);
  assert.equal(firstRun.rewrapped, 1);
  assert.equal(firstRun.hasMore, true);
  const secondRun = await rewrapCloudCredentialRows(db, ring, { batchSize: 1 });
  assert.equal(secondRun.rewrapped, 1);
  assert.equal(secondRun.hasMore, false);

  const concurrent = connection(3, "connection-concurrent", "tenant-a");
  concurrent.access_token = await encryptCloudCredential("before-change", legacyKey, {
    tenantId: concurrent.tenant_id,
    connectionId: concurrent.id,
    field: "accessToken",
  });
  db.connections.push(concurrent);
  db.conflictOnNextUpdate = true;
  const conflictRun = await rewrapCloudCredentialRows(db, ring, { batchSize: 1 });
  assert.equal(conflictRun.conflicts, 1);
  assert.equal(concurrent.access_token, "enc:v3:new-key:concurrent-user-value");
});

test("credential maintenance counts bad envelopes without changing their ciphertext", async () => {
  const db = new RewrapDb();
  const row = connection(1, "connection-bad", "tenant-a");
  const laterRow = connection(2, "connection-good", "tenant-a");
  row.api_key = await encryptCloudCredential(
    "wrong-key-secret",
    { legacyKey, keys: { "old-key": oldV3Key }, activeKeyId: "old-key" },
    { tenantId: row.tenant_id, connectionId: row.id, field: "apiKey" }
  );
  const original = row.api_key;
  laterRow.api_key = await encryptCloudCredential("recoverable-secret", legacyKey, {
    tenantId: laterRow.tenant_id,
    connectionId: laterRow.id,
    field: "apiKey",
  });
  db.connections.push(row, laterRow);

  const result = await rewrapCloudCredentialRows(
    db,
    {
      legacyKey,
      keys: { "new-key": newKey },
      activeKeyId: "new-key",
    },
    { batchSize: 1 }
  );
  assert.equal(result.failed, 1);
  assert.equal(result.hasMore, true, "failed envelopes remain pending for operators to resolve");
  assert.equal(row.api_key, original);
  assert.equal(JSON.stringify(result).includes("wrong-key-secret"), false);

  const continued = await rewrapCloudCredentialRows(db, ring, { batchSize: 1 });
  assert.equal(continued.rewrapped, 1);
  assert.equal(continued.hasMore, true, "the unrecoverable envelope remains pending");
  assert.match(laterRow.api_key ?? "", /^enc:v3:new-key:/);
});

test("credential maintenance blocks key retirement for unreadable envelopes labeled with the active key ID", async () => {
  const db = new RewrapDb();
  const row = connection(1, "connection-reused-key-id", "tenant-a");
  const priorMaterialWithReusedId = await encryptCloudCredential(
    "still-wrapped-by-the-prior-key",
    { legacyKey, keys: { "new-key": oldV3Key }, activeKeyId: "new-key" },
    { tenantId: row.tenant_id, connectionId: row.id, field: "apiKey" }
  );
  row.api_key = priorMaterialWithReusedId;
  db.connections.push(row);

  const result = await rewrapCloudCredentialRows(db, ring);

  assert.deepEqual(result, {
    scanned: 1,
    rewrapped: 0,
    failed: 1,
    conflicts: 0,
    hasMore: true,
  });
  assert.equal(row.api_key, priorMaterialWithReusedId);
  assert.equal(JSON.stringify(result).includes("still-wrapped-by-the-prior-key"), false);
});

test("credential maintenance performs no D1 work when key rotation is inactive", async () => {
  const db = new RewrapDb();
  const noKeyring = await rewrapCloudCredentialRows(db, undefined);
  const noActiveKey = await rewrapCloudCredentialRows(db, {
    legacyKey,
    keys: { "old-key": oldV3Key },
  });
  assert.equal(db.statements, 0);
  assert.deepEqual(noKeyring, noActiveKey);
  assert.deepEqual(noKeyring, {
    scanned: 0,
    rewrapped: 0,
    failed: 0,
    conflicts: 0,
    hasMore: false,
  });
});
