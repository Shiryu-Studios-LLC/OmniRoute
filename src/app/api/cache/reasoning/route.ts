import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { PLATFORM_TENANT_ID } from "@/lib/db/tenantScope";
import { getTenantContext, runWithTenantContext } from "@/lib/tenantContext";
import { extractApiKey } from "@/sse/services/auth";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import {
  clearReasoningCacheAll,
  deleteReasoningCacheEntry,
  getReasoningCacheServiceEntries,
  getReasoningCacheServiceStats,
} from "@omniroute/open-sse/services/reasoningCache.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

function errorMessage(error: unknown): string {
  return sanitizeErrorMessage(error);
}

async function runInAuthenticatedTenant<T>(request: Request, action: () => T): Promise<T | null> {
  const apiKey = extractApiKey(request, { allowUrl: false });
  if (apiKey) {
    const metadata = await getApiKeyMetadata(apiKey);
    if (!metadata?.tenantId?.trim()) return null;
    return runWithTenantContext({ tenantId: metadata.tenantId, principalId: metadata.id }, action);
  }

  const existingContext = getTenantContext();
  if (existingContext) return runWithTenantContext(existingContext, action);

  if (await isDashboardSessionAuthenticated(request)) {
    return runWithTenantContext(
      { tenantId: PLATFORM_TENANT_ID, principalId: "dashboard", role: "owner" },
      action
    );
  }

  // Other management credentials need an upstream authenticated tenant context.
  return null;
}

/**
 * GET /api/cache/reasoning
 *
 * Returns reasoning replay cache stats + paginated entries.
 * Query params: ?provider=deepseek&model=deepseek-reasoner&limit=50&offset=0
 */
export async function GET(req: NextRequest) {
  const authError = await requireManagementAuth(req, { alwaysRequireAuth: true });
  if (authError) return authError;

  try {
    const { searchParams } = new URL(req.url);
    const provider = searchParams.get("provider") || undefined;
    const model = searchParams.get("model") || undefined;
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    const scopedResult = await runInAuthenticatedTenant(req, () => ({
      stats: getReasoningCacheServiceStats(),
      entries: getReasoningCacheServiceEntries({
        limit: Math.min(Math.max(limit, 1), 200),
        offset: Math.max(offset, 0),
        provider,
        model,
      }),
    }));
    if (!scopedResult)
      return NextResponse.json({ error: "Authenticated tenant required" }, { status: 403 });

    return NextResponse.json(scopedResult);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

/**
 * DELETE /api/cache/reasoning
 *
 * Clears reasoning cache entries.
 * Query params: ?toolCallId=call_abc (single entry), ?provider=deepseek, or no params.
 */
export async function DELETE(req: NextRequest) {
  const authError = await requireManagementAuth(req, { alwaysRequireAuth: true });
  if (authError) return authError;

  try {
    const { searchParams } = new URL(req.url);
    const toolCallId = searchParams.get("toolCallId") || undefined;
    const provider = searchParams.get("provider") || undefined;

    const result = await runInAuthenticatedTenant(req, () => {
      if (toolCallId) {
        const cleared = deleteReasoningCacheEntry(toolCallId);
        return { ok: true, cleared, scope: "toolCallId", toolCallId };
      }
      const cleared = clearReasoningCacheAll(provider);
      return {
        ok: true,
        cleared,
        scope: provider ? "provider" : "all",
        ...(provider ? { provider } : {}),
      };
    });
    if (!result)
      return NextResponse.json({ error: "Authenticated tenant required" }, { status: 403 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
