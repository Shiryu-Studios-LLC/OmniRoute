import { NextResponse } from "next/server";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { PLATFORM_TENANT_ID } from "@/lib/db/tenantScope";
import { getTenantContext } from "@/lib/tenantContext";
import { extractApiKey } from "@/sse/services/apiKeyRequest";

/**
 * Guard access to the legacy deployment-wide model alias namespace.
 *
 * Dashboard and legacy internal callers may have no tenant context; preserve
 * their existing platform behavior. For API-key callers, resolve the key's
 * authoritative tenant as a fallback because route handlers can run outside
 * the auth pipeline's AsyncLocalStorage continuation.
 */
export async function requirePlatformAliasAccess(request: Request): Promise<Response | null> {
  let tenantId = getTenantContext()?.tenantId;
  const apiKey = extractApiKey(request, { allowUrl: false });

  if (apiKey) {
    try {
      const metadata = await getApiKeyMetadata(apiKey);
      if (metadata?.tenantId) tenantId = metadata.tenantId;
    } catch {
      return NextResponse.json(
        { error: "Unable to authorize model alias access" },
        { status: 503 }
      );
    }
  }

  if (tenantId && tenantId !== PLATFORM_TENANT_ID) {
    return NextResponse.json(
      { error: "Global model aliases are restricted to the platform tenant" },
      { status: 403 }
    );
  }

  return null;
}
