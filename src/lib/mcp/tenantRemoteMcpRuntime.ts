/**
 * Cloud-safe, tenant-authorized access to registered remote MCP servers.
 *
 * This module has no database or Node.js dependencies. Callers supply a
 * tenant-scoped registry and an authorization adapter so it can be used by a
 * Worker without trusting request-supplied tenant IDs.
 * Outbound requests require an explicit controlled-egress transport; never
 * pass global fetch here. Worker callers need an egress proxy because Workers
 * fetch has no socket lookup hook. Remote tool invocation remains disabled
 * until credentials are integrated with that same controlled-egress boundary.
 */
import { McpOutboundEgressError, type McpOutboundTransport } from "./mcpOutboundTransport.ts";

export type RemoteMcpTransport = "sse" | "streamable_http";

export interface RegisteredRemoteMcpServer {
  id: string;
  tenantId: string;
  name: string;
  transport: RemoteMcpTransport;
  endpoint: string;
  isActive: boolean;
}

export interface RemoteMcpPrincipal {
  /** Stable subject assigned by the authentication layer, never request input. */
  subject: string;
}

export interface TenantMcpAuthorization {
  /** Derive tenant identity from authenticated server-side principal state. */
  resolveTenant(principal: RemoteMcpPrincipal): Promise<string | null>;
  /** Apply MCP-specific permissions and resource-level authorization. */
  canAccessServer(
    principal: RemoteMcpPrincipal,
    tenantId: string,
    serverId: string,
    action: "discover" | "invoke"
  ): Promise<boolean>;
}

export interface TenantMcpRegistry {
  listByTenant(tenantId: string): Promise<RegisteredRemoteMcpServer[]>;
  getById(tenantId: string, serverId: string): Promise<RegisteredRemoteMcpServer | null>;
}

export interface TenantRemoteMcpRuntimeOptions {
  authorization: TenantMcpAuthorization;
  registry: TenantMcpRegistry;
  /** Must bind the destination socket to validated public IPs or a controlled proxy. */
  transport: McpOutboundTransport;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxTools?: number;
}

export interface DiscoveredRemoteMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface RemoteMcpDiscovery {
  serverId: string;
  serverName: string;
  transport: RemoteMcpTransport;
  protocolVersion: string | null;
  serverInfo: { name: string; version?: string } | null;
  tools: DiscoveredRemoteMcpTool[];
}

export class TenantRemoteMcpError extends Error {
  constructor(
    readonly code:
      | "UNAUTHENTICATED"
      | "TENANT_FORBIDDEN"
      | "MCP_SERVER_NOT_FOUND"
      | "MCP_SERVER_INACTIVE"
      | "MCP_TRANSPORT_UNSUPPORTED"
      | "MCP_OUTBOUND_TARGET_REJECTED"
      | "MCP_OUTBOUND_DNS_REJECTED"
      | "MCP_UPSTREAM_REDIRECT_REJECTED"
      | "MCP_UPSTREAM_TIMEOUT"
      | "MCP_UPSTREAM_RESPONSE_TOO_LARGE"
      | "MCP_UPSTREAM_UNAVAILABLE"
      | "MCP_UPSTREAM_PROTOCOL_ERROR"
      | "MCP_INVOCATION_DISABLED",
    message: string
  ) {
    super(message);
    this.name = "TenantRemoteMcpError";
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_MAX_TOOLS = 100;
const MCP_PROTOCOL_VERSION = "2024-11-05";

function isIpv4Address(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
  );
}

function isPublicIpv4(value: string): boolean {
  if (!isIpv4Address(value)) return false;
  const [a, b, c] = value.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255 && b === 255 && c === 255) return false;
  return true;
}

function expandIpv6(value: string): number[] | null {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized.includes(":")) return null;
  if (normalized.includes(".")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array(missing).fill(0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
}

function isPublicIpv6(value: string): boolean {
  const groups = expandIpv6(value);
  if (!groups || groups.length !== 8) return false;
  const first = groups[0];
  const second = groups[1];
  // Use only global-unicast IPv6. Reject unspecified, loopback, mapped,
  // unique-local, link-local, multicast, transition, and documentation blocks.
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && second <= 0x01ff) return false;
  if (first === 0x2002 || first === 0x3fff) return false;
  return true;
}

function isPublicAddress(value: string): boolean {
  return value.includes(":") ? isPublicIpv6(value) : isPublicIpv4(value);
}

function parseSafeEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TenantRemoteMcpError("MCP_OUTBOUND_TARGET_REJECTED", "MCP endpoint URL is invalid");
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  const port = url.port ? Number(url.port) : 443;
  const unsafeHostSuffixes = [".localhost", ".local", ".internal", ".test", ".invalid", ".example"];
  const isLiteral = isIpv4Address(hostname) || hostname.includes(":");
  const blockedHost =
    hostname === "localhost" ||
    unsafeHostSuffixes.some((suffix) => hostname.endsWith(suffix)) ||
    (isLiteral && !isPublicAddress(hostname));

  if (
    url.protocol !== "https:" ||
    !hostname ||
    blockedHost ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    (url.search.length > 0 && url.searchParams.size > 0) ||
    port !== 443
  ) {
    throw new TenantRemoteMcpError(
      "MCP_OUTBOUND_TARGET_REJECTED",
      "MCP endpoint must be a public HTTPS URL on port 443 without embedded credentials"
    );
  }
  return url;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TenantRemoteMcpError(
          "MCP_UPSTREAM_RESPONSE_TOO_LARGE",
          "MCP server response exceeded the configured limit"
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseRpcResponse(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TenantRemoteMcpError(
      "MCP_UPSTREAM_PROTOCOL_ERROR",
      "MCP server returned invalid JSON"
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TenantRemoteMcpError(
      "MCP_UPSTREAM_PROTOCOL_ERROR",
      "MCP server returned an invalid response"
    );
  }
  const record = value as Record<string, unknown>;
  if (record.error) {
    throw new TenantRemoteMcpError("MCP_UPSTREAM_PROTOCOL_ERROR", "MCP server rejected discovery");
  }
  return record;
}

function parseServerInfo(value: unknown): RemoteMcpDiscovery["serverInfo"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) return null;
  return {
    name: record.name.slice(0, 128),
    ...(typeof record.version === "string" ? { version: record.version.slice(0, 64) } : {}),
  };
}

function parseTools(value: unknown, maxTools: number): DiscoveredRemoteMcpTool[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TenantRemoteMcpError(
      "MCP_UPSTREAM_PROTOCOL_ERROR",
      "MCP server returned invalid tools"
    );
  }
  const tools = (value as Record<string, unknown>).tools;
  if (!Array.isArray(tools) || tools.length > maxTools) {
    throw new TenantRemoteMcpError(
      "MCP_UPSTREAM_PROTOCOL_ERROR",
      "MCP server returned invalid tools"
    );
  }
  return tools.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TenantRemoteMcpError(
        "MCP_UPSTREAM_PROTOCOL_ERROR",
        "MCP server returned invalid tools"
      );
    }
    const tool = entry as Record<string, unknown>;
    if (typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > 128) {
      throw new TenantRemoteMcpError(
        "MCP_UPSTREAM_PROTOCOL_ERROR",
        "MCP server returned invalid tools"
      );
    }
    return {
      name: tool.name,
      ...(typeof tool.description === "string"
        ? { description: tool.description.slice(0, 2_000) }
        : {}),
      ...(tool.inputSchema &&
      typeof tool.inputSchema === "object" &&
      !Array.isArray(tool.inputSchema)
        ? { inputSchema: tool.inputSchema as Record<string, unknown> }
        : {}),
    };
  });
}

export function createTenantRemoteMcpRuntime(options: TenantRemoteMcpRuntimeOptions) {
  const transport = options.transport;
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000));
  const maxResponseBytes = Math.max(
    1_024,
    Math.min(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 2 * 1024 * 1024)
  );
  const maxTools = Math.max(1, Math.min(options.maxTools ?? DEFAULT_MAX_TOOLS, 500));

  async function resolveAuthorizedServer(
    principal: RemoteMcpPrincipal,
    serverId: string,
    action: "discover" | "invoke"
  ): Promise<RegisteredRemoteMcpServer> {
    if (!principal || typeof principal.subject !== "string" || principal.subject.length === 0) {
      throw new TenantRemoteMcpError("UNAUTHENTICATED", "Authentication is required");
    }
    const tenantId = await options.authorization.resolveTenant(principal);
    if (!tenantId) throw new TenantRemoteMcpError("UNAUTHENTICATED", "Authentication is required");
    if (!(await options.authorization.canAccessServer(principal, tenantId, serverId, action))) {
      throw new TenantRemoteMcpError("TENANT_FORBIDDEN", "MCP server access is not authorized");
    }
    const server = await options.registry.getById(tenantId, serverId);
    if (!server || server.tenantId !== tenantId) {
      throw new TenantRemoteMcpError("MCP_SERVER_NOT_FOUND", "MCP server was not found");
    }
    if (!server.isActive) {
      throw new TenantRemoteMcpError("MCP_SERVER_INACTIVE", "MCP server is inactive");
    }
    return server;
  }

  async function postJsonRpc(
    endpoint: URL,
    message: Record<string, unknown>,
    sessionId?: string
  ): Promise<{ response: Response; body: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await transport.fetch(endpoint.toString(), {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        },
        body: JSON.stringify(message),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new TenantRemoteMcpError(
          "MCP_UPSTREAM_REDIRECT_REJECTED",
          "MCP server redirects are disabled"
        );
      }
      if (!response.ok) {
        throw new TenantRemoteMcpError("MCP_UPSTREAM_UNAVAILABLE", "MCP server discovery failed");
      }
      return { response, body: await readBoundedText(response, maxResponseBytes) };
    } catch (error) {
      if (error instanceof TenantRemoteMcpError) throw error;
      if (error instanceof McpOutboundEgressError) {
        throw new TenantRemoteMcpError("MCP_OUTBOUND_DNS_REJECTED", error.message);
      }
      if (controller.signal.aborted) {
        throw new TenantRemoteMcpError("MCP_UPSTREAM_TIMEOUT", "MCP server request timed out");
      }
      throw new TenantRemoteMcpError("MCP_UPSTREAM_UNAVAILABLE", "MCP server discovery failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  async function discoverTools(
    principal: RemoteMcpPrincipal,
    serverId: string
  ): Promise<RemoteMcpDiscovery> {
    const server = await resolveAuthorizedServer(principal, serverId, "discover");
    if (server.transport !== "streamable_http") {
      throw new TenantRemoteMcpError(
        "MCP_TRANSPORT_UNSUPPORTED",
        "Remote discovery currently supports Streamable HTTP only"
      );
    }
    const endpoint = parseSafeEndpoint(server.endpoint);
    const initialized = await postJsonRpc(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "OmniRoute", version: "cloud" },
      },
    });
    const initResponse = parseRpcResponse(initialized.body);
    const initResult = initResponse.result;
    if (!initResult || typeof initResult !== "object" || Array.isArray(initResult)) {
      throw new TenantRemoteMcpError(
        "MCP_UPSTREAM_PROTOCOL_ERROR",
        "MCP server initialization failed"
      );
    }
    const init = initResult as Record<string, unknown>;
    const sessionId = initialized.response.headers.get("Mcp-Session-Id") ?? undefined;

    await postJsonRpc(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
    const listed = await postJsonRpc(
      endpoint,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId
    );
    const listResponse = parseRpcResponse(listed.body);
    const listResult = listResponse.result;
    return {
      serverId: server.id,
      serverName: server.name,
      transport: server.transport,
      protocolVersion: typeof init.protocolVersion === "string" ? init.protocolVersion : null,
      serverInfo: parseServerInfo(init.serverInfo),
      tools: parseTools(listResult, maxTools),
    };
  }

  async function discoverForTenant(
    principal: RemoteMcpPrincipal
  ): Promise<RegisteredRemoteMcpServer[]> {
    if (!principal || typeof principal.subject !== "string" || principal.subject.length === 0) {
      throw new TenantRemoteMcpError("UNAUTHENTICATED", "Authentication is required");
    }
    const tenantId = await options.authorization.resolveTenant(principal);
    if (!tenantId) throw new TenantRemoteMcpError("UNAUTHENTICATED", "Authentication is required");
    const rows = await options.registry.listByTenant(tenantId);
    const allowed: RegisteredRemoteMcpServer[] = [];
    for (const row of rows) {
      if (
        row.tenantId === tenantId &&
        row.isActive &&
        (await options.authorization.canAccessServer(principal, tenantId, row.id, "discover"))
      ) {
        allowed.push({ ...row, endpoint: parseSafeEndpoint(row.endpoint).toString() });
      }
    }
    return allowed;
  }

  async function invokeTool(
    principal: RemoteMcpPrincipal,
    serverId: string,
    _toolName: string,
    _arguments: Record<string, unknown>
  ): Promise<never> {
    await resolveAuthorizedServer(principal, serverId, "invoke");
    // Keep invocation disabled until encrypted credentials are integrated
    // with transport that pins DNS answers at connection time. A DNS preflight
    // followed by ordinary fetch does not prevent rebinding.
    throw new TenantRemoteMcpError(
      "MCP_INVOCATION_DISABLED",
      "Remote MCP invocation is disabled until credentials and target-runtime controlled egress are integrated"
    );
  }

  return { discoverForTenant, discoverTools, invokeTool };
}
