/** Versioned envelope for the injected device-side gateway transport. */
export const LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION = 1 as const;

export interface LocalAgentGatewayRequest {
  version: typeof LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION;
  requestId: string;
  capability: string;
  payload: unknown;
  expiresAt: string;
}

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
  heartbeat(session: LocalAgentGatewaySession, capabilities?: string[]): Promise<boolean>;
  poll(
    session: LocalAgentGatewaySession
  ): Promise<Array<Omit<LocalAgentGatewayRequest, "version">> | null>;
  submitResult(
    session: LocalAgentGatewaySession,
    result: LocalAgentGatewayResult
  ): Promise<boolean>;
}

/** Structural contract implemented by createConnectorGateway(). */
export interface ConnectorGatewayPort {
  connect(deviceId: string, credential: string): Promise<LocalAgentGatewaySession | null>;
  heartbeat(deviceId: string, sessionToken: string, capabilities?: string[]): Promise<boolean>;
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
}

/** Map the v1 agent envelope onto the existing gateway connect/poll/result primitives. */
export function createConnectorGatewayTransport(
  gateway: ConnectorGatewayPort
): LocalAgentGatewayTransport {
  return {
    connect: (deviceId, credential) => gateway.connect(deviceId, credential),
    heartbeat: (session, capabilities) =>
      gateway.heartbeat(session.deviceId, session.sessionToken, capabilities),
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
  };
}
