import test from "node:test";
import assert from "node:assert/strict";
import type { CloudDb } from "../../src/cloud/db.ts";
import { listCloudTenantPortalMembers } from "../../src/cloud/tenantMembershipManagement.ts";

test("tenant membership listing rejects an unsuccessful D1 read", async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [], success: false };
        },
      };
    },
  } as unknown as CloudDb;

  await assert.rejects(listCloudTenantPortalMembers(db, "customer-tenant"), {
    message: "D1 tenant membership list failed",
  });
});
