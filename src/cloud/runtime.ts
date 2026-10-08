export interface CloudRuntimeEnv {
  OMNIROUTE_ENV?: string;
  OMNIROUTE_BUILD_SHA?: string;
}

export interface CloudRuntimeOptions {
  env?: CloudRuntimeEnv;
  now?: () => Date;
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

      return new Response("Not Found", { status: 404 });
    },
  };
}
