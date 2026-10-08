import type { CloudDb } from "./db";

export const CLOUD_PLATFORM_TENANT_ID = "tenant_shiryu_admin";

export interface CloudTenant {
  id: string;
  name: string;
  slug: string;
  kind: "platform_admin" | "customer";
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  kind: CloudTenant["kind"];
  is_active: number;
  created_at: string;
  updated_at: string;
}

function mapTenant(row: TenantRow): CloudTenant {
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

export async function getCloudTenantById(db: CloudDb, id: string): Promise<CloudTenant | null> {
  const row = await db
    .prepare<TenantRow>(
      "SELECT id, name, slug, kind, is_active, created_at, updated_at FROM tenants WHERE id = ? LIMIT 1"
    )
    .bind(id)
    .first<TenantRow>();
  return row ? mapTenant(row) : null;
}

export async function getCloudTenantBySlug(db: CloudDb, slug: string): Promise<CloudTenant | null> {
  const row = await db
    .prepare<TenantRow>(
      "SELECT id, name, slug, kind, is_active, created_at, updated_at FROM tenants WHERE slug = ? LIMIT 1"
    )
    .bind(slug)
    .first<TenantRow>();
  return row ? mapTenant(row) : null;
}

export async function createCloudCustomerTenant(
  db: CloudDb,
  input: { id: string; name: string; slug: string; now?: string }
): Promise<CloudTenant> {
  const now = input.now ?? new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at) VALUES (?, ?, ?, 'customer', 1, ?, ?)"
    )
    .bind(input.id, input.name, input.slug, now, now)
    .run();

  const tenant = await getCloudTenantById(db, input.id);
  if (!tenant) throw new Error("Failed to create cloud tenant");
  return tenant;
}

/** Change lifecycle state for an existing customer tenant. Platform tenants cannot be changed here. */
export async function setCloudCustomerTenantActive(
  db: CloudDb,
  tenantId: string,
  isActive: boolean,
  now = new Date().toISOString()
): Promise<CloudTenant | null> {
  const result = await db
    .prepare(
      `UPDATE tenants
          SET is_active = ?, updated_at = ?
        WHERE id = ? AND kind = 'customer'`
    )
    .bind(isActive ? 1 : 0, now, tenantId)
    .run();
  if (!result.success || Number(result.meta?.changes ?? 0) !== 1) return null;
  return getCloudTenantById(db, tenantId);
}
