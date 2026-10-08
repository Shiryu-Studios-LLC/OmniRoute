import { createErrorResponse } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getTenantContext } from "@/lib/tenantContext";
import { revokeLocalAgent } from "@/lib/db/localAgents";
import { logAuditEvent } from "@/lib/compliance";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: Request, context: RouteContext) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;
  if (!getTenantContext()?.tenantId) {
    return createErrorResponse({ status: 403, message: "Authenticated tenant context required" });
  }

  const { id } = await context.params;
  if (!id || id.length > 128) {
    return createErrorResponse({ status: 400, message: "Invalid local agent ID" });
  }
  try {
    const revoked = revokeLocalAgent(id);
    if (!revoked) return createErrorResponse({ status: 404, message: "Local agent not found" });
    logAuditEvent({
      action: "localAgent.revoke",
      target: id,
      resourceType: "local_agent",
      status: "success",
    });
    return Response.json({ revoked: true });
  } catch {
    return createErrorResponse({ status: 500, message: "Failed to revoke local agent" });
  }
}
