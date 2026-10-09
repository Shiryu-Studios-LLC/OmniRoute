/**
 * Runtime-neutral authorization DTOs shared across server and edge-compatible
 * code. Keep this module free of Node.js and framework imports.
 */

export type RouteClass = "PUBLIC" | "CLIENT_API" | "MANAGEMENT";

export type ClassificationReason =
  | "public_prefix"
  | "public_readonly_prefix"
  | "dashboard_prefix"
  | "setup_wizard"
  | "public_connect_page"
  | "client_api_v1"
  | "client_api_mcp"
  | "client_api_alias"
  | "client_api_codex_alias"
  | "client_api_double_prefix"
  | "management_api"
  | "root_redirect"
  | "fallback_management";

export interface RouteClassification {
  routeClass: RouteClass;
  reason: ClassificationReason;
  /** Normalized internal pathname after aliases and rewrites. */
  normalizedPath: string;
}

/** Identity of a principal accepted by an authorization policy. */
export interface AuthSubject {
  kind: "client_api_key" | "dashboard_session" | "management_key" | "anonymous";
  /** Stable non-secret identifier for the principal. */
  id: string;
  /** Optional human-friendly label; never includes the raw secret. */
  label?: string;
  /** Granted scopes. Empty for unauthenticated subjects. */
  scopes?: ReadonlyArray<string>;
}
