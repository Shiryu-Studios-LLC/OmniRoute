import type { CloudDb } from "./db";
import { handleCloudApiRequest } from "./httpApi";
import { handleGatewayDeviceRequest } from "./gatewayHttpApi";
import { handleGatewayCustomerRequest } from "./gatewayCustomerHttpApi";
import { handleCloudInferenceCustomerRequest } from "./inferenceCustomerHttpApi";
import {
  CLOUD_CUSTOMER_BUSINESS_PROFILE_PATH,
  handleCloudCustomerBusinessProfileRequest,
} from "./customerBusinessProfileHttpApi";
import {
  CLOUD_CUSTOMER_PROVIDER_CONNECTIONS_PATH,
  handleCloudCustomerProviderRequest,
} from "./customerProviderHttpApi";
import {
  CLOUD_CUSTOMER_SETTINGS_PATH,
  handleCloudCustomerSettingsRequest,
} from "./tenantSettingsHttpApi";
import {
  CLOUD_CUSTOMER_ONBOARDING_PATH,
  handleCloudCustomerOnboardingRequest,
} from "./tenantOnboardingHttpApi";
import { CLOUD_CUSTOMER_MCP_SERVERS_PATH, handleCloudTenantMcpRequest } from "./tenantMcpHttpApi";
import type { CloudMcpEgressBinding } from "./mcpEgressTransport";
import { CLOUD_CUSTOMER_PORTAL_PATH, handleCloudCustomerPortalRequest } from "./customerPortal";
import {
  CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH,
  CLOUD_TENANT_MEMBERSHIP_INVITATION_REDEEM_PATH,
  CLOUD_TENANT_MEMBERS_PATH,
  CLOUD_TENANT_API_KEYS_PATH,
  CLOUD_TENANT_BUSINESS_PROFILE_PATH,
  CLOUD_TENANT_OIDC_OWNER_CLAIM_REDEEM_PATH,
  CLOUD_TENANT_OIDC_LOGOUT_PATH,
  CLOUD_TENANT_OIDC_CALLBACK_PATH,
  CLOUD_TENANT_OIDC_LOGIN_PATH,
  CLOUD_TENANT_OIDC_SESSION_PATH,
  handleCloudTenantOidcAuthRequest,
} from "./tenantOidcAuth";
import type {
  GatewayCoordinatorStub,
  GatewayDurableObjectNamespace,
} from "./connectorGatewayDurableObject";

const CLOUD_TENANT_ADMIN_API_PATH = "/__cloud/v1/tenants";

export interface CloudRuntimeEnv {
  OMNIROUTE_ENV?: string;
  OMNIROUTE_BUILD_SHA?: string;
  DB?: CloudDb;
  OMNIROUTE_CLOUD_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_MAINTENANCE_TOKEN?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY?: string;
  OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY?: string;
  OMNIROUTE_CLOUD_PUBLIC_ORIGIN?: string;
  GATEWAY_SESSIONS?: GatewayDurableObjectNamespace<GatewayCoordinatorStub>;
  MCP_EGRESS?: CloudMcpEgressBinding;
  OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN?: string;
  OMNIROUTE_CLOUD_MCP_EGRESS_ENABLED?: string;
}

export interface CloudRuntimeOptions {
  env?: CloudRuntimeEnv;
  now?: () => Date;
  adminRateLimit?: { limit: number; windowMs: number };
  customerInvokeRateLimit?: { limit: number; windowMs: number };
  customerAuthFailureRateLimit?: { limit: number; windowMs: number };
  customerAuthFailureFallbackRateLimit?: { limit: number; windowMs: number };
  customerProviderBodyTimeoutMs?: number;
  cloudInferenceRateLimit?: { limit: number; windowMs: number };
  cloudInferenceAuthFailureRateLimit?: { limit: number; windowMs: number };
  cloudInferenceRequestBodyTimeoutMs?: number;
  cloudInferenceCountTimeoutMs?: number;
  cloudInferenceGenerationTimeoutMs?: number;
  customerMcpRateLimit?: { limit: number; windowMs: number };
  customerMcpAuthFailureRateLimit?: { limit: number; windowMs: number };
  customerMcpAuthFailureFallbackRateLimit?: { limit: number; windowMs: number };
  customerMcpRequestBodyTimeoutMs?: number;
  fetcher?: typeof fetch;
  gatewayConnectRateLimit?: { limit: number; windowMs: number };
  gatewayConnectFallbackRateLimit?: { limit: number; windowMs: number };
  gatewayDeviceRateLimits?: {
    connect?: { limit: number; windowMs: number };
    heartbeat?: { limit: number; windowMs: number };
    poll?: { limit: number; windowMs: number };
    result?: { limit: number; windowMs: number };
  };
  gatewayPairingExchangeRateLimit?: { limit: number; windowMs: number };
  gatewayPairingIssueRateLimit?: { limit: number; windowMs: number };
}

export function createCloudRuntime(options: CloudRuntimeOptions = {}) {
  const now = options.now ?? (() => new Date());

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === CLOUD_CUSTOMER_PORTAL_PATH) {
        const response = handleCloudCustomerPortalRequest(request);
        if (response) return response;
      }

      if (url.pathname === CLOUD_CUSTOMER_SETTINGS_PATH) {
        try {
          const response = await handleCloudCustomerSettingsRequest(request, {
            db: options.env?.DB,
            sessions: options.env?.GATEWAY_SESSIONS,
            now,
          });
          if (response) return response;
        } catch {
          return Response.json(
            { error: "Customer settings request could not be completed" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (url.pathname === CLOUD_CUSTOMER_BUSINESS_PROFILE_PATH) {
        try {
          const response = await handleCloudCustomerBusinessProfileRequest(request, {
            db: options.env?.DB,
            now,
          });
          if (response) return response;
        } catch {
          return Response.json(
            { error: "Customer business profile request could not be completed" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (
        url.pathname === CLOUD_CUSTOMER_PROVIDER_CONNECTIONS_PATH ||
        url.pathname.startsWith(`${CLOUD_CUSTOMER_PROVIDER_CONNECTIONS_PATH}/`)
      ) {
        try {
          const response = await handleCloudCustomerProviderRequest(request, {
            db: options.env?.DB,
            credentialEncryptionKey: options.env?.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY,
            now,
            bodyReadTimeoutMs: options.customerProviderBodyTimeoutMs,
          });
          if (response) return response;
        } catch {
          return Response.json(
            { error: "Customer provider connection request could not be completed" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (url.pathname === CLOUD_CUSTOMER_ONBOARDING_PATH) {
        try {
          const response = await handleCloudCustomerOnboardingRequest(request, {
            db: options.env?.DB,
            now,
          });
          if (response) return response;
        } catch {
          return Response.json(
            { error: "Customer onboarding status is unavailable" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (
        url.pathname === CLOUD_CUSTOMER_MCP_SERVERS_PATH ||
        url.pathname.startsWith(`${CLOUD_CUSTOMER_MCP_SERVERS_PATH}/`)
      ) {
        try {
          const response = await handleCloudTenantMcpRequest(request, {
            db: options.env?.DB,
            credentialEncryptionKey: options.env?.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY,
            egressBinding: options.env?.MCP_EGRESS,
            egressProxyToken: options.env?.OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN,
            egressEnabled: options.env?.OMNIROUTE_CLOUD_MCP_EGRESS_ENABLED === "true",
            now,
            tenantRateLimit: options.customerMcpRateLimit,
            failedKeyRateLimit: options.customerMcpAuthFailureRateLimit,
            failedKeyFallbackRateLimit: options.customerMcpAuthFailureFallbackRateLimit,
            bodyReadTimeoutMs: options.customerMcpRequestBodyTimeoutMs,
          });
          if (response) return response;
        } catch {
          return Response.json(
            { error: "Customer MCP configuration could not be completed" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (
        url.pathname === CLOUD_TENANT_OIDC_LOGIN_PATH ||
        url.pathname === CLOUD_TENANT_OIDC_CALLBACK_PATH ||
        url.pathname === CLOUD_TENANT_OIDC_SESSION_PATH ||
        url.pathname === CLOUD_TENANT_OIDC_LOGOUT_PATH ||
        url.pathname === CLOUD_TENANT_MEMBERS_PATH ||
        url.pathname.startsWith(`${CLOUD_TENANT_MEMBERS_PATH}/`) ||
        url.pathname === CLOUD_TENANT_API_KEYS_PATH ||
        url.pathname.startsWith(`${CLOUD_TENANT_API_KEYS_PATH}/`) ||
        url.pathname === CLOUD_TENANT_BUSINESS_PROFILE_PATH ||
        url.pathname === CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH ||
        url.pathname === CLOUD_TENANT_MEMBERSHIP_INVITATION_REDEEM_PATH ||
        url.pathname === CLOUD_TENANT_OIDC_OWNER_CLAIM_REDEEM_PATH
      ) {
        try {
          const response = await handleCloudTenantOidcAuthRequest(request, {
            db: options.env?.DB,
            publicOrigin: options.env?.OMNIROUTE_CLOUD_PUBLIC_ORIGIN,
            environment: options.env?.OMNIROUTE_ENV,
            credentialEncryptionKey: options.env?.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY,
            now: () => now().getTime(),
            fetcher: options.fetcher,
          });
          if (response) return response;
          return new Response("Not Found", { status: 404 });
        } catch {
          return Response.json(
            { error: "Customer identity request could not be completed" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (request.method === "GET" && url.pathname === "/__cloud/health") {
        return Response.json(
          {
            status: "ok",
            runtime: "cloudflare",
            timestamp: now().toISOString(),
          },
          {
            headers: { "Cache-Control": "no-store" },
          }
        );
      }

      if (request.method === "GET" && url.pathname === "/__cloud/readiness") {
        const checks: {
          database: "ok" | "unconfigured" | "error";
          gateway: "ok" | "unconfigured" | "error";
        } = {
          database: "unconfigured",
          gateway: "unconfigured",
        };

        if (options.env?.DB) {
          try {
            await options.env.DB.prepare("SELECT 1 AS ok").first();
            checks.database = "ok";
          } catch {
            checks.database = "error";
          }
        }

        if (options.env?.GATEWAY_SESSIONS) {
          try {
            const probe = options.env.GATEWAY_SESSIONS.idFromName("__healthcheck__");
            await options.env.GATEWAY_SESSIONS.get(probe).checkReadiness();
            checks.gateway = "ok";
          } catch {
            checks.gateway = "error";
          }
        }

        const ready = checks.database === "ok" && checks.gateway === "ok";
        return Response.json(
          {
            status: ready ? "ready" : "not_ready",
            runtime: "cloudflare",
            checks,
          },
          {
            status: ready ? 200 : 503,
            headers: { "Cache-Control": "no-store" },
          }
        );
      }

      if (request.method === "GET" && url.pathname === "/__cloud/db") {
        if (!options.env?.DB) {
          return Response.json(
            { status: "unconfigured", runtime: "cloudflare", database: "d1" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }

        try {
          await options.env.DB.prepare("SELECT 1 AS ok").first();
          return Response.json(
            { status: "ok", runtime: "cloudflare", database: "d1" },
            { headers: { "Cache-Control": "no-store" } }
          );
        } catch {
          return Response.json(
            { status: "error", runtime: "cloudflare", database: "d1" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (request.method === "GET" && url.pathname === "/__cloud/runtime") {
        return Response.json(
          {
            runtime: "cloudflare",
            environment: options.env?.OMNIROUTE_ENV ?? "unknown",
            buildSha: options.env?.OMNIROUTE_BUILD_SHA ?? null,
          },
          {
            headers: { "Cache-Control": "no-store" },
          }
        );
      }

      if (url.pathname === "/v1/chat/completions") {
        try {
          return await handleCloudInferenceCustomerRequest(request, {
            db: options.env?.DB,
            credentialEncryptionKey: options.env?.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY,
            requestHashSecret: options.env?.OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY,
            now: () => now().getTime(),
            fetcher: options.fetcher,
            rateLimit: options.cloudInferenceRateLimit,
            failedKeyRateLimit: options.cloudInferenceAuthFailureRateLimit,
            requestBodyTimeoutMs: options.cloudInferenceRequestBodyTimeoutMs,
            countTimeoutMs: options.cloudInferenceCountTimeoutMs,
            generationTimeoutMs: options.cloudInferenceGenerationTimeoutMs,
          });
        } catch {
          return Response.json(
            { error: { message: "Cloud inference is unavailable", type: "cloud_inference_error" } },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (url.pathname.startsWith("/__gateway/v1/device/")) {
        try {
          return await handleGatewayDeviceRequest(request, {
            db: options.env?.DB,
            sessions: options.env?.GATEWAY_SESSIONS,
            now: () => now().getTime(),
            connectRateLimit: options.gatewayConnectRateLimit,
            connectFallbackRateLimit: options.gatewayConnectFallbackRateLimit,
            rateLimits: options.gatewayDeviceRateLimits,
            pairingExchangeRateLimit: options.gatewayPairingExchangeRateLimit,
          });
        } catch {
          return Response.json(
            { error: "Gateway request could not be completed" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (url.pathname.startsWith("/__gateway/v1/customer/")) {
        try {
          return await handleGatewayCustomerRequest(request, {
            db: options.env?.DB,
            sessions: options.env?.GATEWAY_SESSIONS,
            now: () => now().getTime(),
            rateLimit: options.customerInvokeRateLimit,
            failedKeyRateLimit: options.customerAuthFailureRateLimit,
            failedKeyFallbackRateLimit: options.customerAuthFailureFallbackRateLimit,
            pairingIssueRateLimit: options.gatewayPairingIssueRateLimit,
          });
        } catch {
          return Response.json(
            { error: "Gateway invocation could not be completed" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (
        url.pathname === CLOUD_TENANT_ADMIN_API_PATH ||
        url.pathname.startsWith(`${CLOUD_TENANT_ADMIN_API_PATH}/`)
      ) {
        return handleCloudApiRequest(request, {
          db: options.env?.DB,
          adminToken: options.env?.OMNIROUTE_CLOUD_ADMIN_TOKEN,
          maintenanceToken: options.env?.OMNIROUTE_CLOUD_MAINTENANCE_TOKEN,
          environment: options.env?.OMNIROUTE_ENV,
          credentialEncryptionKey: options.env?.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY,
          sessions: options.env?.GATEWAY_SESSIONS,
          now,
          adminRateLimit: options.adminRateLimit,
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}
