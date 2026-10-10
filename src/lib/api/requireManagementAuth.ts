import { isAuthRequired, isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { isCliTokenAuthValid } from "@/lib/middleware/cliTokenAuth";
import { evaluateAccessTokenAuth } from "@/server/authz/accessTokenAuth";
import { isTrustedLoopbackInternalServiceRequest } from "@/lib/api/internalServiceAuth";
import { AUTHZ_HEADER_AUTH_KIND, AUTHZ_HEADER_AUTH_LABEL } from "@/server/authz/headers";
import { enterTenantContext, getCurrentTenantId, runWithTenantContext } from "@/lib/tenantContext";
import { enterApiKeyTenantContext } from "@/server/authz/tenantMembership";
import { getTenantById, getTenantMemberRole, SHIRYU_ADMIN_TENANT_ID } from "@/lib/db/tenants";
import {
  getTenantManagementPermission,
  hasTenantManagementPermission,
} from "@/server/authz/tenantPermissions";
import {
  MANAGE_SCOPE,
  MCP_CONNECT_SCOPE,
  hasManageScope as hasManageScopeShared,
  hasMcpConnectOrManageScope,
} from "@/shared/constants/managementScopes";

export { MANAGE_SCOPE };

/**
 * Check whether any of the supplied scopes authorizes management API access.
 *
 * Re-exported here for backwards compatibility with existing callers. The
 * canonical definition lives in `@/shared/constants/managementScopes`.
 */
export function hasManageScope(scopes: string[] = []): boolean {
  return hasManageScopeShared(scopes);
}

export interface RequireManagementAuthOptions {
  alwaysRequireAuth?: boolean;
  invalidApiKeyStatus?: 401 | 403;
  /**
   * Accept the narrow `mcp:connect` scope in the API-key branch, mirroring the
   * #9159 carve-out the central managementPolicy already applies to /api/mcp/*
   * paths. Only the MCP transport routes (stream/sse/status/tools) may enable
   * this — every other management route stays manage/admin-only.
   */
  acceptMcpConnectScope?: boolean;
}

type AcceptedManagementPrincipal = { kind: "platform" } | { kind: "api_key"; apiKey: string };

function invalidManagementTokenResponse(options: RequireManagementAuthOptions): Response {
  const status = options.invalidApiKeyStatus ?? 403;
  return createErrorResponse({
    status,
    message: status === 401 ? "Invalid API key" : "Invalid management token",
    type: "invalid_request",
  });
}

export async function requireManagementAuth(
  request: Request,
  options: RequireManagementAuthOptions = {},
  onAccepted?: (principal: AcceptedManagementPrincipal) => void
): Promise<Response | null> {
  if (!options.alwaysRequireAuth && !(await isAuthRequired(request))) {
    onAccepted?.({ kind: "platform" });
    return null;
  }

  if (await isDashboardSessionAuthenticated(request)) {
    enterTenantContext({
      tenantId: SHIRYU_ADMIN_TENANT_ID,
      principalId: "dashboard",
      role: "owner",
    });
    onAccepted?.({ kind: "platform" });
    return null;
  }

  if (isTrustedLoopbackInternalServiceRequest(request)) {
    onAccepted?.({ kind: "platform" });
    return null;
  }

  // The authz pipeline strips the raw machine-token header after it validates it
  // and forwards this trusted subject stamp to route handlers.
  if (
    request.headers.get(AUTHZ_HEADER_AUTH_KIND) === "management_key" &&
    request.headers.get(AUTHZ_HEADER_AUTH_LABEL) === "local-cli-token"
  ) {
    onAccepted?.({ kind: "platform" });
    return null;
  }

  // Direct/raw-Node callers without the central pipeline can still validate the
  // CLI token here, including the trusted peer-locality stamp path.
  if (await isCliTokenAuthValid(request)) {
    onAccepted?.({ kind: "platform" });
    return null;
  }

  // Scoped CLI access token (remote mode). Intercepted BEFORE the API-key branch:
  // these `oma_` tokens are management/CLI credentials, not inference API keys,
  // and would otherwise be rejected by isValidApiKey. Same shared evaluation the
  // central managementPolicy uses (no drift). Dashboard JWT, the loopback CLI
  // token, and manage-scope API keys remain full-access above/below.
  const accessVerdict = evaluateAccessTokenAuth(request);
  switch (accessVerdict.kind) {
    case "ok":
      onAccepted?.({ kind: "platform" });
      return null;
    case "error":
      return createErrorResponse({
        status: 503,
        message: "Service temporarily unavailable",
        type: "server_error",
      });
    case "invalid":
      return createErrorResponse({
        status: 401,
        message: "Invalid or expired access token",
        type: "invalid_request",
      });
    case "insufficient":
      return createErrorResponse({
        status: 403,
        message: `Access token scope '${accessVerdict.have}' is insufficient; '${accessVerdict.need}' required.`,
        type: "invalid_request",
      });
    case "absent":
      break; // no oma_ token → fall through to API-key auth
  }

  // Management auth never honours a URL-borne credential (header-only) — a token
  // in the path/query must not authenticate a management route. See #3300 follow-up.
  const apiKey = extractApiKey(request, { allowUrl: false });
  if (apiKey) {
    let meta: Awaited<ReturnType<typeof getApiKeyMetadata>>;
    try {
      if (!(await isValidApiKey(apiKey))) {
        return invalidManagementTokenResponse(options);
      }
      meta = await getApiKeyMetadata(apiKey);
    } catch {
      return createErrorResponse({
        status: 503,
        message: "Service temporarily unavailable",
        type: "server_error",
      });
    }

    // API-key branch: with acceptMcpConnectScope (MCP transport routes) the
    // #9159 carve-out applies — hasMcpConnectOrManageScope accepts manage,
    // admin, and mcp:connect. Without it, the guard stays manage-only. A null
    // meta (valid key, metadata unavailable — deleted mid-request) falls
    // through to the same 403 as the default path for every caller, keeping
    // the error contract uniform.
    if (meta?.tenantId) {
      enterApiKeyTenantContext(meta.tenantId, meta.id);
    }

    if (
      meta &&
      (options.acceptMcpConnectScope
        ? hasMcpConnectOrManageScope(meta.scopes)
        : hasManageScope(meta.scopes))
    ) {
      onAccepted?.({ kind: "api_key", apiKey });
      return null;
    }

    return createErrorResponse({
      status: 403,
      message: options.acceptMcpConnectScope
        ? `API key lacks '${MCP_CONNECT_SCOPE}' (or 'manage') scope. Enable it in the API Keys dashboard.`
        : "API key lacks 'manage' scope. Enable it in the API Keys dashboard.",
      type: "invalid_request",
    });
  }

  return createErrorResponse({
    status: 401,
    message: "Authentication required",
    type: "invalid_request",
  });
}

/**
 * Authenticate a management request and execute its handler inside the
 * authenticated tenant's async context. `enterTenantContext()` called from
 * this async helper does not reliably flow back to a caller that resumes after
 * awaiting it, so tenant-scoped handlers must use this callback form.
 */
export async function withManagementTenantContext<T>(
  request: Request,
  handler: () => Promise<T>,
  resolveContextApiKeyMetadata: typeof getApiKeyMetadata = getApiKeyMetadata,
  acceptTrustedPlatformRequest?: (request: Request) => boolean,
  authOptions: RequireManagementAuthOptions = {}
): Promise<T | Response> {
  const acceptedPrincipal: { value: AcceptedManagementPrincipal | null } = { value: null };
  const trustedPlatformRequest = acceptTrustedPlatformRequest?.(request) === true;
  const authError = trustedPlatformRequest
    ? null
    : await requireManagementAuth(request, authOptions, (principal) => {
        acceptedPrincipal.value = principal;
      });
  if (trustedPlatformRequest) acceptedPrincipal.value = { kind: "platform" };
  if (authError) return authError;

  if (acceptedPrincipal.value?.kind === "api_key") {
    try {
      // Re-read metadata after authentication so a key revoked/deleted between
      // auth and context setup cannot fall through to platform access.
      const metadata = await resolveContextApiKeyMetadata(acceptedPrincipal.value.apiKey);
      if (
        !metadata?.id ||
        !metadata.tenantId ||
        !hasManageScope(metadata.scopes) ||
        metadata.isActive === false ||
        metadata.isBanned === true ||
        Boolean(metadata.revokedAt) ||
        Boolean(metadata.expiresAt && new Date(metadata.expiresAt).getTime() <= Date.now())
      ) {
        return createErrorResponse({
          status: 403,
          message: "API key tenant is not available",
          type: "invalid_request",
        });
      }

      const tenant = getTenantById(metadata.tenantId);
      if (!tenant || !tenant.isActive) {
        return createErrorResponse({
          status: 403,
          message: "API key tenant is not available",
          type: "invalid_request",
        });
      }

      const role = getTenantMemberRole(metadata.tenantId, metadata.id);
      if (tenant.kind === "customer" && !role) {
        return createErrorResponse({
          status: 403,
          message: "Tenant membership is required for customer management access",
          type: "invalid_request",
        });
      }

      const requiredPermission = getTenantManagementPermission(
        new URL(request.url).pathname,
        request.method
      );
      if (role && requiredPermission && !hasTenantManagementPermission(role, requiredPermission)) {
        return createErrorResponse({
          status: 403,
          message: "Tenant role does not permit this operation",
          type: "invalid_request",
        });
      }

      return runWithTenantContext(
        {
          tenantId: metadata.tenantId,
          principalId: metadata.id,
          ...(role ? { role } : {}),
        },
        handler
      );
    } catch {
      return createErrorResponse({
        status: 503,
        message: "Service temporarily unavailable",
        type: "server_error",
      });
    }
  }

  // Authentication precedence is captured by requireManagementAuth. Dashboard,
  // access-token, CLI, trusted internal, and system-stamped credentials remain
  // platform principals even if a request also carries an unrelated API key.
  // `requireLogin=false` also preserves the legacy single-operator mode.
  return runWithTenantContext(
    { tenantId: SHIRYU_ADMIN_TENANT_ID, principalId: "management" },
    handler
  );
}

/**
 * Authenticate and run a process-wide management operation as the platform
 * tenant only. Use this for settings and runtime state that have no tenant
 * partition, so a customer key cannot read or mutate shared state.
 */
export async function withPlatformAdminManagementContext<T>(
  request: Request,
  handler: () => Promise<T>,
  authOptions: RequireManagementAuthOptions = {}
): Promise<T | Response> {
  return withManagementTenantContext(
    request,
    async () => {
      if (getCurrentTenantId() !== SHIRYU_ADMIN_TENANT_ID) {
        return createErrorResponse({
          status: 403,
          message: "Platform administrator required",
          type: "invalid_request",
        });
      }
      return handler();
    },
    getApiKeyMetadata,
    undefined,
    authOptions
  );
}
