import type { CloudDb } from "./db";
import { handleCloudApiRequest } from "./httpApi";
import { handleGatewayDeviceRequest } from "./gatewayHttpApi";
import { handleGatewayCustomerRequest } from "./gatewayCustomerHttpApi";
import type {
  GatewayCoordinatorStub,
  GatewayDurableObjectNamespace,
} from "./connectorGatewayDurableObject";

export interface CloudRuntimeEnv {
  OMNIROUTE_ENV?: string;
  OMNIROUTE_BUILD_SHA?: string;
  DB?: CloudDb;
  OMNIROUTE_CLOUD_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY?: string;
  GATEWAY_SESSIONS?: GatewayDurableObjectNamespace<GatewayCoordinatorStub>;
}

export interface CloudRuntimeOptions {
  env?: CloudRuntimeEnv;
  now?: () => Date;
  adminRateLimit?: { limit: number; windowMs: number };
  customerInvokeRateLimit?: { limit: number; windowMs: number };
  customerAuthFailureRateLimit?: { limit: number; windowMs: number };
  customerAuthFailureFallbackRateLimit?: { limit: number; windowMs: number };
  gatewayConnectRateLimit?: { limit: number; windowMs: number };
  gatewayConnectFallbackRateLimit?: { limit: number; windowMs: number };
  gatewayDeviceRateLimits?: {
    connect?: { limit: number; windowMs: number };
    heartbeat?: { limit: number; windowMs: number };
    poll?: { limit: number; windowMs: number };
    result?: { limit: number; windowMs: number };
  };
}

export function createCloudRuntime(options: CloudRuntimeOptions = {}) {
  const now = options.now ?? (() => new Date());

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

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

      if (url.pathname.startsWith("/__gateway/v1/device/")) {
        try {
          return await handleGatewayDeviceRequest(request, {
            db: options.env?.DB,
            sessions: options.env?.GATEWAY_SESSIONS,
            now: () => now().getTime(),
            connectRateLimit: options.gatewayConnectRateLimit,
            connectFallbackRateLimit: options.gatewayConnectFallbackRateLimit,
            rateLimits: options.gatewayDeviceRateLimits,
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
          });
        } catch {
          return Response.json(
            { error: "Gateway invocation could not be completed" },
            { status: 503, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      if (url.pathname.startsWith("/__cloud/v1/")) {
        return handleCloudApiRequest(request, {
          db: options.env?.DB,
          adminToken: options.env?.OMNIROUTE_CLOUD_ADMIN_TOKEN,
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
