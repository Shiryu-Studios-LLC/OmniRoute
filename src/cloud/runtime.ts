import type { CloudDb } from "./db";
import { handleCloudApiRequest, isDeploymentToken } from "./httpApi";
import {
  isCloudCredentialEncryptionKey,
  isCloudCredentialKeyId,
  type CloudCredentialEncryptionKey,
  type CloudCredentialKeyring,
} from "./credentialEncryption";
import { isCloudInferenceIdempotencySecret } from "./inferenceIdempotency";
import { handleGatewayDeviceRequest } from "./gatewayHttpApi";
import { handleGatewayCustomerRequest } from "./gatewayCustomerHttpApi";
import { handleGatewayImageJobRequest } from "./gatewayImageJobHttpApi";
import type { GatewayImageArtifactBucket } from "./imageJobs";
import {
  CLOUD_INFERENCE_CHAT_API_PATH,
  CLOUD_INFERENCE_CHAT_PATH,
  handleCloudInferenceCustomerRequest,
} from "./inferenceCustomerHttpApi";
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
import { createCloudOidcEgressTransport, type CloudOidcEgressBinding } from "./oidcEgressTransport";
import { CLOUD_CUSTOMER_PORTAL_PATH, handleCloudCustomerPortalRequest } from "./customerPortal";
import { CLOUD_TENANT_HOSTS_PATH, handleCloudTenantHostsRequest } from "./tenantHostsHttpApi";
import type { CustomerHostTxtResolver } from "./tenantHostDns";
import {
  CLOUD_FRONT_DESK_CONFIG_PATH,
  CLOUD_FRONT_DESK_CONFIGS_PATH,
  handleCloudFrontDeskConfigRequest,
} from "./frontDeskConfigHttpApi";
import {
  CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH,
  CLOUD_TENANT_MEMBERSHIP_INVITATION_REDEEM_PATH,
  CLOUD_TENANT_MEMBERS_PATH,
  CLOUD_TENANT_API_KEYS_PATH,
  CLOUD_TENANT_MCP_SERVERS_PATH,
  CLOUD_TENANT_ONBOARDING_PATH,
  CLOUD_TENANT_MCP_SETTINGS_PATH,
  CLOUD_TENANT_LOCAL_AI_SETTINGS_PATH,
  CLOUD_TENANT_BUSINESS_PROFILE_PATH,
  CLOUD_TENANT_PROVIDER_CONNECTIONS_PATH,
  CLOUD_TENANT_OIDC_OWNER_CLAIM_REDEEM_PATH,
  CLOUD_TENANT_OIDC_LOGOUT_PATH,
  CLOUD_TENANT_OIDC_DRAFT_PATH,
  CLOUD_TENANT_OIDC_DRAFT_PROMOTION_PATH,
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

interface CredentialEncryptionSettings {
  key?: CloudCredentialEncryptionKey;
  issue?: "invalid:credentialEncryptionKey" | "invalid:credentialKeyring";
  secretValues: string[];
}

function resolveCredentialEncryptionSettings(
  env: CloudRuntimeEnv | undefined
): CredentialEncryptionSettings {
  const legacyKey = env?.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY;
  const keysJson = env?.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON;
  const activeKeyId = env?.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID;
  const hasKeyringConfig = keysJson !== undefined || activeKeyId !== undefined;
  if (!legacyKey) {
    return {
      issue: hasKeyringConfig ? "invalid:credentialKeyring" : undefined,
      secretValues: [],
    };
  }
  if (!isCloudCredentialEncryptionKey(legacyKey)) {
    return { issue: "invalid:credentialEncryptionKey", secretValues: [legacyKey] };
  }
  if (!hasKeyringConfig) return { key: legacyKey, secretValues: [legacyKey] };

  let keys: Record<string, string> = Object.create(null) as Record<string, string>;
  if (keysJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(keysJson);
    } catch {
      return { issue: "invalid:credentialKeyring", secretValues: [legacyKey] };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { issue: "invalid:credentialKeyring", secretValues: [legacyKey] };
    }
    for (const [keyId, secret] of Object.entries(parsed)) {
      if (!isCloudCredentialKeyId(keyId) || typeof secret !== "string") {
        return { issue: "invalid:credentialKeyring", secretValues: [legacyKey] };
      }
      if (!isCloudCredentialEncryptionKey(secret)) {
        return { issue: "invalid:credentialKeyring", secretValues: [legacyKey] };
      }
      keys[keyId] = secret;
    }
  }

  if (
    activeKeyId !== undefined &&
    (!isCloudCredentialKeyId(activeKeyId) || !Object.hasOwn(keys, activeKeyId))
  ) {
    return {
      issue: "invalid:credentialKeyring",
      secretValues: [legacyKey, ...Object.values(keys)],
    };
  }

  const keyring: CloudCredentialKeyring = {
    legacyKey,
    keys,
    ...(activeKeyId !== undefined ? { activeKeyId } : {}),
  };
  return { key: keyring, secretValues: [legacyKey, ...Object.values(keys)] };
}

export interface CloudRuntimeEnv {
  OMNIROUTE_ENV?: string;
  OMNIROUTE_BUILD_SHA?: string;
  DB?: CloudDb;
  /** Legacy unscoped operator token; honored only outside staging and production. */
  OMNIROUTE_CLOUD_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_PROVISIONING_TOKEN?: string;
  OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_MAINTENANCE_TOKEN?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID?: string;
  OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY?: string;
  OMNIROUTE_FRONT_DESK_CONFIG_TOKEN?: string;
  OMNIROUTE_CLOUD_PUBLIC_ORIGIN?: string;
  GATEWAY_SESSIONS?: GatewayDurableObjectNamespace<GatewayCoordinatorStub>;
  GATEWAY_ARTIFACTS?: GatewayImageArtifactBucket;
  MCP_EGRESS?: CloudMcpEgressBinding;
  OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN?: string;
  OMNIROUTE_CLOUD_MCP_EGRESS_ENABLED?: string;
  OIDC_EGRESS?: CloudOidcEgressBinding;
  OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN?: string;
  OMNIROUTE_CLOUD_OIDC_EGRESS_ENABLED?: string;
}

export interface CloudRuntimeOptions {
  env?: CloudRuntimeEnv;
  now?: () => Date;
  customerHostTxtResolver?: CustomerHostTxtResolver;
  adminRateLimit?: { limit: number; windowMs: number };
  customerInvokeRateLimit?: { limit: number; windowMs: number };
  customerImageJobRateLimit?: { limit: number; windowMs: number };
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
  gatewayRequestBodyTimeoutMs?: number;
}

export function createCloudRuntime(options: CloudRuntimeOptions = {}) {
  const now = options.now ?? (() => new Date());
  const env = options.env;
  const requireDeploymentConfiguration =
    env?.OMNIROUTE_ENV === "staging" || env?.OMNIROUTE_ENV === "production";
  const oidcEgressEnabled = env?.OMNIROUTE_CLOUD_OIDC_EGRESS_ENABLED === "true";
  const oidcEgressToken = env?.OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN;
  const oidcEgressState: "ok" | "disabled" | "error" = !oidcEgressEnabled
    ? "disabled"
    : env?.OIDC_EGRESS && oidcEgressToken && /^[A-Za-z0-9_-]{32,512}$/.test(oidcEgressToken)
      ? "ok"
      : "error";
  const mcpEgressEnabled = env?.OMNIROUTE_CLOUD_MCP_EGRESS_ENABLED === "true";
  const mcpEgressToken = env?.OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN;
  const mcpEgressState: "ok" | "disabled" | "error" = !mcpEgressEnabled
    ? "disabled"
    : env?.MCP_EGRESS && mcpEgressToken && /^[A-Za-z0-9_-]{32,512}$/.test(mcpEgressToken)
      ? "ok"
      : "error";
  const credentialEncryption = resolveCredentialEncryptionSettings(env);
  const credentialEncryptionKey = credentialEncryption.key;

  const configurationStatus = (): {
    status: "ok" | "unconfigured" | "error";
    issues: string[];
  } => {
    const scopedTokens = [
      ["identityAdminToken", env?.OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN],
      ["inferenceAdminToken", env?.OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN],
      ["lifecycleAdminToken", env?.OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN],
      ["provisioningToken", env?.OMNIROUTE_CLOUD_PROVISIONING_TOKEN],
      ["tenantHostsAdminToken", env?.OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN],
      ["frontDeskAdminToken", env?.OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN],
      ["maintenanceToken", env?.OMNIROUTE_CLOUD_MAINTENANCE_TOKEN],
    ] as const;
    const idempotencyKey = env?.OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY;
    const frontDeskConfigToken = env?.OMNIROUTE_FRONT_DESK_CONFIG_TOKEN;
    const issues: string[] = [];
    for (const [name, token] of scopedTokens) {
      if (!token) issues.push(`missing:${name}`);
      else if (!isDeploymentToken(token)) issues.push(`invalid:${name}`);
    }
    if (!env?.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY) {
      issues.push("missing:credentialEncryptionKey");
    }
    if (credentialEncryption.issue) issues.push(credentialEncryption.issue);
    if (!idempotencyKey) issues.push("missing:idempotencyKey");
    else if (!isCloudInferenceIdempotencySecret(idempotencyKey)) {
      issues.push("invalid:idempotencyKey");
    }
    if (frontDeskConfigToken !== undefined && !isDeploymentToken(frontDeskConfigToken)) {
      issues.push("invalid:frontDeskServiceToken");
    }
    if (oidcEgressEnabled) {
      if (!env?.OIDC_EGRESS) issues.push("missing:oidcEgressBinding");
      if (!oidcEgressToken) issues.push("missing:oidcEgressToken");
      else if (!/^[A-Za-z0-9_-]{32,512}$/.test(oidcEgressToken)) {
        issues.push("invalid:oidcEgressToken");
      }
    }
    if (mcpEgressEnabled) {
      if (!env?.MCP_EGRESS) issues.push("missing:mcpEgressBinding");
      if (!mcpEgressToken) issues.push("missing:mcpEgressToken");
      else if (!/^[A-Za-z0-9_-]{32,512}$/.test(mcpEgressToken)) {
        issues.push("invalid:mcpEgressToken");
      }
    }
    const configuredSecrets = [
      ...scopedTokens.map(([, token]) => token).filter((token): token is string => Boolean(token)),
      ...credentialEncryption.secretValues,
      idempotencyKey,
      ...(frontDeskConfigToken ? [frontDeskConfigToken] : []),
      ...(oidcEgressEnabled && oidcEgressToken ? [oidcEgressToken] : []),
      ...(mcpEgressEnabled && mcpEgressToken ? [mcpEgressToken] : []),
    ].filter((secret): secret is string => Boolean(secret));
    if (new Set(configuredSecrets).size !== configuredSecrets.length) {
      issues.push("duplicate:operatorOrRuntimeSecret");
    }
    return {
      status: issues.some((issue) => issue.startsWith("invalid:") || issue.startsWith("duplicate:"))
        ? "error"
        : issues.length > 0
          ? "unconfigured"
          : "ok",
      issues,
    };
  };
  const scopedOperatorToken = (token: string | undefined): string | undefined => {
    if (!requireDeploymentConfiguration) return token;
    return configurationStatus().status === "ok" ? token : undefined;
  };

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === CLOUD_CUSTOMER_PORTAL_PATH) {
        const response = handleCloudCustomerPortalRequest(request);
        if (response) return response;
      }

      if (
        url.pathname === CLOUD_FRONT_DESK_CONFIG_PATH ||
        url.pathname === CLOUD_FRONT_DESK_CONFIGS_PATH ||
        url.pathname.startsWith(`${CLOUD_FRONT_DESK_CONFIGS_PATH}/`)
      ) {
        try {
          const response = await handleCloudFrontDeskConfigRequest(request, {
            db: options.env?.DB,
            adminToken: requireDeploymentConfiguration
              ? scopedOperatorToken(options.env?.OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN)
              : (options.env?.OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN ??
                options.env?.OMNIROUTE_CLOUD_ADMIN_TOKEN),
            serviceToken: options.env?.OMNIROUTE_FRONT_DESK_CONFIG_TOKEN,
            credentialEncryptionKey,
            now,
          });
          if (response) return response;
        } catch {
          return Response.json(
            { error: "Front Desk config request could not be completed" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (
        url.pathname === CLOUD_TENANT_HOSTS_PATH ||
        url.pathname.startsWith(`${CLOUD_TENANT_HOSTS_PATH}/`)
      ) {
        try {
          const response = await handleCloudTenantHostsRequest(request, {
            db: options.env?.DB,
            adminToken: requireDeploymentConfiguration
              ? scopedOperatorToken(options.env?.OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN)
              : (options.env?.OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN ??
                options.env?.OMNIROUTE_CLOUD_ADMIN_TOKEN),
            now,
            resolveTxt: options.customerHostTxtResolver,
          });
          if (response) return response;
        } catch {
          return Response.json(
            { error: "Tenant host request could not be completed" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
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
            credentialEncryptionKey,
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
            credentialEncryptionKey,
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
        url.pathname === CLOUD_TENANT_OIDC_DRAFT_PATH ||
        url.pathname === CLOUD_TENANT_OIDC_DRAFT_PROMOTION_PATH ||
        url.pathname === CLOUD_TENANT_MEMBERS_PATH ||
        url.pathname.startsWith(`${CLOUD_TENANT_MEMBERS_PATH}/`) ||
        url.pathname === CLOUD_TENANT_API_KEYS_PATH ||
        url.pathname.startsWith(`${CLOUD_TENANT_API_KEYS_PATH}/`) ||
        url.pathname === CLOUD_TENANT_BUSINESS_PROFILE_PATH ||
        url.pathname === CLOUD_TENANT_PROVIDER_CONNECTIONS_PATH ||
        url.pathname.startsWith(`${CLOUD_TENANT_PROVIDER_CONNECTIONS_PATH}/`) ||
        url.pathname === CLOUD_TENANT_MCP_SERVERS_PATH ||
        url.pathname.startsWith(`${CLOUD_TENANT_MCP_SERVERS_PATH}/`) ||
        url.pathname === CLOUD_TENANT_ONBOARDING_PATH ||
        url.pathname === CLOUD_TENANT_MCP_SETTINGS_PATH ||
        url.pathname === CLOUD_TENANT_LOCAL_AI_SETTINGS_PATH ||
        url.pathname === "/__cloud/auth/front-desk" ||
        url.pathname.startsWith("/__cloud/auth/front-desk/") ||
        url.pathname === CLOUD_TENANT_MEMBERSHIP_INVITATIONS_PATH ||
        url.pathname === CLOUD_TENANT_MEMBERSHIP_INVITATION_REDEEM_PATH ||
        url.pathname === CLOUD_TENANT_OIDC_OWNER_CLAIM_REDEEM_PATH
      ) {
        try {
          const response = await handleCloudTenantOidcAuthRequest(request, {
            db: options.env?.DB,
            sessions: options.env?.GATEWAY_SESSIONS,
            publicOrigin: options.env?.OMNIROUTE_CLOUD_PUBLIC_ORIGIN,
            environment: options.env?.OMNIROUTE_ENV,
            credentialEncryptionKey,
            oidcTransport:
              options.env?.OMNIROUTE_CLOUD_OIDC_EGRESS_ENABLED === "true"
                ? (createCloudOidcEgressTransport({
                    binding: options.env?.OIDC_EGRESS,
                    proxyToken: options.env?.OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN,
                  }) ?? undefined)
                : undefined,
            requireControlledEgress: requireDeploymentConfiguration,
            now: () => now().getTime(),
            fetcher: options.fetcher,
            customerHostTxtResolver: options.customerHostTxtResolver,
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
        const configuration = requireDeploymentConfiguration ? configurationStatus() : null;
        const checks: {
          database: "ok" | "unconfigured" | "error";
          gateway: "ok" | "unconfigured" | "error";
          artifacts: "ok" | "unconfigured" | "error";
          oidcEgress: "ok" | "disabled" | "error";
          mcpEgress: "ok" | "disabled" | "error";
          configuration?: "ok" | "unconfigured" | "error";
          configurationIssues?: string[];
        } = {
          database: "unconfigured",
          gateway: "unconfigured",
          artifacts: "unconfigured",
          oidcEgress: oidcEgressState,
          mcpEgress: mcpEgressState,
          ...(configuration !== null
            ? {
                configuration: configuration.status,
                configurationIssues: configuration.issues,
              }
            : {}),
        };

        if (options.env?.DB) {
          try {
            const probe = await options.env.DB.prepare<{ ok: number }>("SELECT 1 AS ok").first();
            checks.database = probe?.ok === 1 ? "ok" : "error";
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

        if (options.env?.GATEWAY_ARTIFACTS) {
          try {
            const probe = await options.env.GATEWAY_ARTIFACTS.get(
              "__omniroute_healthcheck__/readiness"
            );
            await probe?.body?.cancel();
            checks.artifacts = "ok";
          } catch {
            checks.artifacts = "error";
          }
        }

        const ready =
          checks.database === "ok" &&
          checks.gateway === "ok" &&
          checks.artifacts === "ok" &&
          checks.oidcEgress !== "error" &&
          checks.mcpEgress !== "error" &&
          (configuration === null || configuration.status === "ok");
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
          const probe = await options.env.DB.prepare<{ ok: number }>("SELECT 1 AS ok").first();
          if (probe?.ok !== 1) throw new Error("D1 health probe returned no result");
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

      if (
        url.pathname === CLOUD_INFERENCE_CHAT_PATH ||
        url.pathname === CLOUD_INFERENCE_CHAT_API_PATH
      ) {
        try {
          return await handleCloudInferenceCustomerRequest(request, {
            db: options.env?.DB,
            credentialEncryptionKey,
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

      if (
        url.pathname === "/__gateway/v1/customer/image-jobs" ||
        url.pathname.startsWith("/__gateway/v1/customer/image-jobs/") ||
        url.pathname === "/__gateway/v1/device/image-jobs" ||
        url.pathname.startsWith("/__gateway/v1/device/image-jobs/")
      ) {
        try {
          const response = await handleGatewayImageJobRequest(request, {
            db: options.env?.DB,
            sessions: options.env?.GATEWAY_SESSIONS,
            artifacts: options.env?.GATEWAY_ARTIFACTS,
            now: () => now().getTime(),
            startRateLimit: options.customerImageJobRateLimit,
            bodyReadTimeoutMs: options.gatewayRequestBodyTimeoutMs,
          });
          if (response) return response;
        } catch {
          return Response.json(
            { error: "Image-job request could not be completed" },
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
            bodyReadTimeoutMs: options.gatewayRequestBodyTimeoutMs,
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
            bodyReadTimeoutMs: options.gatewayRequestBodyTimeoutMs,
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
          identityAdminToken: scopedOperatorToken(
            options.env?.OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN
          ),
          inferenceAdminToken: scopedOperatorToken(
            options.env?.OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN
          ),
          lifecycleAdminToken: scopedOperatorToken(
            options.env?.OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN
          ),
          provisioningToken: scopedOperatorToken(options.env?.OMNIROUTE_CLOUD_PROVISIONING_TOKEN),
          maintenanceToken: scopedOperatorToken(options.env?.OMNIROUTE_CLOUD_MAINTENANCE_TOKEN),
          environment: options.env?.OMNIROUTE_ENV,
          credentialEncryptionKey,
          sessions: options.env?.GATEWAY_SESSIONS,
          now,
          adminRateLimit: options.adminRateLimit,
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}
