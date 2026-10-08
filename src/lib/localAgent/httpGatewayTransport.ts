import {
  LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
  type LocalAgentGatewayRequest,
  type LocalAgentGatewayResult,
  type LocalAgentGatewaySession,
  type LocalAgentGatewayTransport,
} from "./gatewayProtocol";

const BASE_PATH = "/__gateway/v1/device";
const MAX_REQUEST_BYTES = 80 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export interface HttpGatewayTransportOptions {
  fetch: typeof fetch;
  requestTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function gatewayBaseUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid Local Agent gateway URL");
  }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Local Agent gateway must use HTTPS without credentials or query data");
  }
  return url;
}

function validSession(value: unknown): LocalAgentGatewaySession | null {
  const session = isRecord(value) ? value : null;
  if (
    !session ||
    typeof session.sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(session.sessionId) ||
    typeof session.deviceId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(session.deviceId) ||
    typeof session.tenantId !== "string" ||
    session.tenantId.length < 1 ||
    session.tenantId.length > 128 ||
    typeof session.sessionToken !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(session.sessionToken) ||
    typeof session.leaseExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(session.leaseExpiresAt))
  ) {
    return null;
  }
  return {
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    tenantId: session.tenantId,
    sessionToken: session.sessionToken,
    leaseExpiresAt: session.leaseExpiresAt,
  };
}

export function createHttpLocalAgentGatewayTransport(
  rawUrl: string,
  options: HttpGatewayTransportOptions
): LocalAgentGatewayTransport {
  const base = gatewayBaseUrl(rawUrl);
  const timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new Error("Invalid Local Agent gateway request timeout");
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
      throw new Error("Local Agent gateway request exceeds the size limit");
    }
    const url = new URL(`${BASE_PATH}/${path}`, base.origin);
    const response = await options.fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: serialized,
    });
    const advertisedLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertisedLength) && advertisedLength > MAX_RESPONSE_BYTES) {
      throw new Error("Local Agent gateway response exceeds the size limit");
    }
    const responseText = await response.text();
    if (new TextEncoder().encode(responseText).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("Local Agent gateway response exceeds the size limit");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText) as unknown;
    } catch {
      throw new Error("Local Agent gateway returned invalid JSON");
    }
    if (!response.ok && response.status !== 401 && response.status !== 409) {
      throw new Error(`Local Agent gateway returned HTTP ${response.status}`);
    }
    return { status: response.status, body: parsed };
  }

  return {
    async connect(deviceId, credential) {
      const response = await post("connect", {
        version: LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
        deviceId,
        credential,
      });
      if (response.status === 401) return null;
      const body = isRecord(response.body) ? response.body : null;
      return body?.version === LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION
        ? validSession(body.session)
        : null;
    },
    async heartbeat(session, capabilities = [], serviceHealth) {
      const response = await post("heartbeat", {
        version: LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
        deviceId: session.deviceId,
        sessionToken: session.sessionToken,
        capabilities,
        ...(serviceHealth === undefined ? {} : { serviceHealth }),
      });
      return (
        response.status === 200 &&
        isRecord(response.body) &&
        response.body.version === LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION &&
        response.body.accepted === true
      );
    },
    async poll(session) {
      const response = await post("poll", {
        version: LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
        deviceId: session.deviceId,
        sessionToken: session.sessionToken,
      });
      if (response.status === 401) return null;
      const body = isRecord(response.body) ? response.body : null;
      if (
        !body ||
        body.version !== LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION ||
        !Array.isArray(body.requests) ||
        body.requests.length > 1
      ) {
        throw new Error("Local Agent gateway returned an invalid poll response");
      }
      const requests: Array<Omit<LocalAgentGatewayRequest, "version">> = [];
      for (const value of body.requests) {
        if (
          !isRecord(value) ||
          typeof value.requestId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId) ||
          typeof value.capability !== "string" ||
          value.capability.length < 1 ||
          value.capability.length > 128 ||
          typeof value.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(value.expiresAt))
        ) {
          throw new Error("Local Agent gateway returned an invalid request envelope");
        }
        if (new TextEncoder().encode(JSON.stringify(value.payload)).byteLength > 64 * 1024) {
          throw new Error("Local Agent gateway request exceeds the size limit");
        }
        requests.push({
          requestId: value.requestId,
          capability: value.capability,
          payload: value.payload,
          expiresAt: value.expiresAt,
        });
      }
      return requests;
    },
    async submitResult(session, result: LocalAgentGatewayResult) {
      const response = await post("result", {
        version: LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
        deviceId: session.deviceId,
        sessionToken: session.sessionToken,
        requestId: result.requestId,
        result: { version: result.version, outcome: result.outcome },
      });
      return (
        response.status === 200 &&
        isRecord(response.body) &&
        response.body.version === LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION &&
        response.body.accepted === true
      );
    },
  };
}
