import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getTenantContext } from "@/lib/tenantContext";
import { registerLocalAgent, listLocalAgents } from "@/lib/db/localAgents";
import { logAuditEvent } from "@/lib/compliance";
import { z } from "zod";

const registerSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    tenantId: z.string().min(1).optional(),
  })
  .strict();

function requireTenant(): Response | null {
  const authError = getTenantContext()?.tenantId
    ? null
    : createErrorResponse({ status: 403, message: "Authenticated tenant context required" });
  return authError;
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;
  const tenantError = requireTenant();
  if (tenantError) return tenantError;

  try {
    return NextResponse.json({ agents: listLocalAgents() });
  } catch {
    return createErrorResponse({ status: 500, message: "Failed to list local agents" });
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;
  const tenantError = requireTenant();
  if (tenantError) return tenantError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse({ status: 400, message: "Invalid local agent registration" });
  }
  const tenantId = getTenantContext()!.tenantId;
  if (parsed.data.tenantId !== undefined && parsed.data.tenantId !== tenantId) {
    return createErrorResponse({ status: 403, message: "Cross-tenant operation denied" });
  }

  try {
    const registration = registerLocalAgent({ name: parsed.data.name, tenantId });
    logAuditEvent({
      action: "localAgent.register",
      target: registration.device.id,
      resourceType: "local_agent",
      status: "success",
      details: { name: registration.device.name },
    });
    return NextResponse.json(registration, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return createErrorResponse({ status: 400, message: "Local agent registration failed" });
  }
}
