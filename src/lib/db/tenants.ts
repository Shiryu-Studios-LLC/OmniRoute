/**
 * Tenant domain helpers.
 *
 * The initial migration makes the existing dashboard installation the Shiryu
 * platform/admin tenant. Customer tenants are created explicitly and never
 * share provider or MCP records.
 */
import { randomUUID } from "crypto";
import { getDbInstance } from "./core";

export const SHIRYU_ADMIN_TENANT_ID = "tenant_shiryu_admin";

export type TenantKind = "platform_admin" | "customer";
export type TenantRole = "owner" | "admin" | "member" | "maintenance";

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  kind: TenantKind;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  kind: TenantKind;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function toTenant(row: TenantRow | undefined): TenantRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    isActive: row.is_active !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getTenantById(id: string): TenantRecord | null {
  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM tenants WHERE id = ? LIMIT 1").get(id) as unknown as
    | TenantRow
    | undefined;
  return toTenant(row);
}

export function getTenantBySlug(slug: string): TenantRecord | null {
  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM tenants WHERE slug = ? LIMIT 1").get(slug) as unknown as
    | TenantRow
    | undefined;
  return toTenant(row);
}

export function getShiryuAdminTenant(): TenantRecord {
  const tenant = getTenantById(SHIRYU_ADMIN_TENANT_ID);
  if (!tenant) {
    throw new Error("Shiryu admin tenant is not initialized");
  }
  return tenant;
}

export function getTenantMemberRole(
  tenantId: string,
  principalId: string
): TenantRole | null {
  const db = getDbInstance();
  const row = db
    .prepare(
      "SELECT role FROM tenant_members WHERE tenant_id = ? AND principal_id = ? LIMIT 1"
    )
    .get(tenantId, principalId) as { role?: unknown } | undefined;
  return typeof row?.role === "string" ? (row.role as TenantRole) : null;
}

export function createCustomerTenant(name: string, slug: string): TenantRecord {
  const db = getDbInstance();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at) VALUES (?, ?, ?, 'customer', 1, ?, ?)"
  ).run(id, name, slug, now, now);
  const tenant = getTenantById(id);
  if (!tenant) throw new Error("Failed to create tenant");
  return tenant;
}
