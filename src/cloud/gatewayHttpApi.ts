import { createConnectorGateway, type GatewayCoordinator } from "./connectorGateway";
import type {
  GatewayCoordinatorStub,
  GatewayDurableObjectNamespace,
} from "./connectorGatewayDurableObject";
import { D1GatewayDeviceDirectory } from "./gatewayDevices";
import type { CloudDb } from "./db";

const PREFIX = "/__gateway/v1/device";
const VERSION = 1;
const MAX_REQUEST_BYTES = 80 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface GatewayDeviceHttpApiOptions {
  db?: CloudDb;
  sessions?: GatewayDurableObjectNamespace<GatewayCoordinatorStub>;
  now?: () => number;
  leaseMs?: number;
}

function json(body: unknown, status = 200): Response {
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return Response.json({ error: "Gateway response could not be serialized" }, { status: 500 });
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) {
    return Response.json({ error: "Gateway response exceeds the size limit" }, { status: 413 });
  }
  return new Response(serialized, {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  const advertisedLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_REQUEST_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = new TextDecoder().decode(bytes);
  try {
    return object(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

function exactKeys(body: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(body).every((key) => keys.includes(key)) && keys.every((key) => key in body);
}

export function coordinatorFromNamespace(
  namespace: GatewayDurableObjectNamespace<GatewayCoordinatorStub>
): GatewayCoordinator {
  function stub(deviceId: string): GatewayCoordinatorStub {
    return namespace.get(namespace.idFromName(deviceId));
  }
  return {
    putSession: (session: Parameters<GatewayCoordinatorStub["putSession"]>[1]) =>
      stub(session.deviceId).putSession(session.deviceId, session),
    getSession: (deviceId: string) => stub(deviceId).getSession(deviceId),
    touchSession: (...args: Parameters<GatewayCoordinatorStub["touchSession"]>) =>
      stub(args[0]).touchSession(...args),
    revokeSession: (...args: Parameters<GatewayCoordinatorStub["revokeSession"]>) =>
      stub(args[0]).revokeSession(...args),
    enqueueRequest: (...args: Parameters<GatewayCoordinatorStub["enqueueRequest"]>) =>
      stub(args[0]).enqueueRequest(...args),
    takeRequests: (...args: Parameters<GatewayCoordinatorStub["takeRequests"]>) =>
      stub(args[0]).takeRequests(...args),
    submitRequestResult: (...args: Parameters<GatewayCoordinatorStub["submitRequestResult"]>) =>
      stub(args[0]).submitRequestResult(...args),
    getRequest: (...args: Parameters<GatewayCoordinatorStub["getRequest"]>) =>
      stub(args[0]).getRequest(...args),
    deleteRequest: (...args: Parameters<GatewayCoordinatorStub["deleteRequest"]>) =>
      stub(args[0]).deleteRequest(...args),
  };
}

function sessionFrom(
  body: Record<string, unknown>,
  additionalKeys: string[] = []
): {
  deviceId: string;
  sessionToken: string;
} | null {
  if (
    body.version !== VERSION ||
    !Object.keys(body).every((key) =>
      ["version", "deviceId", "sessionToken", ...additionalKeys].includes(key)
    ) ||
    !["version", "deviceId", "sessionToken"].every((key) => key in body) ||
    typeof body.deviceId !== "string" ||
    !DEVICE_ID.test(body.deviceId) ||
    typeof body.sessionToken !== "string" ||
    !SESSION_TOKEN.test(body.sessionToken)
  ) {
    return null;
  }
  return { deviceId: body.deviceId, sessionToken: body.sessionToken };
}

/** Device-authenticated Worker API; tenant identity is derived only from D1. */
export async function handleGatewayDeviceRequest(
  request: Request,
  options: GatewayDeviceHttpApiOptions
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith(`${PREFIX}/`)) return json({ error: "Not found" }, 404);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!options.db || !options.sessions) return json({ error: "Gateway is not configured" }, 503);
  if (url.search || request.headers.has("authorization")) {
    return json({ error: "Unsupported gateway request metadata" }, 400);
  }
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid or oversized JSON body" }, 400);
  const gateway = createConnectorGateway({
    directory: new D1GatewayDeviceDirectory(options.db),
    coordinator: coordinatorFromNamespace(options.sessions),
    now: options.now,
    leaseMs: options.leaseMs,
  });

  if (path === `${PREFIX}/connect`) {
    if (
      body.version !== VERSION ||
      !exactKeys(body, ["version", "deviceId", "credential"]) ||
      typeof body.deviceId !== "string" ||
      !DEVICE_ID.test(body.deviceId) ||
      typeof body.credential !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(body.credential)
    ) {
      return json({ error: "Invalid connect request" }, 400);
    }
    const session = await gateway.connect(body.deviceId, body.credential);
    return session
      ? json({ version: VERSION, session })
      : json({ error: "Device authentication failed" }, 401);
  }

  const additionalKeys =
    path === `${PREFIX}/heartbeat`
      ? ["capabilities", "serviceHealth"]
      : path === `${PREFIX}/result`
        ? ["requestId", "result"]
        : [];
  const session = sessionFrom(body, additionalKeys);
  if (!session) return json({ error: "Invalid device session request" }, 400);

  if (path === `${PREFIX}/heartbeat`) {
    if (
      !["version", "deviceId", "sessionToken", "capabilities"].every((key) => key in body) ||
      Object.keys(body).some(
        (key) =>
          !["version", "deviceId", "sessionToken", "capabilities", "serviceHealth"].includes(key)
      ) ||
      !Array.isArray(body.capabilities) ||
      body.capabilities.length > 64 ||
      body.capabilities.some(
        (capability) =>
          typeof capability !== "string" ||
          capability.trim() !== capability ||
          capability.length < 1 ||
          capability.length > 128 ||
          /[\u0000-\u001f\u007f]/.test(capability)
      )
    ) {
      return json({ error: "Invalid heartbeat request" }, 400);
    }
    const health = body.serviceHealth;
    if (
      health !== undefined &&
      (health === null ||
        typeof health !== "object" ||
        Array.isArray(health) ||
        Object.keys(health).length !== 2 ||
        Object.keys(health).some((key) => key !== "ollama" && key !== "comfyui") ||
        typeof (health as Record<string, unknown>).ollama !== "boolean" ||
        typeof (health as Record<string, unknown>).comfyui !== "boolean")
    )
      return json({ error: "Invalid heartbeat request" }, 400);
    const accepted = await gateway.heartbeat(
      session.deviceId,
      session.sessionToken,
      body.capabilities as string[],
      health as { ollama: boolean; comfyui: boolean } | undefined
    );
    return accepted
      ? json({ version: VERSION, accepted: true })
      : json({ error: "Device session is unavailable" }, 401);
  }

  if (path === `${PREFIX}/poll`) {
    if (!exactKeys(body, ["version", "deviceId", "sessionToken"])) {
      return json({ error: "Invalid poll request" }, 400);
    }
    const requests = await gateway.pollDeviceRequests({
      ...session,
      limit: 1,
    });
    return requests
      ? json({ version: VERSION, requests })
      : json({ error: "Device session is unavailable" }, 401);
  }

  if (path === `${PREFIX}/result`) {
    if (
      !exactKeys(body, ["version", "deviceId", "sessionToken", "requestId", "result"]) ||
      typeof body.requestId !== "string" ||
      !REQUEST_ID.test(body.requestId)
    ) {
      return json({ error: "Invalid result request" }, 400);
    }
    let resultBytes: number;
    try {
      resultBytes = new TextEncoder().encode(JSON.stringify(body.result)).byteLength;
    } catch {
      return json({ error: "Invalid result payload" }, 400);
    }
    if (resultBytes > 64 * 1024) return json({ error: "Result exceeds the size limit" }, 413);
    const accepted = await gateway.submitDeviceResult({
      ...session,
      requestId: body.requestId,
      result: body.result,
    });
    return accepted
      ? json({ version: VERSION, accepted: true })
      : json({ error: "Device result was rejected" }, 409);
  }

  return json({ error: "Not found" }, 404);
}
