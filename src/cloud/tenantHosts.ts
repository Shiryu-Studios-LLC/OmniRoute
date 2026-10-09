import type { CloudDb } from "./db";

export interface CloudAdminVerifiedCustomerHost {
  hostname: string;
  tenantId: string;
  verifiedAt: string;
  verifiedBy: string;
  createdAt: string;
}

interface HostRow {
  hostname: string;
  tenant_id: string;
  verified_at: string;
  verified_by: string;
  created_at: string;
}

function mapHost(row: HostRow): CloudAdminVerifiedCustomerHost {
  return {
    hostname: row.hostname,
    tenantId: row.tenant_id,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    createdAt: row.created_at,
  };
}

export function normalizeCustomerHostname(value: string): string | null {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    hostname.length < 1 ||
    hostname.length > 253 ||
    hostname.includes("..") ||
    hostname.startsWith("*.") ||
    hostname.includes("*") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      hostname
    )
  ) {
    return null;
  }
  return hostname;
}

export async function registerAdminVerifiedCustomerHost(
  db: CloudDb,
  input: { hostname: string; tenantId: string; verifiedAt: string; verifiedBy: string }
): Promise<CloudAdminVerifiedCustomerHost | null> {
  const statement = prepareAdminVerifiedCustomerHostInsert(db, input);
  const result = await statement.run();
  if (!result.success || Number(result.meta?.changes ?? 0) !== 1) return null;
  return getAdminVerifiedCustomerHost(db, input.hostname);
}

export function prepareAdminVerifiedCustomerHostInsert(
  db: CloudDb,
  input: { hostname: string; tenantId: string; verifiedAt: string; verifiedBy: string }
) {
  // This is deliberately a platform-admin operation. The admin must complete
  // hostname ownership verification out of band before this row is inserted;
  // this Worker slice does not claim or perform DNS verification itself.
  const hostname = normalizeCustomerHostname(input.hostname);
  if (!hostname) throw new TypeError("Invalid customer hostname");
  return db
    .prepare(
      `INSERT INTO cloud_verified_customer_hosts
         (hostname, tenant_id, verified_at, verified_by, created_at)
       SELECT ?, t.id, ?, ?, ? FROM tenants t
        WHERE t.id = ? AND t.kind = 'customer' AND t.is_active = 1`
    )
    .bind(hostname, input.verifiedAt, input.verifiedBy, input.verifiedAt, input.tenantId);
}

export async function listAdminVerifiedCustomerHosts(
  db: CloudDb,
  tenantId: string
): Promise<CloudAdminVerifiedCustomerHost[]> {
  const result = await db
    .prepare<HostRow>(
      `SELECT h.hostname, h.tenant_id, h.verified_at, h.verified_by, h.created_at
         FROM cloud_verified_customer_hosts h
         JOIN tenants t ON t.id = h.tenant_id
        WHERE h.tenant_id = ? AND t.kind = 'customer'
        ORDER BY h.hostname`
    )
    .bind(tenantId)
    .all<HostRow>();
  if (!result.success) throw new Error("D1 customer host list failed");
  return result.results.map(mapHost);
}

export async function getAdminVerifiedCustomerHost(
  db: CloudDb,
  hostnameValue: string
): Promise<CloudAdminVerifiedCustomerHost | null> {
  const hostname = normalizeCustomerHostname(hostnameValue);
  if (!hostname) return null;
  const row = await db
    .prepare<HostRow>(
      `SELECT h.hostname, h.tenant_id, h.verified_at, h.verified_by, h.created_at
         FROM cloud_verified_customer_hosts h
         JOIN tenants t ON t.id = h.tenant_id
        WHERE h.hostname = ? AND t.kind = 'customer' AND t.is_active = 1
        LIMIT 1`
    )
    .bind(hostname)
    .first<HostRow>();
  return row ? mapHost(row) : null;
}

export async function removeAdminVerifiedCustomerHost(
  db: CloudDb,
  hostnameValue: string,
  tenantId: string
): Promise<boolean> {
  const result = await prepareRemoveAdminVerifiedCustomerHost(db, hostnameValue, tenantId).run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}

export function prepareRemoveAdminVerifiedCustomerHost(
  db: CloudDb,
  hostnameValue: string,
  tenantId: string
) {
  const hostname = normalizeCustomerHostname(hostnameValue);
  if (!hostname) throw new TypeError("Invalid customer hostname");
  return db
    .prepare("DELETE FROM cloud_verified_customer_hosts WHERE hostname = ? AND tenant_id = ?")
    .bind(hostname, tenantId);
}
