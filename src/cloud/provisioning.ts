import type { CloudDb } from "./db";
import {
  createCloudCustomerMembership,
  issueCloudCustomerApiKey,
  type IssuedCloudCustomerApiKey,
} from "./customerIdentity";
import { getCloudTenantById, type CloudTenant } from "./tenants";
import { getCloudTenantSettings, type CloudTenantSettings } from "./tenantSettings";

interface ProvisionedCloudCustomerBase {
  tenant: CloudTenant;
  settings: CloudTenantSettings;
}

export interface ProvisionedCloudCustomer extends ProvisionedCloudCustomerBase {
  ownerMembership: { id: string; tenantId: string; principalId: string; role: "owner" };
  ownerApiKey: IssuedCloudCustomerApiKey;
}

export interface ProvisionedOidcPendingCloudCustomer extends ProvisionedCloudCustomerBase {
  ownerMembership: null;
  ownerApiKey: null;
  bootstrapMode: "oidc_pending";
}

export type CloudCustomerProvisioningInput =
  | { id: string; name: string; slug: string; ownerPrincipalId: string; now: string }
  | { id: string; name: string; slug: string; bootstrapMode: "oidc_pending"; now: string };

/** Create the tenant, owner principal binding, and one-time API key as one compensated operation. */
export function provisionCloudCustomer(
  db: CloudDb,
  input: Extract<CloudCustomerProvisioningInput, { ownerPrincipalId: string }>
): Promise<ProvisionedCloudCustomer>;
export function provisionCloudCustomer(
  db: CloudDb,
  input: Extract<CloudCustomerProvisioningInput, { bootstrapMode: "oidc_pending" }>
): Promise<ProvisionedOidcPendingCloudCustomer>;
export async function provisionCloudCustomer(
  db: CloudDb,
  input: CloudCustomerProvisioningInput
): Promise<ProvisionedCloudCustomer | ProvisionedOidcPendingCloudCustomer> {
  let tenantInserted = false;
  try {
    const insertResult = await db
      .prepare(
        `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'customer', 1, ?, ?)`
      )
      .bind(input.id, input.name, input.slug, input.now, input.now)
      .run();
    tenantInserted =
      insertResult.success &&
      (insertResult.meta?.changes === undefined || Number(insertResult.meta.changes) > 0);
    if (!insertResult.success || !tenantInserted) {
      throw new Error("Customer tenant could not be created");
    }

    const [tenant, settings] = await Promise.all([
      getCloudTenantById(db, input.id),
      getCloudTenantSettings(db, input.id),
    ]);
    if (!tenant) throw new Error("Provisioned customer tenant could not be read back");
    if (!settings) throw new Error("Provisioned customer tenant settings could not be read back");

    if ("bootstrapMode" in input) {
      return {
        tenant,
        settings,
        ownerMembership: null,
        ownerApiKey: null,
        bootstrapMode: "oidc_pending",
      };
    }

    const ownerMembership = await createCloudCustomerMembership(db, {
      tenantId: input.id,
      principalId: input.ownerPrincipalId,
      role: "owner",
      now: input.now,
    });
    const ownerApiKey = await issueCloudCustomerApiKey(db, {
      tenantId: input.id,
      membershipId: ownerMembership.id,
      now: input.now,
    });
    return { tenant, settings, ownerMembership, ownerApiKey };
  } catch (error) {
    if (tenantInserted) {
      try {
        const rollback = await db
          .prepare("DELETE FROM tenants WHERE id = ? AND kind = 'customer'")
          .bind(input.id)
          .run();
        if (
          !rollback.success ||
          (rollback.meta?.changes !== undefined && Number(rollback.meta.changes) !== 1)
        ) {
          throw new Error("Customer provisioning rollback did not delete the tenant");
        }
      } catch {
        throw new Error("Customer provisioning failed and rollback could not be confirmed");
      }
    }
    throw error;
  }
}

/** Remove a just-provisioned tenant if its final audit record could not be written. */
export async function rollbackCloudCustomerProvisioning(
  db: CloudDb,
  tenantId: string
): Promise<void> {
  const result = await db
    .prepare("DELETE FROM tenants WHERE id = ? AND kind = 'customer'")
    .bind(tenantId)
    .run();
  if (
    !result.success ||
    (result.meta?.changes !== undefined && Number(result.meta.changes) !== 1)
  ) {
    throw new Error("Customer provisioning rollback failed");
  }
}
