/** Versioned envelope for the injected device-side gateway transport. */
export const LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION = 1 as const;

export class LocalAgentCredentialRejectedError extends Error {
  constructor() {
    super("Local Agent device credential was rejected by the gateway");
    this.name = "LocalAgentCredentialRejectedError";
  }
}

export interface LocalAgentGatewayRequest {
  version: typeof LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION;
  requestId: string;
  capability: string;
  payload: unknown;
  expiresAt: string;
  stream?: true;
}

export type LocalAgentGatewayStreamEvent =
  | { type: "delta"; data: { content: string } }
  | { type: "usage"; data: { promptTokens: number; completionTokens: number } }
  | { type: "done"; data: Record<string, never> }
  | { type: "error"; data: { code: "capability_execution_failed" } };

export type LocalAgentGatewayOutcome =
  { ok: true; value: unknown } | { ok: false; error: { code: "capability_execution_failed" } };

export interface LocalAgentGatewayResult {
  version: typeof LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION;
  requestId: string;
  outcome: LocalAgentGatewayOutcome;
}

export interface LocalAgentGatewaySession {
  sessionId: string;
  deviceId: string;
  tenantId: string;
  sessionToken: string;
  leaseExpiresAt: string;
}

export interface LocalAgentGatewayTransport {
  connect(deviceId: string, credential: string): Promise<LocalAgentGatewaySession | null>;
  heartbeat(
    session: LocalAgentGatewaySession,
    capabilities?: string[],
    serviceHealth?: { ollama: boolean; comfyui: boolean }
  ): Promise<boolean>;
  poll(
    session: LocalAgentGatewaySession
  ): Promise<Array<Omit<LocalAgentGatewayRequest, "version">> | null>;
  submitResult(
    session: LocalAgentGatewaySession,
    result: LocalAgentGatewayResult
  ): Promise<boolean>;
  submitStreamEvent?(
    session: LocalAgentGatewaySession,
    requestId: string,
    sequence: number,
    event: LocalAgentGatewayStreamEvent
  ): Promise<boolean>;
  cancelStream?(session: LocalAgentGatewaySession, requestId: string): Promise<boolean>;
  getImageJobControl?(
    session: LocalAgentGatewaySession,
    requestId: string
  ): Promise<"running" | "cancelled" | "expired" | null>;
  uploadImageJobArtifact?(
    session: LocalAgentGatewaySession,
    requestId: string,
    bytes: Uint8Array,
    contentType: string
  ): Promise<boolean>;
  completeImageJob?(
    session: LocalAgentGatewaySession,
    requestId: string,
    promptId: string
  ): Promise<boolean>;
  failImageJob?(
    session: LocalAgentGatewaySession,
    requestId: string,
    code:
      | "execution_failed"
      | "capability_unavailable"
      | "artifact_upload_failed"
      | "cancelled"
      | "expired"
  ): Promise<boolean>;
}

/** Structural contract implemented by createConnectorGateway(). */
export interface ConnectorGatewayPort {
  connect(deviceId: string, credential: string): Promise<LocalAgentGatewaySession | null>;
  heartbeat(
    deviceId: string,
    sessionToken: string,
    capabilities?: string[],
    serviceHealth?: { ollama: boolean; comfyui: boolean }
  ): Promise<boolean>;
  pollDeviceRequests(input: {
    deviceId: string;
    sessionToken: string;
    limit?: number;
  }): Promise<Array<Omit<LocalAgentGatewayRequest, "version">> | null>;
  submitDeviceResult(input: {
    deviceId: string;
    sessionToken: string;
    requestId: string;
    result: unknown;
  }): Promise<boolean>;
  submitDeviceStreamEvent?(input: {
    deviceId: string;
    sessionToken: string;
    requestId: string;
    sequence: number;
    event: LocalAgentGatewayStreamEvent;
  }): Promise<boolean>;
  cancelDeviceStream?(input: {
    deviceId: string;
    sessionToken: string;
    requestId: string;
  }): Promise<boolean>;
}

/** Map the v1 agent envelope onto the existing gateway connect/poll/result primitives. */
export function createConnectorGatewayTransport(
  gateway: ConnectorGatewayPort
): LocalAgentGatewayTransport {
  return {
    connect: (deviceId, credential) => gateway.connect(deviceId, credential),
    heartbeat: (session, capabilities, serviceHealth) =>
      gateway.heartbeat(session.deviceId, session.sessionToken, capabilities, serviceHealth),
    poll: (session) =>
      gateway.pollDeviceRequests({
        deviceId: session.deviceId,
        sessionToken: session.sessionToken,
        limit: 1,
      }),
    submitResult: (session, result) =>
      gateway.submitDeviceResult({
        deviceId: session.deviceId,
        sessionToken: session.sessionToken,
        requestId: result.requestId,
        result: {
          version: result.version,
          outcome: result.outcome,
        },
      }),
    submitStreamEvent: (session, requestId, sequence, event) =>
      gateway.submitDeviceStreamEvent?.({
        deviceId: session.deviceId,
        sessionToken: session.sessionToken,
        requestId,
        sequence,
        event,
      }) ?? Promise.resolve(false),
    cancelStream: (session, requestId) =>
      gateway.cancelDeviceStream?.({
        deviceId: session.deviceId,
        sessionToken: session.sessionToken,
        requestId,
      }) ?? Promise.resolve(false),
  };
}
