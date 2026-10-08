import { createErrorResponse } from "./errorResponse";
import { requireManagementAuth } from "./requireManagementAuth";
import { getCurrentTenantId } from "@/lib/tenantContext";
import { SHIRYU_ADMIN_TENANT_ID } from "@/lib/db/tenants";

/** Authenticate a management caller and restrict shared platform policy to Shiryu admins. */
export async function requirePlatformAdminManagement(request: Request): Promise<Response | null> {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  if (getCurrentTenantId() !== SHIRYU_ADMIN_TENANT_ID) {
    return createErrorResponse({ status: 403, message: "Platform administrator required" });
  }

  return null;
}
