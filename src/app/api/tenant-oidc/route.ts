import { NextResponse } from "next/server";
import { z } from "zod";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { logAuditEvent } from "@/lib/compliance";
import {
  deleteTenantOidcConfig,
  disableTenantOidcConfig,
  getTenantOidcConfig,
  setTenantOidcConfig,
} from "@/lib/db/tenantOidc";
import { runWithTenantContext } from "@/lib/tenantContext";
import { authorizeTenantMembershipRequest } from "../tenant-members/_auth";

const issuerSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .url()
  .refine((value) => {
    try {
      const issuer = new URL(value);
      return (
        issuer.protocol === "https:" &&
        issuer.username.length === 0 &&
        issuer.password.length === 0 &&
        issuer.search.length === 0 &&
        issuer.hash.length === 0
      );
    } catch {
      return false;
    }
  }, "Issuer must be an HTTPS URL without credentials, query, or fragment");

const updateSchema = z
  .object({
    issuer: issuerSchema,
    clientId: z.string().trim().min(1).max(200),
    clientSecret: z.string().min(1).max(500).optional(),
    scopes: z.array(z.string().trim().min(1).max(100)).min(1).max(32).optional(),
  })
  .strict();

const disableSchema = z.object({ isEnabled: z.literal(false) }).strict();

type TenantPrincipal = {
  tenantId: string;
  principalId: string;
  role: "owner" | "admin" | "member" | "maintenance";
};

function runForPrincipal<T>(principal: TenantPrincipal, callback: () => T): T {
  return runWithTenantContext(
    {
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      role: principal.role,
    },
    callback
  );
}

function auditConfigChange(
  principal: TenantPrincipal,
  operation: "create" | "update" | "disable" | "delete"
): void {
  try {
    runForPrincipal(principal, () =>
      logAuditEvent({
        action: `tenantOidc.config.${operation}`,
        actor: principal.principalId,
        target: principal.tenantId,
        resourceType: "tenant_oidc_config",
        status: "success",
      })
    );
  } catch {
    // Config persistence must not be undone by a best-effort audit write.
  }
}

async function authorize(request: Request) {
  return authorizeTenantMembershipRequest(request, "manage");
}

/** Read only safe OIDC metadata. Client secrets are never returned by this API. */
export async function GET(request: Request) {
  const auth = await authorize(request);
  if ("response" in auth) return auth.response;
  try {
    const config = runForPrincipal(auth.principal, getTenantOidcConfig);
    return NextResponse.json({ config }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return createErrorResponse({
      status: 500,
      message: "Failed to read tenant OIDC configuration",
    });
  }
}

/** Create or update issuer metadata. New configurations are always disabled. */
export async function PUT(request: Request) {
  const auth = await authorize(request);
  if ("response" in auth) return auth.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse({ status: 400, message: "Invalid tenant OIDC configuration" });
  }
  try {
    const current = runForPrincipal(auth.principal, getTenantOidcConfig);
    if (!current && !parsed.data.clientSecret) {
      return createErrorResponse({ status: 400, message: "Client secret is required for setup" });
    }
    const config = runForPrincipal(auth.principal, () =>
      setTenantOidcConfig({
        ...parsed.data,
        scopes: parsed.data.scopes ?? current?.scopes,
        isEnabled: current?.isEnabled ?? false,
      })
    );
    auditConfigChange(auth.principal, current ? "update" : "create");
    return NextResponse.json(
      { config },
      {
        status: current ? 200 : 201,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch {
    return createErrorResponse({
      status: 400,
      message: "Tenant OIDC configuration could not be saved",
    });
  }
}

/** Disable OIDC for the tenant while retaining its encrypted credentials. */
export async function PATCH(request: Request) {
  const auth = await authorize(request);
  if ("response" in auth) return auth.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }
  if (!disableSchema.safeParse(body).success) {
    return createErrorResponse({ status: 400, message: "Only disabling tenant OIDC is supported" });
  }
  try {
    const config = runForPrincipal(auth.principal, disableTenantOidcConfig);
    if (!config) {
      return createErrorResponse({ status: 404, message: "Tenant OIDC configuration not found" });
    }
    auditConfigChange(auth.principal, "disable");
    return NextResponse.json({ config }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return createErrorResponse({
      status: 500,
      message: "Tenant OIDC configuration could not be disabled",
    });
  }
}

/** Delete the tenant's OIDC configuration and its encrypted client secret. */
export async function DELETE(request: Request) {
  const auth = await authorize(request);
  if ("response" in auth) return auth.response;
  try {
    const deleted = runForPrincipal(auth.principal, deleteTenantOidcConfig);
    if (!deleted) {
      return createErrorResponse({ status: 404, message: "Tenant OIDC configuration not found" });
    }
    auditConfigChange(auth.principal, "delete");
    return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return createErrorResponse({
      status: 500,
      message: "Tenant OIDC configuration could not be deleted",
    });
  }
}
