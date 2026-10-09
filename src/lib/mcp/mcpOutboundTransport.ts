/**
 * Host-runtime-neutral contract for outbound MCP requests. Implementations must
 * bind the socket destination to the public addresses checked for this request.
 */
export interface McpOutboundTransport {
  fetch(
    input: string,
    init: RequestInit,
    context?: { tenantId: string; serverId: string }
  ): Promise<Response>;
}

export class McpOutboundEgressError extends Error {
  constructor(
    readonly code: "MCP_OUTBOUND_DNS_REJECTED",
    message = "MCP DNS policy rejected the target"
  ) {
    super(message);
    this.name = "McpOutboundEgressError";
  }
}
