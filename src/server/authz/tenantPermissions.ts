import type { TenantRole } from "@/lib/db/tenants";

export type TenantManagementPermission = "read" | "manage" | "maintenance";

const ROLE_PERMISSIONS: Record<TenantRole, ReadonlySet<TenantManagementPermission>> = {
  owner: new Set(["read", "manage", "maintenance"]),
  admin: new Set(["read", "manage", "maintenance"]),
  member: new Set(["read"]),
  maintenance: new Set(["read", "maintenance"]),
};

const TENANT_RESOURCE_PREFIXES = [
  "/api/keys",
  "/api/providers",
  "/api/combos",
  "/api/quota",
  "/api/usage",
  "/api/usage/budget",
  "/api/local-agents",
  "/api/tenant-members",
] as const;
const MAINTENANCE_PATHS = [
  /^\/api\/usage\/combo-health-autopilot(?:\/|$)/,
  /^\/api\/providers\/health-(?:autopilot|matrix)(?:\/|$)/,
  /^\/api\/providers\/[^/]+\/sync-models(?:\/|$)/,
  /^\/api\/(?:db\/health|health\/degradation|monitoring\/health)(?:\/|$)/,
];

export function isTenantManagementResource(path: string): boolean {
  return TENANT_RESOURCE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

/** Resolve the capability required for a tenant resource request. */
export function getTenantManagementPermission(
  path: string,
  method: string
): TenantManagementPermission | null {
  if (!isTenantManagementResource(path)) return null;

  if (MAINTENANCE_PATHS.some((pattern) => pattern.test(path))) return "maintenance";

  // Revealing a stored API key is secret access even though the route is GET.
  if (/^\/api\/keys\/[^/]+\/reveal(?:\/|$)/.test(path)) return "manage";

  const normalizedMethod = method.toUpperCase();
  return normalizedMethod === "GET" || normalizedMethod === "HEAD" ? "read" : "manage";
}

export function hasTenantManagementPermission(
  role: TenantRole,
  permission: TenantManagementPermission
): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
