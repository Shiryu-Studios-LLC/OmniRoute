import { extractApiKey } from "@/sse/services/auth";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { currentDbTenantId } from "@/lib/db/tenantScope";

/**
 * Resolve tenant ownership from a validated management API key after
 * requireManagementAuth succeeds. Dashboard and trusted local management
 * requests use the active context, which defaults to the platform tenant.
 */
export async function getManagementTenantId(request: Request): Promise<string> {
  const apiKey = extractApiKey(request, { allowUrl: false });
  if (apiKey) {
    const metadata = await getApiKeyMetadata(apiKey);
    if (metadata?.tenantId) return metadata.tenantId;
  }
  return currentDbTenantId();
}
