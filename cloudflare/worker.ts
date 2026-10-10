import { DurableObject } from "cloudflare:workers";
import {
  GatewaySessionDurableObject,
  type GatewayCoordinatorStub,
} from "../src/cloud/connectorGatewayDurableObject";
import { cleanupExpiredCloudRateLimits } from "../src/cloud/rateLimit";
import { cleanupExpiredCloudGatewayPairings } from "../src/cloud/gatewayPairing";
import { cleanupExpiredCloudTenantOidcAuthArtifacts } from "../src/cloud/tenantOidcAuth";
import { cleanupExpiredCloudImageJobs } from "../src/cloud/imageJobs";
import { cleanupExpiredCloudCustomerHostVerificationChallenges } from "../src/cloud/customerHostVerificationChallenges";
import { rewrapCloudCredentialRows } from "../src/cloud/credentialRewrapMaintenance";
import {
  isCloudCredentialEncryptionKey,
  type CloudCredentialKeyring,
} from "../src/cloud/credentialEncryption";
import type { GatewayImageArtifactBucket } from "../src/cloud/imageJobs";
import {
  cleanupSettledCloudInferenceReservations,
  cleanupStaleCloudInferenceReservations,
} from "../src/cloud/inferencePolicy";
import { cleanupExpiredCloudInferenceResponses } from "../src/cloud/inferenceIdempotency";
import { runCloudMaintenanceTasks, type CloudMaintenanceTask } from "../src/cloud/maintenance";
import { createCloudRuntime } from "../src/cloud/runtime";

type CloudflareEnv = Env & {
  OMNIROUTE_ENV?: string;
  OMNIROUTE_BUILD_SHA?: string;
  OMNIROUTE_CLOUD_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_PROVISIONING_TOKEN?: string;
  OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_MAINTENANCE_TOKEN?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID?: string;
  OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY?: string;
  OMNIROUTE_FRONT_DESK_CONFIG_TOKEN?: string;
  OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN?: string;
  OMNIROUTE_CLOUD_MCP_EGRESS_ENABLED?: string;
  OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN?: string;
  OMNIROUTE_CLOUD_OIDC_EGRESS_ENABLED?: string;
  OMNIROUTE_CLOUD_PUBLIC_ORIGIN?: string;
  MCP_EGRESS?: { fetch(request: Request): Promise<Response> };
  OIDC_EGRESS?: { fetch(request: Request): Promise<Response> };
  GATEWAY_ARTIFACTS: GatewayImageArtifactBucket;
};

export class GatewaySessionObject extends DurableObject<CloudflareEnv> {
  private readonly coordinator: GatewaySessionDurableObject;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.coordinator = new GatewaySessionDurableObject({
      id: { name: ctx.id.name ?? undefined },
      storage: ctx.storage,
    });
  }

  checkReadiness() {
    return this.coordinator.checkReadiness();
  }

  putSession(...args: Parameters<GatewayCoordinatorStub["putSession"]>) {
    return this.coordinator.putSession(...args);
  }

  getSession(...args: Parameters<GatewayCoordinatorStub["getSession"]>) {
    return this.coordinator.getSession(...args);
  }

  touchSession(...args: Parameters<GatewayCoordinatorStub["touchSession"]>) {
    return this.coordinator.touchSession(...args);
  }

  revokeSession(...args: Parameters<GatewayCoordinatorStub["revokeSession"]>) {
    return this.coordinator.revokeSession(...args);
  }

  enqueueRequest(...args: Parameters<GatewayCoordinatorStub["enqueueRequest"]>) {
    return this.coordinator.enqueueRequest(...args);
  }

  takeRequests(...args: Parameters<GatewayCoordinatorStub["takeRequests"]>) {
    return this.coordinator.takeRequests(...args);
  }

  submitRequestResult(...args: Parameters<GatewayCoordinatorStub["submitRequestResult"]>) {
    return this.coordinator.submitRequestResult(...args);
  }

  getRequest(...args: Parameters<GatewayCoordinatorStub["getRequest"]>) {
    return this.coordinator.getRequest(...args);
  }

  deleteRequest(...args: Parameters<GatewayCoordinatorStub["deleteRequest"]>) {
    return this.coordinator.deleteRequest(...args);
  }

  submitStreamEvent(...args: Parameters<GatewayCoordinatorStub["submitStreamEvent"]>) {
    return this.coordinator.submitStreamEvent(...args);
  }

  peekStreamEvent(...args: Parameters<GatewayCoordinatorStub["peekStreamEvent"]>) {
    return this.coordinator.peekStreamEvent(...args);
  }

  acknowledgeStreamEvent(...args: Parameters<GatewayCoordinatorStub["acknowledgeStreamEvent"]>) {
    return this.coordinator.acknowledgeStreamEvent(...args);
  }

  cancelStream(...args: Parameters<GatewayCoordinatorStub["cancelStream"]>) {
    return this.coordinator.cancelStream(...args);
  }
}

const worker = {
  fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    return createCloudRuntime({
      env: {
        OMNIROUTE_ENV: env.OMNIROUTE_ENV,
        OMNIROUTE_BUILD_SHA: env.OMNIROUTE_BUILD_SHA,
        OMNIROUTE_CLOUD_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_PROVISIONING_TOKEN: env.OMNIROUTE_CLOUD_PROVISIONING_TOKEN,
        OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: env.OMNIROUTE_CLOUD_MAINTENANCE_TOKEN,
        OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: env.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY,
        OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON:
          env.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON,
        OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID:
          env.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID,
        OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: env.OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY,
        OMNIROUTE_FRONT_DESK_CONFIG_TOKEN: env.OMNIROUTE_FRONT_DESK_CONFIG_TOKEN,
        OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN: env.OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN,
        OMNIROUTE_CLOUD_MCP_EGRESS_ENABLED: env.OMNIROUTE_CLOUD_MCP_EGRESS_ENABLED,
        OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN: env.OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN,
        OMNIROUTE_CLOUD_OIDC_EGRESS_ENABLED: env.OMNIROUTE_CLOUD_OIDC_EGRESS_ENABLED,
        OMNIROUTE_CLOUD_PUBLIC_ORIGIN: env.OMNIROUTE_CLOUD_PUBLIC_ORIGIN,
        DB: env.DB,
        GATEWAY_SESSIONS: env.GATEWAY_SESSIONS,
        GATEWAY_ARTIFACTS: env.GATEWAY_ARTIFACTS,
        MCP_EGRESS: env.MCP_EGRESS,
        OIDC_EGRESS: env.OIDC_EGRESS,
      },
    }).fetch(request);
  },
  scheduled(_controller: ScheduledController, env: CloudflareEnv, context: ExecutionContext): void {
    const tasks: CloudMaintenanceTask[] = [
      { name: "expired-rate-limits" as const, run: () => cleanupExpiredCloudRateLimits(env.DB) },
      {
        name: "expired-gateway-pairings" as const,
        run: () => cleanupExpiredCloudGatewayPairings(env.DB),
      },
      {
        name: "stale-inference-reservations" as const,
        run: () => cleanupStaleCloudInferenceReservations(env.DB),
      },
      {
        name: "settled-inference-reservations" as const,
        run: () => cleanupSettledCloudInferenceReservations(env.DB),
      },
      {
        name: "expired-inference-responses" as const,
        run: () => cleanupExpiredCloudInferenceResponses(env.DB),
      },
      {
        name: "expired-oidc-artifacts" as const,
        run: () => cleanupExpiredCloudTenantOidcAuthArtifacts(env.DB),
      },
      {
        name: "expired-gateway-image-jobs" as const,
        run: () => cleanupExpiredCloudImageJobs(env.DB, env.GATEWAY_ARTIFACTS),
      },
      {
        name: "expired-customer-host-challenges" as const,
        run: () => cleanupExpiredCloudCustomerHostVerificationChallenges(env.DB),
      },
    ];
    const credentialKeyring = scheduledCredentialKeyring(env);
    if (credentialKeyring) {
      tasks.push({
        name: "rewrap-cloud-credentials",
        run: () => rewrapCloudCredentialRows(env.DB, credentialKeyring),
      });
    }
    context.waitUntil(runCloudMaintenanceTasks(tasks, undefined, { db: env.DB }));
  },
};

function scheduledCredentialKeyring(env: CloudflareEnv): CloudCredentialKeyring | undefined {
  const legacyKey = env.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY;
  const activeKeyId = env.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID;
  const keysJson = env.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON;
  if (!legacyKey || !activeKeyId || !keysJson) return undefined;

  try {
    const parsed: unknown = JSON.parse(keysJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const keyring: CloudCredentialKeyring = {
      legacyKey,
      keys: parsed as Record<string, string>,
      activeKeyId,
    };
    return isCloudCredentialEncryptionKey(keyring) ? keyring : undefined;
  } catch {
    return undefined;
  }
}

export default worker;
