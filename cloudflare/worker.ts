import { DurableObject } from "cloudflare:workers";
import {
  GatewaySessionDurableObject,
  type GatewayCoordinatorStub,
} from "../src/cloud/connectorGatewayDurableObject";
import { cleanupExpiredCloudRateLimits } from "../src/cloud/rateLimit";
import { cleanupExpiredCloudGatewayPairings } from "../src/cloud/gatewayPairing";
import { cleanupExpiredCloudTenantOidcAuthArtifacts } from "../src/cloud/tenantOidcAuth";
import {
  cleanupSettledCloudInferenceReservations,
  cleanupStaleCloudInferenceReservations,
} from "../src/cloud/inferencePolicy";
import { cleanupExpiredCloudInferenceResponses } from "../src/cloud/inferenceIdempotency";
import { createCloudRuntime } from "../src/cloud/runtime";

type CloudflareEnv = Env & {
  OMNIROUTE_ENV?: string;
  OMNIROUTE_BUILD_SHA?: string;
  OMNIROUTE_CLOUD_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_MAINTENANCE_TOKEN?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY?: string;
  OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY?: string;
  OMNIROUTE_CLOUD_PUBLIC_ORIGIN?: string;
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
        OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: env.OMNIROUTE_CLOUD_MAINTENANCE_TOKEN,
        OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: env.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY,
        OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: env.OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY,
        OMNIROUTE_CLOUD_PUBLIC_ORIGIN: env.OMNIROUTE_CLOUD_PUBLIC_ORIGIN,
        DB: env.DB,
        GATEWAY_SESSIONS: env.GATEWAY_SESSIONS,
      },
    }).fetch(request);
  },
  scheduled(_controller: ScheduledController, env: CloudflareEnv, context: ExecutionContext): void {
    context.waitUntil(
      Promise.all([
        cleanupExpiredCloudRateLimits(env.DB),
        cleanupExpiredCloudGatewayPairings(env.DB),
        cleanupStaleCloudInferenceReservations(env.DB),
        cleanupSettledCloudInferenceReservations(env.DB),
        cleanupExpiredCloudInferenceResponses(env.DB),
        cleanupExpiredCloudTenantOidcAuthArtifacts(env.DB),
      ]).then(() => undefined)
    );
  },
};

export default worker;
