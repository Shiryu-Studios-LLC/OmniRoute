import { NextResponse } from "next/server";
import { z } from "zod";
import { createErrorResponse } from "@/lib/api/errorResponse";
import {
  getTenantMembership,
  isTenantApiKeyPrincipal,
  removeTenantMembership,
  updateTenantMembershipRole,
} from "@/lib/db/tenantMemberships";
import type { TenantRole } from "@/lib/db/tenants";
import { authorizeTenantMembershipRequest } from "../_auth";
import { auditTenantMembershipChange } from "../_audit";

const updateSchema = z
  .object({
    role: z.enum(["owner", "admin", "member", "maintenance"]),
  })
  .strict();

type RouteContext = { params: Promise<{ principalId: string }> };

export async function PATCH(request: Request, routeContext: RouteContext) {
  const auth = await authorizeTenantMembershipRequest(request, "manage");
  if ("response" in auth) return auth.response;
  const { principalId } = await routeContext.params;
  const { tenantId } = auth.principal;
  if (!isTenantApiKeyPrincipal(tenantId, principalId)) {
    return createErrorResponse({ status: 404, message: "Tenant API-key principal not found" });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse({ status: 400, message: "Invalid tenant role" });
  }
  try {
    const member = updateTenantMembershipRole(
      tenantId,
      principalId,
      parsed.data.role as TenantRole
    );
    if (!member) return createErrorResponse({ status: 404, message: "Tenant member not found" });
    auditTenantMembershipChange(
      auth.principal,
      "tenantMembership.role.update",
      member.principalId,
      member.role
    );
    return NextResponse.json({ member });
  } catch (error) {
    if (error instanceof Error && error.message.includes("last tenant owner")) {
      return createErrorResponse({ status: 409, message: error.message });
    }
    return createErrorResponse({ status: 400, message: "Tenant membership could not be updated" });
  }
}

export async function DELETE(request: Request, routeContext: RouteContext) {
  const auth = await authorizeTenantMembershipRequest(request, "manage");
  if ("response" in auth) return auth.response;
  const { principalId } = await routeContext.params;
  const { tenantId } = auth.principal;
  if (!isTenantApiKeyPrincipal(tenantId, principalId)) {
    return createErrorResponse({ status: 404, message: "Tenant API-key principal not found" });
  }
  try {
    const previousMember = getTenantMembership(tenantId, principalId);
    if (!previousMember || !removeTenantMembership(tenantId, principalId)) {
      return createErrorResponse({ status: 404, message: "Tenant member not found" });
    }
    auditTenantMembershipChange(
      auth.principal,
      "tenantMembership.remove",
      previousMember.principalId,
      previousMember.role
    );
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("last tenant owner")) {
      return createErrorResponse({ status: 409, message: error.message });
    }
    return createErrorResponse({ status: 400, message: "Tenant membership could not be removed" });
  }
}
