import { NextResponse } from "next/server";
import { z } from "zod";
import { createErrorResponse } from "@/lib/api/errorResponse";
import {
  addTenantMembership,
  isTenantApiKeyPrincipal,
  listTenantMemberships,
} from "@/lib/db/tenantMemberships";
import type { TenantRole } from "@/lib/db/tenants";
import { authorizeTenantMembershipRequest } from "./_auth";
import { auditTenantMembershipChange } from "./_audit";

const createSchema = z
  .object({
    principalId: z.string().trim().min(1).max(256),
    role: z.enum(["owner", "admin", "member", "maintenance"]),
  })
  .strict();

export async function GET(request: Request) {
  const auth = await authorizeTenantMembershipRequest(request, "read");
  if ("response" in auth) return auth.response;
  try {
    return NextResponse.json({ members: listTenantMemberships(auth.principal.tenantId) });
  } catch {
    return createErrorResponse({ status: 500, message: "Failed to list tenant members" });
  }
}

export async function POST(request: Request) {
  const auth = await authorizeTenantMembershipRequest(request, "manage");
  if ("response" in auth) return auth.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse({ status: 400, message: "Invalid tenant membership" });
  }
  const { tenantId } = auth.principal;
  if (!isTenantApiKeyPrincipal(tenantId, parsed.data.principalId)) {
    return createErrorResponse({ status: 404, message: "Tenant API-key principal not found" });
  }
  try {
    const member = addTenantMembership(
      tenantId,
      parsed.data.principalId,
      parsed.data.role as TenantRole
    );
    auditTenantMembershipChange(
      auth.principal,
      "tenantMembership.create",
      member.principalId,
      member.role
    );
    return NextResponse.json({ member }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint failed")) {
      return createErrorResponse({ status: 409, message: "Tenant membership already exists" });
    }
    if (message.includes("not found")) {
      return createErrorResponse({ status: 404, message: "Tenant API-key principal not found" });
    }
    return createErrorResponse({ status: 400, message: "Tenant membership could not be created" });
  }
}
