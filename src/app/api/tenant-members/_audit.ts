import { logAuditEvent } from "@/lib/compliance";
import { runWithTenantContext } from "@/lib/tenantContext";
import type { TenantMembershipRequestPrincipal } from "./_auth";

export function auditTenantMembershipChange(
  actor: TenantMembershipRequestPrincipal,
  action: "tenantMembership.create" | "tenantMembership.role.update" | "tenantMembership.remove",
  affectedPrincipalId: string,
  affectedRole: string
): void {
  try {
    runWithTenantContext(
      {
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        role: actor.role,
      },
      () => {
        logAuditEvent({
          action,
          actor: actor.principalId,
          target: affectedPrincipalId,
          details: { principalId: affectedPrincipalId, role: affectedRole },
          resourceType: "tenant_member",
          status: "success",
        });
      }
    );
  } catch {
    // Compliance logging is best-effort and must not undo a successful membership change.
  }
}
