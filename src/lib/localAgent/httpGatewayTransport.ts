import {
  LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
  type LocalAgentGatewayRequest,
  type LocalAgentGatewayResult,
  type LocalAgentGatewaySession,
  type LocalAgentGatewayStreamEvent,
  type LocalAgentGatewayTransport,
} from "./gatewayProtocol";

const BASE_PATH = "/__gateway/v1/device";
const MAX_REQUEST_BYTES = 80 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const STREAM_EVENT_TIMEOUT_MS = 35_000;
const IMAGE_JOB_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const IMAGE_JOB_TIMEOUT_MS = 120_000;
const IMAGE_JOB_FAIL_CODES = new Set([
  "execution_failed",
  "capability_unavailable",
  "artifact_upload_failed",
  "cancelled",
  "expired",
]);

export interface HttpGatewayTransportOptions {
  fetch: typeof fetch;
  requestTimeoutMs?: number;
  streamEventTimeoutMs?: number;
  imageJobTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validStreamEvent(value: LocalAgentGatewayStreamEvent): boolean {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  if (value.type === "delta") {
    return (
      Object.keys(value.data).length === 1 &&
      typeof value.data.content === "string" &&
      new TextEncoder().encode(value.data.content).byteLength <= 4096
    );
  }
  if (value.type === "usage") {
    return (
      Object.keys(value.data).length === 2 &&
      Number.isSafeInteger(value.data.promptTokens) &&
      Number(value.data.promptTokens) >= 0 &&
      Number.isSafeInteger(value.data.completionTokens) &&
      Number(value.data.completionTokens) >= 0
    );
  }
  if (value.type === "done") return Object.keys(value.data).length === 0;
  return (
    value.type === "error" &&
    Object.keys(value.data).length === 1 &&
    value.data.code === "capability_execution_failed"
  );
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

function cancelResponseBody(response: Response): void {
  if (!response.body || response.body.locked) return;
  void response.body.cancel("Local Agent gateway response rejected").catch(() => undefined);
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        void reader
          .cancel("Local Agent gateway response exceeds the size limit")
          .catch(() => undefined);
        throw new Error("Local Agent gateway response exceeds the size limit");
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    void reader.cancel("Local Agent gateway response could not be read").catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
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
  const streamEventTimeout = options.streamEventTimeoutMs ?? STREAM_EVENT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(streamEventTimeout) ||
    streamEventTimeout < 100 ||
    streamEventTimeout > 120_000
  ) {
    throw new Error("Invalid Local Agent gateway stream event timeout");
  }
  const imageJobTimeout = options.imageJobTimeoutMs ?? IMAGE_JOB_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(imageJobTimeout) ||
    imageJobTimeout < 100 ||
    imageJobTimeout > 120_000
  ) {
    throw new Error("Invalid Local Agent image-job timeout");
  }

  async function post(
    path: string,
    body: unknown,
    requestTimeout = timeout
  ): Promise<{ status: number; body: unknown }> {
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
      throw new Error("Local Agent gateway request exceeds the size limit");
    }
    const url = new URL(`${BASE_PATH}/${path}`, base.origin);
    const response = await options.fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeout),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: serialized,
    });
    const advertisedLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertisedLength) && advertisedLength > MAX_RESPONSE_BYTES) {
      cancelResponseBody(response);
      throw new Error("Local Agent gateway response exceeds the size limit");
    }
    const responseText = await readBoundedResponseText(response);
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
          !Number.isFinite(Date.parse(value.expiresAt)) ||
          (value.stream !== undefined && value.stream !== true)
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
          ...(Number.isSafeInteger(value.deliveryAttempt)
            ? { deliveryAttempt: Number(value.deliveryAttempt) }
            : {}),
          ...(value.stream === true ? { stream: true as const } : {}),
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
        deliveryAttempt: result.deliveryAttempt,
        result: { version: result.version, outcome: result.outcome },
      });
      return (
        response.status === 200 &&
        isRecord(response.body) &&
        response.body.version === LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION &&
        response.body.accepted === true
      );
    },
    async submitStreamEvent(
      session: LocalAgentGatewaySession,
      requestId: string,
      sequence: number,
      event: LocalAgentGatewayStreamEvent
    ) {
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        !validStreamEvent(event) ||
        new TextEncoder().encode(JSON.stringify(event)).byteLength > 8 * 1024
      ) {
        return false;
      }
      const response = await post(
        "stream-event",
        {
          version: LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
          deviceId: session.deviceId,
          sessionToken: session.sessionToken,
          requestId,
          sequence,
          event,
        },
        streamEventTimeout
      );
      return (
        response.status === 200 &&
        isRecord(response.body) &&
        response.body.version === LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION &&
        response.body.accepted === true
      );
    },
    async cancelStream(session: LocalAgentGatewaySession, requestId: string) {
      const response = await post("stream-cancel", {
        version: LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
        deviceId: session.deviceId,
        sessionToken: session.sessionToken,
        requestId,
      });
      return (
        response.status === 200 &&
        isRecord(response.body) &&
        response.body.version === LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION &&
        response.body.accepted === true
      );
    },
    async getImageJobControl(session: LocalAgentGatewaySession, requestId: string) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) return null;
      const url = new URL(`${BASE_PATH}/image-jobs/${requestId}/control`, base.origin);
      const response = await options.fetch(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(imageJobTimeout),
        headers: {
          accept: "application/json",
          "x-device-id": session.deviceId,
          authorization: `Bearer ${session.sessionToken}`,
        },
      });
      if (response.status === 404) return "expired";
      if (!response.ok) return null;
      const advertisedLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(advertisedLength) && advertisedLength > 1024) return null;
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 1024) return null;
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return null;
      }
      if (!isRecord(body)) return null;
      return body.status === "running" || body.status === "cancelled" || body.status === "expired"
        ? body.status
        : null;
    },
    async uploadImageJobArtifact(session, requestId, bytes, contentType) {
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 1 ||
        bytes.byteLength > IMAGE_JOB_MAX_ARTIFACT_BYTES ||
        !["image/png", "image/jpeg", "image/webp"].includes(contentType)
      ) {
        return false;
      }
      const url = new URL(`${BASE_PATH}/image-jobs/${requestId}/artifact`, base.origin);
      const response = await options.fetch(url, {
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.timeout(imageJobTimeout),
        headers: {
          "content-type": contentType,
          "content-length": String(bytes.byteLength),
          "x-device-id": session.deviceId,
          authorization: `Bearer ${session.sessionToken}`,
        },
        body: bytes,
      });
      await response.body?.cancel();
      return response.ok;
    },
    async completeImageJob(session, requestId, promptId) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || !/^[A-Za-z0-9_-]{1,128}$/.test(promptId)) {
        return false;
      }
      const response = await options.fetch(
        new URL(`${BASE_PATH}/image-jobs/${requestId}/complete`, base.origin),
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(imageJobTimeout),
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-device-id": session.deviceId,
            authorization: `Bearer ${session.sessionToken}`,
          },
          body: JSON.stringify({ promptId }),
        }
      );
      await response.body?.cancel();
      return response.ok;
    },
    async failImageJob(session, requestId, code) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || !IMAGE_JOB_FAIL_CODES.has(code)) {
        return false;
      }
      const response = await options.fetch(
        new URL(`${BASE_PATH}/image-jobs/${requestId}/fail`, base.origin),
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(imageJobTimeout),
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-device-id": session.deviceId,
            authorization: `Bearer ${session.sessionToken}`,
          },
          body: JSON.stringify({ code }),
        }
      );
      await response.body?.cancel();
      return response.ok;
    },
  };
}
