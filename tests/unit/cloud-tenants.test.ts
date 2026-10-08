import assert from "node:assert/strict";
import test from "node:test";
import {
  createCloudCustomerTenant,
  getCloudTenantById,
  getCloudTenantBySlug,
} from "@/cloud/tenants";
import type { CloudDb, CloudDbStatement } from "@/cloud/db";

class Statement implements CloudDbStatement<unknown> {
  constructor(
    private sql: string,
    private values: unknown[] = []
  ) {}
  bind(...values: unknown[]) {
    return new Statement(this.sql, values);
  }
  async first() {
    if (this.sql.includes("WHERE id = ?"))
      return this.values[0] === "tenant-a" ? row("tenant-a", "Alpha", "alpha") : null;
    if (this.sql.includes("WHERE slug = ?"))
      return this.values[0] === "alpha" ? row("tenant-a", "Alpha", "alpha") : null;
    return null;
  }
  async all() {
    return { results: [], success: true };
  }
  async run() {
    return { success: true };
  }
}
function row(id: string, name: string, slug: string) {
  return {
    id,
    name,
    slug,
    kind: "customer",
    is_active: 1,
    created_at: "2026-10-07T00:00:00.000Z",
    updated_at: "2026-10-07T00:00:00.000Z",
  };
}
const db: CloudDb = {
  prepare: <T>(sql: string) => new Statement(sql) as CloudDbStatement<T>,
  batch: async () => [],
  exec: async () => undefined,
};

test("cloud tenant repository is asynchronous and tenant-scoped", async () => {
  const tenant = await getCloudTenantById(db, "tenant-a");
  assert.equal(tenant?.id, "tenant-a");
  assert.equal(tenant?.slug, "alpha");
  assert.equal((await getCloudTenantBySlug(db, "alpha"))?.id, "tenant-a");
});

test("cloud customer tenant creation uses the tenant id supplied by provisioning", async () => {
  const created = await createCloudCustomerTenant(db, {
    id: "tenant-a",
    name: "Alpha",
    slug: "alpha",
    now: "2026-10-07T00:00:00.000Z",
  });
  assert.equal(created.id, "tenant-a");
  assert.equal(created.kind, "customer");
});
