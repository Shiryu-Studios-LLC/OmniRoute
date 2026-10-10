import assert from "node:assert/strict";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "@/cloud/db";
import {
  createCloudProviderConnection,
  createCloudProviderNode,
  deleteCloudProviderConnection,
  deleteCloudProviderNode,
  getCloudProviderConnectionById,
  getCloudProviderConnections,
  getCloudProviderNodeById,
  getCloudProviderNodes,
  updateCloudProviderConnection,
  updateCloudProviderNode,
} from "@/cloud/providers";

type Row = Record<string, unknown>;

class MockStatement<T = unknown> implements CloudDbStatement<T> {
  constructor(
    private readonly db: MockD1,
    private readonly sql: string,
    private readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]) {
    return new MockStatement<T>(this.db, this.sql, values);
  }

  async first<U = T>() {
    return this.db.first<U>(this.sql, this.values);
  }

  async all<U = T>() {
    return this.db.all<U>(this.sql, this.values);
  }

  async run() {
    return this.db.run(this.sql, this.values);
  }
}

class MockD1 implements CloudDb {
  connections: Row[] = [];
  nodes: Row[] = [];
  failNextAll = false;
  failRunPrefix: string | null = null;

  prepare<T = unknown>(sql: string) {
    return new MockStatement<T>(this, sql);
  }

  async batch() {
    return [];
  }

  async exec() {
    return undefined;
  }

  async first<U>(sql: string, values: unknown[]): Promise<U | null> {
    if (sql.includes("FROM provider_connections")) {
      const [tenantId, id] = values as string[];
      return (this.connections.find((row) => row.tenant_id === tenantId && row.id === id) ??
        null) as U | null;
    }
    if (sql.includes("FROM provider_nodes")) {
      const [tenantId, id] = values as string[];
      return (this.nodes.find((row) => row.tenant_id === tenantId && row.id === id) ??
        null) as U | null;
    }
    return null;
  }

  async all<U>(sql: string, values: unknown[]): Promise<{ results: U[]; success: boolean }> {
    if (this.failNextAll) {
      this.failNextAll = false;
      return { results: [], success: false };
    }
    if (sql.includes("FROM provider_connections")) {
      const tenantId = values[0];
      const provider = values[1];
      const active = values[sql.includes("auth_type = ?") ? 2 : 1];
      const authType = sql.includes("auth_type = ?") ? values[values.length - 1] : undefined;
      let rows = this.connections.filter((row) => row.tenant_id === tenantId);
      if (sql.includes("provider = ?")) rows = rows.filter((row) => row.provider === provider);
      if (sql.includes("is_active = ?")) rows = rows.filter((row) => row.is_active === active);
      if (authType !== undefined) rows = rows.filter((row) => row.auth_type === authType);
      return { results: rows as U[], success: true };
    }
    const tenantId = values[0];
    return {
      results: this.nodes.filter((row) => row.tenant_id === tenantId) as U[],
      success: true,
    };
  }

  async run(sql: string, values: unknown[]) {
    if (this.failRunPrefix && sql.startsWith(this.failRunPrefix)) {
      this.failRunPrefix = null;
      return { success: false, meta: { changes: 0 } };
    }
    if (sql.startsWith("INSERT INTO provider_connections")) {
      const [
        id,
        tenantId,
        provider,
        authType,
        name,
        email,
        priority,
        isActive,
        accessToken,
        refreshToken,
        expiresAt,
        tokenExpiresAt,
        scope,
        projectId,
        testStatus,
        errorCode,
        lastError,
        lastErrorAt,
        apiKey,
        idToken,
        providerSpecificData,
        expiresIn,
        displayName,
        globalPriority,
        defaultModel,
        tokenType,
        credentialOwnership,
        executionLocation,
        createdAt,
        updatedAt,
      ] = values;
      this.connections.push({
        id,
        tenant_id: tenantId,
        provider,
        auth_type: authType,
        name,
        email,
        priority,
        is_active: isActive,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        token_expires_at: tokenExpiresAt,
        scope,
        project_id: projectId,
        test_status: testStatus,
        error_code: errorCode,
        last_error: lastError,
        last_error_at: lastErrorAt,
        api_key: apiKey,
        id_token: idToken,
        provider_specific_data: providerSpecificData,
        expires_in: expiresIn,
        display_name: displayName,
        global_priority: globalPriority,
        default_model: defaultModel,
        token_type: tokenType,
        credential_ownership: credentialOwnership,
        execution_location: executionLocation,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE provider_connections")) {
      const tenantId = values[values.length - 2];
      const id = values[values.length - 1];
      const row = this.connections.find(
        (candidate) => candidate.tenant_id === tenantId && candidate.id === id
      );
      if (!row) return { success: true, meta: { changes: 0 } };
      const fields = [
        "provider",
        "auth_type",
        "name",
        "email",
        "priority",
        "is_active",
        "access_token",
        "refresh_token",
        "expires_at",
        "token_expires_at",
        "scope",
        "project_id",
        "test_status",
        "error_code",
        "last_error",
        "last_error_at",
        "api_key",
        "id_token",
        "provider_specific_data",
        "expires_in",
        "display_name",
        "global_priority",
        "default_model",
        "token_type",
        "credential_ownership",
        "execution_location",
        "updated_at",
      ];
      fields.forEach((field, index) => {
        row[field] = values[index];
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("DELETE FROM provider_connections")) {
      const [tenantId, id] = values as string[];
      const before = this.connections.length;
      this.connections = this.connections.filter(
        (row) => !(row.tenant_id === tenantId && row.id === id)
      );
      return { success: true, meta: { changes: before - this.connections.length } };
    }

    if (sql.startsWith("INSERT INTO provider_nodes")) {
      const [
        id,
        tenantId,
        type,
        name,
        prefix,
        apiType,
        baseUrl,
        chatPath,
        modelsPath,
        iconUrl,
        customHeadersJson,
        credentialOwnership,
        executionLocation,
        createdAt,
        updatedAt,
      ] = values;
      this.nodes.push({
        id,
        tenant_id: tenantId,
        type,
        name,
        prefix,
        api_type: apiType,
        base_url: baseUrl,
        chat_path: chatPath,
        models_path: modelsPath,
        icon_url: iconUrl,
        custom_headers_json: customHeadersJson,
        credential_ownership: credentialOwnership,
        execution_location: executionLocation,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE provider_nodes")) {
      const tenantId = values[values.length - 2];
      const id = values[values.length - 1];
      const row = this.nodes.find(
        (candidate) => candidate.tenant_id === tenantId && candidate.id === id
      );
      if (!row) return { success: true, meta: { changes: 0 } };
      [
        "type",
        "name",
        "prefix",
        "api_type",
        "base_url",
        "chat_path",
        "models_path",
        "icon_url",
        "custom_headers_json",
        "credential_ownership",
        "execution_location",
        "updated_at",
      ].forEach((field, index) => {
        row[field] = values[index];
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("DELETE FROM provider_nodes")) {
      const [tenantId, id] = values as string[];
      const before = this.nodes.length;
      this.nodes = this.nodes.filter((row) => !(row.tenant_id === tenantId && row.id === id));
      return { success: true, meta: { changes: before - this.nodes.length } };
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

test("cloud provider connection CRUD is tenant-scoped", async () => {
  const db = new MockD1();
  await createCloudProviderConnection(db, {
    id: "conn-a",
    tenantId: "tenant-a",
    provider: "openai",
    apiKey: "encrypted-a",
    name: "A",
  });
  await createCloudProviderConnection(db, {
    id: "conn-b",
    tenantId: "tenant-b",
    provider: "openai",
    apiKey: "encrypted-b",
    name: "B",
  });

  assert.equal((await getCloudProviderConnections(db, "tenant-a")).length, 1);
  assert.equal((await getCloudProviderConnections(db, "tenant-a"))[0]?.id, "conn-a");
  assert.equal(
    (await getCloudProviderConnectionById(db, "tenant-a", "conn-a"))?.credentialOwnership,
    "customer_managed"
  );
  assert.equal(
    (await getCloudProviderConnectionById(db, "tenant-a", "conn-a"))?.executionLocation,
    "third_party"
  );
  assert.equal(await getCloudProviderConnectionById(db, "tenant-a", "conn-b"), null);

  const blockedUpdate = await updateCloudProviderConnection(db, "tenant-a", "conn-b", {
    name: "hijacked",
  });
  assert.equal(blockedUpdate, null);
  assert.equal((await getCloudProviderConnectionById(db, "tenant-b", "conn-b"))?.name, "B");

  assert.equal(await deleteCloudProviderConnection(db, "tenant-a", "conn-b"), false);
  assert.equal(await deleteCloudProviderConnection(db, "tenant-b", "conn-b"), true);
});

test("provider execution contract supports future ownership modes and validates runtime input", async () => {
  const db = new MockD1();
  const hosted = await createCloudProviderConnection(db, {
    id: "hosted",
    tenantId: "tenant-a",
    provider: "openai",
    credentialOwnership: "shiryu_hosted",
    executionLocation: "shiryu_hosted",
  });
  assert.equal(hosted.credentialOwnership, "shiryu_hosted");
  assert.equal(hosted.executionLocation, "shiryu_hosted");

  const thirdParty = await updateCloudProviderConnection(db, "tenant-a", "hosted", {
    credentialOwnership: "third_party",
    executionLocation: "third_party",
  });
  assert.equal(thirdParty?.credentialOwnership, "third_party");
  assert.equal(thirdParty?.executionLocation, "third_party");

  await assert.rejects(
    () =>
      createCloudProviderConnection(db, {
        id: "invalid",
        tenantId: "tenant-a",
        provider: "openai",
        credentialOwnership: "shiryu_owned" as "shiryu_hosted",
      }),
    /Invalid provider ownership mode/
  );
});

test("cloud provider node CRUD is tenant-scoped", async () => {
  const db = new MockD1();
  await createCloudProviderNode(db, {
    id: "node-a",
    tenantId: "tenant-a",
    type: "openai-compatible",
    name: "A",
    baseUrl: "https://a.example",
  });
  await createCloudProviderNode(db, {
    id: "node-b",
    tenantId: "tenant-b",
    type: "openai-compatible",
    name: "B",
    baseUrl: "https://b.example",
  });

  assert.equal((await getCloudProviderNodes(db, "tenant-a")).length, 1);
  assert.equal(
    (await getCloudProviderNodeById(db, "tenant-a", "node-a"))?.credentialOwnership,
    "customer_managed"
  );
  assert.equal(await getCloudProviderNodeById(db, "tenant-a", "node-b"), null);

  assert.equal(await updateCloudProviderNode(db, "tenant-a", "node-b", { name: "hijacked" }), null);
  assert.equal((await getCloudProviderNodeById(db, "tenant-b", "node-b"))?.name, "B");

  assert.equal(await deleteCloudProviderNode(db, "tenant-a", "node-b"), false);
  assert.equal(await deleteCloudProviderNode(db, "tenant-b", "node-b"), true);
});

test("provider connection and node listings reject unsuccessful D1 reads", async () => {
  const db = new MockD1();
  db.failNextAll = true;
  await assert.rejects(
    getCloudProviderConnections(db, "tenant-a"),
    /D1 provider connection read failed/
  );

  db.failNextAll = true;
  await assert.rejects(getCloudProviderNodes(db, "tenant-a"), /D1 provider node read failed/);
});

test("provider connection mutations reject unsuccessful D1 results", async () => {
  const db = new MockD1();
  db.failRunPrefix = "INSERT INTO provider_connections";
  await assert.rejects(
    createCloudProviderConnection(db, {
      id: "failed-connection",
      tenantId: "tenant-a",
      provider: "openai",
    }),
    /D1 provider connection write failed/
  );
  assert.equal(db.connections.length, 0);

  await createCloudProviderConnection(db, {
    id: "connection",
    tenantId: "tenant-a",
    provider: "openai",
  });
  db.failRunPrefix = "UPDATE provider_connections";
  await assert.rejects(
    updateCloudProviderConnection(db, "tenant-a", "connection", { name: "not persisted" }),
    /D1 provider connection update failed/
  );
  assert.equal((await getCloudProviderConnectionById(db, "tenant-a", "connection"))?.name, null);

  db.failRunPrefix = "DELETE FROM provider_connections";
  await assert.rejects(
    deleteCloudProviderConnection(db, "tenant-a", "connection"),
    /D1 provider connection delete failed/
  );
  assert.equal(
    (await getCloudProviderConnectionById(db, "tenant-a", "connection"))?.id,
    "connection"
  );
});

test("provider node mutations reject unsuccessful D1 results", async () => {
  const db = new MockD1();
  db.failRunPrefix = "INSERT INTO provider_nodes";
  await assert.rejects(
    createCloudProviderNode(db, {
      id: "failed-node",
      tenantId: "tenant-a",
      type: "openai-compatible",
      name: "failed",
    }),
    /D1 provider node write failed/
  );
  assert.equal(db.nodes.length, 0);

  await createCloudProviderNode(db, {
    id: "node",
    tenantId: "tenant-a",
    type: "openai-compatible",
    name: "original",
  });
  db.failRunPrefix = "UPDATE provider_nodes";
  await assert.rejects(
    updateCloudProviderNode(db, "tenant-a", "node", { name: "not persisted" }),
    /D1 provider node update failed/
  );
  assert.equal((await getCloudProviderNodeById(db, "tenant-a", "node"))?.name, "original");

  db.failRunPrefix = "DELETE FROM provider_nodes";
  await assert.rejects(
    deleteCloudProviderNode(db, "tenant-a", "node"),
    /D1 provider node delete failed/
  );
  assert.equal((await getCloudProviderNodeById(db, "tenant-a", "node"))?.id, "node");
});
