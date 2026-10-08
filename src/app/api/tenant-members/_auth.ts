import { createErrorResponse } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getTenantMemberRole, type TenantRole } from "@/lib/db/tenants";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { extractApiKey } from "@/sse/services/auth";

export interface TenantMembershipRequestPrincipal {
  tenantId: string;
  principalId: string;
  role: TenantRole;
}

export async function authorizeTenantMembershipRequest(
  request: Request,
  permission: "read" | "manage"
): Promise<{ principal: TenantMembershipRequestPrincipal } | { response: Response }> {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return { response: authError };

  const key = extractApiKey(request, { allowUrl: false });
  if (!key) {
    return {
      response: createErrorResponse({
        status: 403,
        message: "Tenant membership requires an API-key principal",
      }),
    };
  }

  let metadata: Awaited<ReturnType<typeof getApiKeyMetadata>>;
  try {
    metadata = await getApiKeyMetadata(key);
  } catch {
    return {
      response: createErrorResponse({ status: 503, message: "Service temporarily unavailable" }),
    };
  }
  if (!metadata?.tenantId || !metadata.id) {
    return {
      response: createErrorResponse({ status: 403, message: "Tenant API-key principal required" }),
    };
  }

  const role = getTenantMemberRole(metadata.tenantId, metadata.id);
  if (!role) {
    return {
      response: createErrorResponse({ status: 403, message: "Tenant membership is required" }),
    };
  }
  if (permission === "manage" && role !== "owner" && role !== "admin") {
    return {
      response: createErrorResponse({
        status: 403,
        message: "Tenant owner or admin role required",
      }),
    };
  }
  return {
    principal: { tenantId: metadata.tenantId, principalId: metadata.id, role },
  };
}
