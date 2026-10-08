import { randomUUID } from "crypto";
import { getDbInstance } from "./core";
import type { TenantRole } from "./tenants";

export function createTenantMembership(
  tenantId: string,
  principalId: string,
  role: TenantRole
): void {
  const now = new Date().toISOString();
  getDbInstance()
    .prepare(
      `INSERT INTO tenant_members (
        id, tenant_id, principal_id, role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(randomUUID(), tenantId, principalId, role, now, now);
}

/** Remove rows created for a tenant before provisioning publishes it. */
export function rollbackUnpublishedTenant(tenantId: string): void {
  const db = getDbInstance();
  db.transaction(() => {
    // api_keys currently has no tenant foreign key, so clean it explicitly.
    db.prepare("DELETE FROM api_keys WHERE tenant_id = ?").run(tenantId);
    db.prepare("DELETE FROM tenants WHERE id = ?").run(tenantId);
  })();
}
