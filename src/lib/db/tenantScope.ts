/**
 * The compatibility SQLite runtime is single-tenant until an authenticated
 * request establishes a tenant context. Its unscoped maintenance/startup
 * work therefore belongs exclusively to the existing Shiryu admin tenant.
 *
 * Caller-supplied tenant IDs are never an authorization mechanism.
 */
import { getCurrentTenantId } from "../tenantContext";

export const PLATFORM_TENANT_ID = "tenant_shiryu_admin";

export function currentDbTenantId(): string {
  return getCurrentTenantId() ?? PLATFORM_TENANT_ID;
}

export function assertTenantScope(requestedTenantId: unknown): string {
  const current = currentDbTenantId();
  if (requestedTenantId !== undefined && requestedTenantId !== current) {
    throw new Error("Cross-tenant database operation denied");
  }
  return current;
}
