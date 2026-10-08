import { randomUUID } from "crypto";
import { getDbInstance } from "./core";
import type { TenantRole } from "./tenants";

export interface TenantMembershipRecord {
  principalId: string;
  role: TenantRole;
  createdAt: string;
  updatedAt: string;
}

interface MembershipRow {
  principal_id: string;
  role: TenantRole;
  created_at: string;
  updated_at: string;
}

const VALID_ROLES = new Set<TenantRole>(["owner", "admin", "member", "maintenance"]);

function isTenantRole(value: string): value is TenantRole {
  return VALID_ROLES.has(value as TenantRole);
}

function toMembership(row: MembershipRow): TenantMembershipRecord {
  return {
    principalId: row.principal_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** True only for a persisted API-key principal owned by this tenant. */
export function isTenantApiKeyPrincipal(tenantId: string, principalId: string): boolean {
  const row = getDbInstance()
    .prepare("SELECT 1 AS present FROM api_keys WHERE id = ? AND tenant_id = ? LIMIT 1")
    .get(principalId, tenantId) as { present?: number } | undefined;
  return row?.present === 1;
}

export function listTenantMemberships(tenantId: string): TenantMembershipRecord[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT principal_id, role, created_at, updated_at
       FROM tenant_members WHERE tenant_id = ? ORDER BY created_at, principal_id`
    )
    .all(tenantId) as MembershipRow[];
  return rows.map(toMembership);
}

/** Add a role for an API-key principal after verifying its tenant ownership. */
export function addTenantMembership(
  tenantId: string,
  principalId: string,
  role: TenantRole
): TenantMembershipRecord {
  if (!isTenantRole(role)) throw new Error("Invalid tenant role");
  const db = getDbInstance();
  const transaction = db.transaction(() => {
    const key = db
      .prepare("SELECT 1 AS present FROM api_keys WHERE id = ? AND tenant_id = ? LIMIT 1")
      .get(principalId, tenantId) as { present?: number } | undefined;
    if (key?.present !== 1) throw new Error("API-key principal not found in tenant");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tenant_members (id, tenant_id, principal_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), tenantId, principalId, role, now, now);
  });
  transaction();
  const member = getTenantMembership(tenantId, principalId);
  if (!member) throw new Error("Failed to create tenant membership");
  return member;
}

export function getTenantMembership(
  tenantId: string,
  principalId: string
): TenantMembershipRecord | null {
  const row = getDbInstance()
    .prepare(
      `SELECT principal_id, role, created_at, updated_at FROM tenant_members
       WHERE tenant_id = ? AND principal_id = ? LIMIT 1`
    )
    .get(tenantId, principalId) as MembershipRow | undefined;
  return row ? toMembership(row) : null;
}

export function updateTenantMembershipRole(
  tenantId: string,
  principalId: string,
  role: TenantRole
): TenantMembershipRecord | null {
  if (!isTenantRole(role)) throw new Error("Invalid tenant role");
  const db = getDbInstance();
  const transaction = db.transaction(() => {
    const key = db
      .prepare("SELECT 1 AS present FROM api_keys WHERE id = ? AND tenant_id = ? LIMIT 1")
      .get(principalId, tenantId) as { present?: number } | undefined;
    if (key?.present !== 1) return false;
    const current = db
      .prepare("SELECT role FROM tenant_members WHERE tenant_id = ? AND principal_id = ? LIMIT 1")
      .get(tenantId, principalId) as { role?: string } | undefined;
    if (!current) return false;
    if (current.role === "owner" && role !== "owner") {
      const owners = db
        .prepare(
          "SELECT COUNT(*) AS count FROM tenant_members WHERE tenant_id = ? AND role = 'owner'"
        )
        .get(tenantId) as { count: number };
      if (owners.count <= 1) throw new Error("Cannot demote the last tenant owner");
    }
    db.prepare(
      "UPDATE tenant_members SET role = ?, updated_at = ? WHERE tenant_id = ? AND principal_id = ?"
    ).run(role, new Date().toISOString(), tenantId, principalId);
    return true;
  });
  if (!transaction()) return null;
  return getTenantMembership(tenantId, principalId);
}

export function removeTenantMembership(tenantId: string, principalId: string): boolean {
  const db = getDbInstance();
  const transaction = db.transaction(() => {
    const key = db
      .prepare("SELECT 1 AS present FROM api_keys WHERE id = ? AND tenant_id = ? LIMIT 1")
      .get(principalId, tenantId) as { present?: number } | undefined;
    if (key?.present !== 1) return false;
    const current = db
      .prepare("SELECT role FROM tenant_members WHERE tenant_id = ? AND principal_id = ? LIMIT 1")
      .get(tenantId, principalId) as { role?: string } | undefined;
    if (!current) return false;
    if (current.role === "owner") {
      const owners = db
        .prepare(
          "SELECT COUNT(*) AS count FROM tenant_members WHERE tenant_id = ? AND role = 'owner'"
        )
        .get(tenantId) as { count: number };
      if (owners.count <= 1) throw new Error("Cannot remove the last tenant owner");
    }
    db.prepare("DELETE FROM tenant_members WHERE tenant_id = ? AND principal_id = ?").run(
      tenantId,
      principalId
    );
    return true;
  });
  return transaction();
}
