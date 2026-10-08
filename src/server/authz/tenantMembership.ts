import { getTenantMemberRole } from "@/lib/db/tenants";
import { enterTenantContext, type TenantRequestContext } from "@/lib/tenantContext";

/**
 * Establish the tenant context for a database-verified API key and resolve
 * any explicit tenant membership attached to that key's principal ID.
 *
 * The tenant ID must come from trusted API-key metadata, never from request
 * input. Keys without a membership retain their existing tenant context and
 * authorization behavior; this helper only adds a role when one is stored.
 */
export function enterApiKeyTenantContext(
  tenantId: string,
  principalId: string
): TenantRequestContext {
  const role = getTenantMemberRole(tenantId, principalId);
  const context: TenantRequestContext = {
    tenantId,
    principalId,
    ...(role ? { role } : {}),
  };
  enterTenantContext(context);
  return context;
}
