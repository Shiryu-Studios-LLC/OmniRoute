import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const LOCAL_AGENT_HEARTBEAT_PATH = "/api/local-agents/heartbeat";

export interface LocalAgentHeartbeatPayload {
  status: "online" | "busy" | "offline";
  capabilities: string[];
  /** Fixed, endpoint-free reachability flags; omitted by older agents. */
  serviceHealth?: { ollama: boolean; comfyui: boolean };
}

/** Stable signing input shared by local agents and the registration service. */
export function canonicalLocalAgentHeartbeat(
  timestamp: number,
  nonce: string,
  payload: LocalAgentHeartbeatPayload
): string {
  const body = JSON.stringify({
    status: payload.status,
    capabilities: [...payload.capabilities].sort(),
    ...(payload.serviceHealth === undefined ? {} : { serviceHealth: payload.serviceHealth }),
  });
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  return `v1\nPOST\n${LOCAL_AGENT_HEARTBEAT_PATH}\n${timestamp}\n${nonce}\n${bodyDigest}`;
}

export function signLocalAgentHeartbeat(
  credential: string,
  timestamp: number,
  nonce: string,
  payload: LocalAgentHeartbeatPayload
): string {
  return createHmac("sha256", credential)
    .update(canonicalLocalAgentHeartbeat(timestamp, nonce, payload))
    .digest("hex");
}

export function localAgentCredentialDigest(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
