import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-files-tenant-db-"));
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "files-tenant-isolation-test-secret";

const { createFile, getFile, getFileContent, listFiles, countFiles, deleteFile } =
  await import("../../src/lib/db/files.ts");
const {
  createBatch,
  getBatch,
  updateBatch,
  listBatches,
  countBatches,
  ensureBatchItemCheckpoints,
  countBatchItemCheckpoints,
  deleteBatch,
} = await import("../../src/lib/db/batches.ts");
const { getDbInstance } = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");
const { listActiveTenantIdsForMaintenance } = await import("../../src/lib/db/tenants.ts");
const { createCustomerTenant } = await import("../../src/lib/db/tenants.ts");
const { processPendingBatches } = await import("../../open-sse/services/batchProcessor.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

test("file records and content are isolated by tenant for read, list, count, and delete", () => {
  const owned = asTenant("tenant-files-a", () =>
    createFile({
      bytes: 7,
      filename: "private.txt",
      purpose: "assistants",
      content: Buffer.from("secret-a"),
      apiKeyId: "api-key-a",
    })
  );

  assert.equal(asTenant("tenant-files-a", () => getFile(owned.id))?.filename, "private.txt");
  assert.equal(asTenant("tenant-files-a", () => getFileContent(owned.id))?.toString(), "secret-a");
  assert.equal(
    asTenant("tenant-files-a", () => listFiles()).some((file) => file.id === owned.id),
    true
  );
  assert.equal(
    asTenant("tenant-files-a", () => countFiles()),
    1
  );

  assert.equal(
    asTenant("tenant-files-b", () => getFile(owned.id)),
    null
  );
  assert.equal(
    asTenant("tenant-files-b", () => getFileContent(owned.id)),
    null
  );
  assert.deepEqual(
    asTenant("tenant-files-b", () => listFiles()),
    []
  );
  assert.equal(
    asTenant("tenant-files-b", () => countFiles()),
    0
  );
  assert.equal(
    asTenant("tenant-files-b", () => deleteFile(owned.id)),
    false
  );

  const persisted = getDbInstance()
    .prepare("SELECT tenant_id, deleted_at, content FROM files WHERE id = ?")
    .get(owned.id) as { tenant_id: string; deleted_at: number | null; content: Buffer };
  assert.equal(persisted.tenant_id, "tenant-files-a");
  assert.equal(persisted.deleted_at, null);
  assert.equal(persisted.content.toString(), "secret-a");
});

test("pagination cursor lookup cannot use another tenant's file", () => {
  const cursor = asTenant("tenant-files-a", () =>
    createFile({ bytes: 1, filename: "cursor.txt", purpose: "assistants" })
  );
  asTenant("tenant-files-b", () =>
    createFile({ bytes: 1, filename: "visible.txt", purpose: "assistants" })
  );

  // A foreign cursor is ignored because getFile(after) is tenant-scoped; it
  // cannot alter tenant B's query boundary or expose tenant A's row.
  const page = asTenant("tenant-files-b", () => listFiles({ after: cursor.id }));
  assert.equal(page.length, 1);
  assert.equal(page[0].filename, "visible.txt");
});

test("batch records and checkpoints are isolated, including cross-tenant writes and deletes", () => {
  const input = asTenant("tenant-batch-a", () =>
    createFile({ bytes: 1, filename: "input.jsonl", purpose: "batch", content: Buffer.from("{}") })
  );
  const batch = asTenant("tenant-batch-a", () =>
    createBatch({
      endpoint: "/v1/chat/completions",
      completionWindow: "24h",
      inputFileId: input.id,
      apiKeyId: "batch-key-a",
    })
  );
  asTenant("tenant-batch-a", () =>
    ensureBatchItemCheckpoints(batch.id, [{ lineNumber: 1, customId: "request-a" }])
  );

  assert.equal(asTenant("tenant-batch-a", () => getBatch(batch.id))?.id, batch.id);
  assert.equal(asTenant("tenant-batch-a", () => listBatches()).length, 1);
  assert.equal(
    asTenant("tenant-batch-a", () => countBatches()),
    1
  );
  assert.equal(
    asTenant("tenant-batch-a", () => countBatchItemCheckpoints(batch.id)),
    1
  );

  assert.equal(
    asTenant("tenant-batch-b", () => getBatch(batch.id)),
    null
  );
  assert.equal(
    asTenant("tenant-batch-b", () => updateBatch(batch.id, { status: "cancelled" })),
    false
  );
  assert.equal(asTenant("tenant-batch-b", () => listBatches()).length, 0);
  assert.equal(
    asTenant("tenant-batch-b", () => countBatches()),
    0
  );
  assert.equal(
    asTenant("tenant-batch-b", () => countBatchItemCheckpoints(batch.id)),
    0
  );
  assert.equal(
    asTenant("tenant-batch-b", () => deleteBatch(batch.id)),
    false
  );

  const persisted = getDbInstance()
    .prepare("SELECT tenant_id, status FROM batches WHERE id = ?")
    .get(batch.id) as { tenant_id: string; status: string };
  assert.equal(persisted.tenant_id, "tenant-batch-a");
  assert.equal(persisted.status, "validating");
  assert.equal(asTenant("tenant-batch-a", () => getBatch(batch.id))?.id, batch.id);
  assert.equal(
    asTenant("tenant-batch-a", () => countBatchItemCheckpoints(batch.id)),
    1
  );
});

test("batch maintenance enumerates tenants only from platform context", () => {
  assert.ok(listActiveTenantIdsForMaintenance().includes("tenant_shiryu_admin"));
  assert.throws(
    () => asTenant("tenant-files-a", () => listActiveTenantIdsForMaintenance()),
    /platform-only/
  );
});

test("batch scheduler processes each active tenant inside that tenant's context", async () => {
  const tenant = createCustomerTenant("Batch Worker Tenant", `batch-worker-${Date.now()}`);
  const batch = asTenant(tenant.id, () => {
    const input = createFile({
      bytes: 9,
      filename: "invalid.jsonl",
      purpose: "batch",
      content: Buffer.from("not valid json\n"),
    });
    return createBatch({
      endpoint: "/v1/chat/completions",
      completionWindow: "24h",
      inputFileId: input.id,
    });
  });

  await processPendingBatches();

  assert.equal(asTenant(tenant.id, () => getBatch(batch.id))?.status, "failed");
  assert.equal(getBatch(batch.id), null);
});
