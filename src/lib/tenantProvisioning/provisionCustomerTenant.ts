import { randomBytes } from "crypto";
import { logAuditEvent } from "@/lib/compliance";
import { createApiKey } from "@/lib/db/apiKeys";
import { createTenantMembership, rollbackUnpublishedTenant } from "@/lib/db/tenantProvisioning";
import {
  createCustomerTenant,
  getTenantBySlug,
  SHIRYU_ADMIN_TENANT_ID,
  type TenantRecord,
} from "@/lib/db/tenants";
import { runWithTenantContext } from "@/lib/tenantContext";

export interface VerifiedOwnerIdentity {
  /** Stable principal ID supplied by an upstream identity verifier. */
  principalId: string;
  /** True only after the upstream identity provider verified the owner identity. */
  identityVerified: true;
}

export interface ProvisionCustomerTenantInput {
  name: string;
  slug: string;
  owner: VerifiedOwnerIdentity;
  /** Stable platform-admin principal that initiated provisioning. */
  provisionedBy: string;
}

export interface ProvisionedCustomerTenant {
  tenant: TenantRecord;
  owner: { principalId: string; apiKeyPrincipalId: string; role: "owner" };
  apiKey: { id: string; name: string; key: string };
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:@._-]{1,199}$/;

function normalizedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} must be between 1 and ${maxLength} characters`);
  }
  return normalized;
}

function validatePrincipal(value: unknown, field: string): string {
  const principal = normalizedText(value, field, 200);
  if (!PRINCIPAL_PATTERN.test(principal)) throw new Error(`${field} is invalid`);
  return principal;
}

function createMachineId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Create a customer tenant, its verified owner membership, and its initial
 * tenant-bound API key. This is a server-side service only: callers must
 * authenticate a platform administrator and obtain the owner identity from a
 * trusted verifier before invoking it.
 */
export async function provisionCustomerTenant(
  input: ProvisionCustomerTenantInput
): Promise<ProvisionedCustomerTenant> {
  const name = normalizedText(input?.name, "name", 120);
  const slug = normalizedText(input?.slug, "slug", 63);
  const ownerPrincipalId = validatePrincipal(input?.owner?.principalId, "owner principalId");
  const provisionedBy = validatePrincipal(input?.provisionedBy, "provisionedBy");

  if (!SLUG_PATTERN.test(slug) || slug === "shiryu-admin") {
    throw new Error("slug must be a lowercase tenant slug");
  }
  if (input.owner.identityVerified !== true) {
    throw new Error("owner identity must be verified before provisioning");
  }
  if (getTenantBySlug(slug)) throw new Error("tenant slug is already in use");

  const tenant = createCustomerTenant(name, slug);

  try {
    const createdKey = await runWithTenantContext(
      { tenantId: tenant.id, principalId: ownerPrincipalId, role: "owner" },
      () => createApiKey(`${name} owner`, createMachineId())
    );
    // Tenant authorization resolves membership from the authenticated API-key ID.
    // Bind the verified owner's initial key so it receives the owner role.
    createTenantMembership(tenant.id, createdKey.id, "owner");

    runWithTenantContext({ tenantId: SHIRYU_ADMIN_TENANT_ID, principalId: provisionedBy }, () => {
      logAuditEvent({
        action: "tenant.provision",
        actor: provisionedBy,
        target: tenant.id,
        resourceType: "tenant",
        status: "success",
        details: {
          tenantId: tenant.id,
          slug: tenant.slug,
          ownerPrincipalId,
          apiKeyId: createdKey.id,
        },
      });
    });

    return {
      tenant,
      owner: {
        principalId: ownerPrincipalId,
        apiKeyPrincipalId: createdKey.id,
        role: "owner",
      },
      // The generated secret is returned to the caller once and is omitted
      // from audit metadata and every other field in this response.
      apiKey: { id: createdKey.id, name: createdKey.name, key: createdKey.key },
    };
  } catch (error) {
    rollbackUnpublishedTenant(tenant.id);
    throw error;
  }
}
