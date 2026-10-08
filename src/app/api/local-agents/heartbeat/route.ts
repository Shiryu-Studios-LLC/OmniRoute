import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { runWithTenantContext } from "@/lib/tenantContext";
import {
  acceptLocalAgentHeartbeat,
  getLocalAgent,
  getLocalAgentTenantForCredential,
} from "@/lib/db/localAgents";
import { logAuditEvent } from "@/lib/compliance";
import { z } from "zod";

const heartbeatSchema = z
  .object({
    deviceId: z.string().min(1).max(128),
    credential: z.string().min(32).max(128),
    timestamp: z.number().int().safe(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    signature: z.string().regex(/^[a-f0-9]{64}$/i),
    payload: z
      .object({
        status: z.enum(["online", "busy", "offline"]),
        capabilities: z.array(z.string().trim().min(1).max(80)).max(64),
        serviceHealth: z.object({ ollama: z.boolean(), comfyui: z.boolean() }).strict().optional(),
      })
      .strict(),
  })
  .strict();

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }
  const parsed = heartbeatSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse({ status: 400, message: "Invalid local agent heartbeat" });
  }
  const tenantId = getLocalAgentTenantForCredential(parsed.data.deviceId, parsed.data.credential);
  if (!tenantId) {
    return createErrorResponse({ status: 401, message: "Local agent heartbeat rejected" });
  }
  try {
    const agent = runWithTenantContext(
      { tenantId, principalId: `local-agent:${parsed.data.deviceId}`, role: "member" },
      () => {
        const previous = getLocalAgent(parsed.data.deviceId);
        const updated = acceptLocalAgentHeartbeat(parsed.data);
        if (previous) {
          const capabilitiesChanged =
            JSON.stringify([...previous.capabilities].sort()) !==
            JSON.stringify([...updated.capabilities].sort());
          if (previous.status !== updated.status || capabilitiesChanged) {
            logAuditEvent({
              action: "localAgent.heartbeat_transition",
              target: updated.id,
              resourceType: "local_agent",
              status: "success",
              details: {
                previousStatus: previous.status,
                status: updated.status,
                capabilitiesChanged,
              },
            });
          }
        }
        return updated;
      }
    );
    return NextResponse.json({ agent }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Heartbeat rejected";
    const clientErrors = new Set([
      "Invalid heartbeat timestamp",
      "Invalid heartbeat nonce",
      "Heartbeat timestamp outside allowed window",
      "Local agent is unavailable",
      "Invalid local agent credential",
      "Invalid local agent signature",
      "Heartbeat replay rejected",
    ]);
    if (clientErrors.has(message)) {
      return createErrorResponse({ status: 401, message: "Local agent heartbeat rejected" });
    }
    return createErrorResponse({ status: 500, message: "Failed to accept local agent heartbeat" });
  }
}
