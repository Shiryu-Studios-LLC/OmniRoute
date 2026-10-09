import type { CloudDb } from "./db";
import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";

export const CLOUD_CUSTOMER_ONBOARDING_PATH = "/__cloud/v1/customer/onboarding";

const AUTH_RATE_LIMIT = { limit: 600, windowMs: 60_000 };
const AUTH_FALLBACK_RATE_LIMIT = { limit: 100, windowMs: 60_000 };
const TENANT_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

interface OnboardingStatusRow {
  active_owner: number;
  oidc_configured: number;
  oidc_enabled: number;
  active_provider_connection: number;
  enabled_inference_entitlement: number;
  registered_device: number;
  local_ai_enabled: number;
  mcp_enabled: number;
}

export interface CloudCustomerOnboardingApiOptions {
  db?: CloudDb;
  now?: () => Date;
  /** Test overrides for the public authentication and tenant request guards. */
  failedKeyRateLimit?: { limit: number; windowMs: number };
  failedKeyFallbackRateLimit?: { limit: number; windowMs: number };
  tenantRateLimit?: { limit: number; windowMs: number };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Read-only tenant readiness flags are scoped only by the authenticated API key. */
export async function handleCloudCustomerOnboardingRequest(
  request: Request,
  options: CloudCustomerOnboardingApiOptions
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== CLOUD_CUSTOMER_ONBOARDING_PATH) return null;
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (url.search !== "") return json({ error: "Query parameters are not supported" }, 400);
  if (!options.db) return json({ error: "Cloud database is not configured" }, 503);

  const now = options.now ?? (() => new Date());
  const clientIpBucket = cloudflareClientIpBucket(request);
  try {
    const authLimit = await consumeCloudRateLimit(options.db, {
      tenantId: "tenant_shiryu_admin",
      bucketKey: `customer-onboarding-auth:${clientIpBucket ?? "fallback"}`,
      ...(clientIpBucket
        ? (options.failedKeyRateLimit ?? AUTH_RATE_LIMIT)
        : (options.failedKeyFallbackRateLimit ?? AUTH_FALLBACK_RATE_LIMIT)),
      nowMs: now().getTime(),
    });
    if (!authLimit.allowed) return json({ error: "Authentication rate limit exceeded" }, 429);
  } catch {
    return json({ error: "Authentication rate limit is unavailable" }, 503);
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (orc_live_[A-Za-z0-9_-]{1,96})$/.exec(authorization);
  if (!match) return json({ error: "Unauthorized" }, 401);

  let identity;
  try {
    identity = await authenticateCloudCustomerApiKey(options.db, match[1], now().toISOString());
  } catch {
    return json({ error: "Customer authentication is unavailable" }, 503);
  }
  if (!identity) return json({ error: "Unauthorized" }, 401);

  try {
    const limit = await consumeCloudRateLimit(options.db, {
      tenantId: identity.tenantId,
      bucketKey: "customer-onboarding-status",
      ...(options.tenantRateLimit ?? TENANT_RATE_LIMIT),
      nowMs: now().getTime(),
    });
    if (!limit.allowed) return json({ error: "Customer onboarding rate limit exceeded" }, 429);
  } catch {
    return json({ error: "Customer onboarding rate limit is unavailable" }, 503);
  }

  if (identity.role !== "owner" && identity.role !== "admin") {
    return json({ error: "Owner or admin membership is required" }, 403);
  }

  try {
    const row = await options.db
      .prepare<OnboardingStatusRow>(
        `SELECT
           EXISTS (
             SELECT 1 FROM cloud_customer_memberships m
              WHERE m.tenant_id = t.id AND m.role = 'owner' AND m.is_active = 1
           ) AS active_owner,
           EXISTS (
             SELECT 1 FROM cloud_tenant_oidc_configs o WHERE o.tenant_id = t.id
           ) AS oidc_configured,
           EXISTS (
             SELECT 1 FROM cloud_tenant_oidc_configs o
              WHERE o.tenant_id = t.id AND o.is_enabled = 1
           ) AS oidc_enabled,
           EXISTS (
             SELECT 1 FROM provider_connections p
              WHERE p.tenant_id = t.id AND p.is_active = 1
           ) AS active_provider_connection,
           EXISTS (
             SELECT 1 FROM cloud_inference_entitlements e
              WHERE e.tenant_id = t.id AND e.enabled = 1
           ) AS enabled_inference_entitlement,
           EXISTS (
             SELECT 1 FROM cloud_gateway_devices d
              WHERE d.tenant_id = t.id AND d.revoked_at IS NULL
           ) AS registered_device,
           s.local_ai_enabled,
           s.mcp_enabled
         FROM tenants t
         JOIN cloud_tenant_settings s ON s.tenant_id = t.id
        WHERE t.id = ? AND t.kind = 'customer' AND t.is_active = 1
        LIMIT 1`
      )
      .bind(identity.tenantId)
      .first();
    if (!row) return json({ error: "Customer onboarding status is unavailable" }, 503);
    return json({
      activeOwner: row.active_owner === 1,
      oidcConfigured: row.oidc_configured === 1,
      oidcEnabled: row.oidc_enabled === 1,
      activeProviderConnection: row.active_provider_connection === 1,
      enabledInferenceEntitlement: row.enabled_inference_entitlement === 1,
      registeredDevice: row.registered_device === 1,
      localAiEnabled: row.local_ai_enabled === 1,
      mcpEnabled: row.mcp_enabled === 1,
    });
  } catch {
    return json({ error: "Customer onboarding status is unavailable" }, 503);
  }
}
