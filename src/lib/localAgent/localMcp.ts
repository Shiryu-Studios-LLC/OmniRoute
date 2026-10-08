import { createNodePinnedMcpTransport } from "../mcp/nodePinnedMcpTransport";
import type { McpOutboundTransport } from "../mcp/mcpOutboundTransport";

const MAX_SERVERS = 8;
const MAX_TOOLS_PER_SERVER = 8;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const SERVER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export interface LocalMcpServerConfig {
  id: string;
  endpoint: string;
}

export interface LocalMcpTool {
  name: string;
  inputSchema?: Record<string, unknown>;
}

export interface LocalMcpServerDiscovery {
  id: string;
  endpoint: string;
  tools: LocalMcpTool[];
}

export interface LocalMcpDependencies {
  transport?: McpOutboundTransport;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedJson(value: unknown, limit: number): string {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new Error("MCP payload must be JSON serializable");
  }
  if (typeof body !== "string" || new TextEncoder().encode(body).byteLength > limit) {
    throw new Error("MCP payload exceeds the size limit");
  }
  return body;
}

export function validateLocalMcpServers(value: unknown): LocalMcpServerConfig[] {
  if (!Array.isArray(value) || value.length > MAX_SERVERS) {
    throw new Error("Local MCP configuration must contain at most 8 servers");
  }
  const ids = new Set<string>();
  return value.map((entry) => {
    const server = record(entry);
    if (
      !server ||
      Object.keys(server).some((key) => key !== "id" && key !== "endpoint") ||
      typeof server.id !== "string" ||
      !SERVER_ID.test(server.id) ||
      ids.has(server.id) ||
      typeof server.endpoint !== "string"
    ) {
      throw new Error("Local MCP server configuration is invalid");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(server.endpoint);
    } catch {
      throw new Error("Local MCP endpoint must be a public HTTPS URL");
    }
    if (
      endpoint.protocol !== "https:" ||
      (endpoint.protocol === "https:" && endpoint.port && endpoint.port !== "443") ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.search
    ) {
      const localHost = ["127.0.0.1", "[::1]", "localhost"].includes(
        endpoint.hostname.toLowerCase()
      );
      if (
        !localHost ||
        (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.search
      ) {
        throw new Error(
          "Local MCP endpoint must be loopback HTTP(S) or public HTTPS without credentials"
        );
      }
    }
    ids.add(server.id);
    return { id: server.id, endpoint: endpoint.toString() };
  });
}

async function responseText(response: Response): Promise<string> {
  if (response.status === 202 || response.status === 204) return "";
  if (response.status < 200 || response.status >= 300) {
    throw new Error("MCP server request failed");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("text/event-stream"))
    throw new Error("MCP server response was not JSON");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MCP server returned an empty response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("MCP server response exceeds the size limit");
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

function parseRpc(text: string, expectedId: unknown): Record<string, unknown> {
  const isSse = /^\s*(?:data|event|id|retry):/m.test(text);
  const payloads = isSse
    ? text.split(/\r?\n\r?\n/).flatMap((event) => {
        const lines = event.split(/\r?\n/);
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""));
        return data.length ? [data.join("\n")] : [];
      })
    : [text];
  const responses: Record<string, unknown>[] = [];
  for (const payload of payloads) {
    try {
      const rpc = record(JSON.parse(payload));
      if (rpc?.jsonrpc === "2.0" && Object.hasOwn(rpc, "id") && rpc.id === expectedId) {
        responses.push(rpc);
      }
    } catch {
      // An SSE stream may contain non-JSON keepalive data. The matching JSON-RPC
      // response below is authoritative; malformed response-only bodies fail closed.
    }
  }
  const rpc = responses[0];
  if (!rpc || rpc.error || rpc.jsonrpc !== "2.0")
    throw new Error("MCP server returned an invalid response");
  return rpc;
}

async function post(
  endpoint: string,
  message: Record<string, unknown>,
  sessionId: string | undefined,
  protocolVersion: string | undefined,
  dependencies: LocalMcpDependencies,
  notification = false
): Promise<{ response: Response; rpc: Record<string, unknown> | null }> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const transport = dependencies.transport ?? createNodePinnedMcpTransport({ allowLoopback: true });
  const response = await transport.fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: boundedJson(message, MAX_REQUEST_BYTES),
  });
  if (response.status >= 300 && response.status < 400)
    throw new Error("MCP redirects are disabled");
  const text = await responseText(response);
  return {
    response,
    rpc: notification && !text ? null : parseRpc(text, message.id),
  };
}

async function initialize(
  endpoint: string,
  dependencies: LocalMcpDependencies
): Promise<{ sessionId?: string; protocolVersion: string }> {
  const initialized = await post(
    endpoint,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "OmniRoute Local Agent", version: "1" },
      },
    },
    undefined,
    undefined,
    dependencies
  );
  const result = record(initialized.rpc?.result);
  if (
    typeof result?.protocolVersion !== "string" ||
    !SUPPORTED_PROTOCOL_VERSIONS.has(result.protocolVersion)
  ) {
    throw new Error("MCP server negotiated an unsupported protocol version");
  }
  const sessionId = initialized.response.headers.get("mcp-session-id") ?? undefined;
  await post(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
    result.protocolVersion,
    dependencies,
    true
  );
  return { sessionId, protocolVersion: result.protocolVersion };
}

async function discoverServer(
  server: LocalMcpServerConfig,
  dependencies: LocalMcpDependencies
): Promise<LocalMcpServerDiscovery> {
  try {
    const session = await initialize(server.endpoint, dependencies);
    const listed = await post(
      server.endpoint,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      session.sessionId,
      session.protocolVersion,
      dependencies
    );
    const result = record(listed.rpc?.result);
    const rows = Array.isArray(result?.tools) ? result.tools.slice(0, MAX_TOOLS_PER_SERVER) : [];
    const tools = rows.flatMap((row): LocalMcpTool[] => {
      const tool = record(row);
      if (!tool || typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) return [];
      return [
        {
          name: tool.name,
          ...(record(tool.inputSchema) ? { inputSchema: record(tool.inputSchema)! } : {}),
        },
      ];
    });
    return { ...server, tools };
  } catch {
    return { ...server, tools: [] };
  }
}

export async function discoverLocalMcpServers(
  configurations: readonly LocalMcpServerConfig[],
  dependencies: LocalMcpDependencies = {}
): Promise<LocalMcpServerDiscovery[]> {
  const servers = validateLocalMcpServers(configurations);
  return Promise.all(servers.map((server) => discoverServer(server, dependencies)));
}

export async function invokeLocalMcpTool(
  server: LocalMcpServerDiscovery,
  toolName: string,
  args: unknown,
  dependencies: LocalMcpDependencies = {}
): Promise<unknown> {
  if (!server.tools.some((tool) => tool.name === toolName)) {
    throw new Error("MCP tool is unavailable");
  }
  const parsedArgs = record(args);
  if (!parsedArgs) throw new Error("MCP tool arguments must be an object");
  const session = await initialize(server.endpoint, dependencies);
  const called = await post(
    server.endpoint,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: toolName, arguments: parsedArgs },
    },
    session.sessionId,
    session.protocolVersion,
    dependencies
  );
  const result = called.rpc?.result;
  if (result === undefined) throw new Error("MCP tool returned no result");
  return JSON.parse(boundedJson(result, MAX_RESPONSE_BYTES)) as unknown;
}

export function localMcpCapability(serverId: string, toolName: string): string {
  if (!SERVER_ID.test(serverId) || !TOOL_NAME.test(toolName)) {
    throw new Error("MCP capability identity is invalid");
  }
  return `mcp:${serverId}:${toolName}`;
}

export function parseLocalMcpCapability(
  capability: string
): { serverId: string; toolName: string } | null {
  const match = /^mcp:([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_.-]{1,64})$/.exec(capability);
  return match ? { serverId: match[1], toolName: match[2] } : null;
}
