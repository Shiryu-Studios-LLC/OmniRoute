import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LocalAgentHeartbeatPayload } from "./protocol";
import {
  discoverLocalMcpServers,
  localMcpCapability,
  type LocalMcpDependencies,
  type LocalMcpServerConfig,
  type LocalMcpServerDiscovery,
} from "./localMcp";

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_BINARY_RESPONSE_BYTES = 40 * 1024;
const MAX_OLLAMA_MODELS = 32;
const MAX_HEARTBEAT_CAPABILITY_LENGTH = 80;
const REQUEST_TIMEOUT_MS = 4_000;
const DEFAULT_LOCAL_ENDPOINTS = {
  ollama: "http://127.0.0.1:11434",
  comfyui: "http://127.0.0.1:8188",
} as const;

export interface LocalDiscoveryConfig {
  ollamaUrl?: string;
  comfyUiUrl?: string;
  mcpServers?: LocalMcpServerConfig[];
}

export interface LocalDiscoveryDependencies {
  fetch: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  mcp?: LocalMcpDependencies;
}

export interface LocalDiscoveryResult {
  heartbeat: LocalAgentHeartbeatPayload;
  services: Array<{
    service: "ollama" | "comfyui";
    reachable: boolean;
    models: string[];
  }>;
  mcpServers?: LocalMcpServerDiscovery[];
}

const defaultResolveHost = async (hostname: string): Promise<string[]> => {
  if (isIP(hostname)) return [hostname];
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
};

function isPrivateOrLoopback(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version !== 6) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
}

async function validateLocalEndpoint(
  rawUrl: string,
  resolveHost: (hostname: string) => Promise<string[]>
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Local service URL is invalid");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Local service URL must be plain HTTP without credentials or query data");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname !== "localhost" && isIP(hostname) === 0) {
    throw new Error("Local service URL host must be localhost or a private IP literal");
  }
  const addresses = await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPrivateOrLoopback(address))) {
    throw new Error("Local service URL must resolve only to a private or loopback address");
  }
  return url;
}

async function requestJson(fetcher: typeof fetch, url: URL, init?: RequestInit): Promise<unknown> {
  return requestJsonWithTimeout(fetcher, url, init, REQUEST_TIMEOUT_MS);
}

async function requestJsonWithTimeout(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Local service returned HTTP ${response.status}`);
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_RESPONSE_BYTES) {
    throw new Error("Local service response exceeds the size limit");
  }
  if (!response.body) throw new Error("Local service returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Local service response exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Local service returned invalid JSON");
  }
}

/** Make one bounded JSON request to a configured local AI service. */
export async function requestLocalServiceJson(
  rawUrl: string,
  path: string,
  fetcher: typeof fetch,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolveHost,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<unknown> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new Error("Local service path is invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Local service timeout must be between 1 and 30000 milliseconds");
  }
  const base = await validateLocalEndpoint(rawUrl, resolveHost);
  return requestJsonWithTimeout(fetcher, appendPath(base, path), init, timeoutMs);
}

/** Open a streamed response from a configured local service after the same SSRF checks. */
export async function requestLocalServiceStream(
  rawUrl: string,
  path: string,
  fetcher: typeof fetch,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolveHost,
  init?: RequestInit
): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new Error("Local service path is invalid");
  }
  const base = await validateLocalEndpoint(rawUrl, resolveHost);
  const response = await fetcher(appendPath(base, path), {
    ...init,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Local service returned HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Local service returned an empty response");
  return response;
}

/** Fetch a small binary result from a configured local service with a hard byte cap. */
export async function requestLocalServiceBytes(
  rawUrl: string,
  path: string,
  query: Record<string, string>,
  fetcher: typeof fetch,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolveHost
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new Error("Local service path is invalid");
  }
  const base = await validateLocalEndpoint(rawUrl, resolveHost);
  const url = appendPath(base, path);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetcher(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: "image/png,image/jpeg,image/webp" },
  });
  if (!response.ok) throw new Error(`Local service returned HTTP ${response.status}`);
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_BINARY_RESPONSE_BYTES) {
    throw new Error("Local service binary response exceeds the size limit");
  }
  if (!response.body) throw new Error("Local service returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BINARY_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Local service binary response exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    contentType: (response.headers.get("content-type") ?? "").split(";")[0].toLowerCase(),
  };
}

function appendPath(base: URL, path: string): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  return url;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function discoverOllama(
  rawUrl: string,
  deps: LocalDiscoveryDependencies,
  resolveHost: (hostname: string) => Promise<string[]>
): Promise<{ models: string[]; capabilities: string[] }> {
  const base = await validateLocalEndpoint(rawUrl, resolveHost);
  const tags = parseObject(await requestJson(deps.fetch, appendPath(base, "/api/tags")));
  const modelRows = Array.isArray(tags?.models) ? tags.models.slice(0, MAX_OLLAMA_MODELS) : [];
  const models = modelRows.flatMap((row) => {
    const name = parseObject(row)?.name;
    return typeof name === "string" && name.length > 0 && name.length <= 128 ? [name] : [];
  });
  const capabilities = models.map((name) => `ollama:model:${name}`);

  for (const name of models) {
    try {
      const shown = parseObject(
        await requestJson(deps.fetch, appendPath(base, "/api/show"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        })
      );
      const modelCapabilities = shown?.capabilities;
      if (!Array.isArray(modelCapabilities)) continue;
      for (const capability of modelCapabilities) {
        if (capability === "completion") capabilities.push(`ollama:chat:${name}`);
      }
    } catch {
      // /api/show is optional metadata; installed model IDs remain useful on older Ollama versions.
    }
  }
  return { models, capabilities };
}

function comfyModelNames(info: Record<string, unknown>): string[] {
  const node = parseObject(info.CheckpointLoaderSimple);
  const input = parseObject(parseObject(node?.input)?.required);
  const ckpt = input?.ckpt_name;
  if (!Array.isArray(ckpt) || !Array.isArray(ckpt[0])) return [];
  return ckpt[0].filter((name): name is string => typeof name === "string").slice(0, 128);
}

async function discoverComfyUi(
  rawUrl: string,
  deps: LocalDiscoveryDependencies,
  resolveHost: (hostname: string) => Promise<string[]>
): Promise<{ models: string[]; capabilities: string[] }> {
  const [checkpointInfo, samplerInfo, saveImageInfo] = await Promise.all(
    ["CheckpointLoaderSimple", "KSampler", "SaveImage"].map(async (nodeType) =>
      parseObject(
        await requestLocalServiceJson(rawUrl, `/object_info/${nodeType}`, deps.fetch, resolveHost)
      )
    )
  );
  const models = comfyModelNames(checkpointInfo ?? {}).map((name) => `comfyui:checkpoint:${name}`);
  const capabilities: string[] = [];
  if (
    parseObject(checkpointInfo?.CheckpointLoaderSimple) &&
    parseObject(samplerInfo?.KSampler) &&
    parseObject(saveImageInfo?.SaveImage) &&
    models.length > 0
  ) {
    capabilities.push("comfyui:image");
  }
  return { models, capabilities };
}

/**
 * Read local Ollama and ComfyUI inventory for a future outbound agent heartbeat.
 * Only localhost and private IP literals are accepted, avoiding DNS-rebinding
 * races and preventing configured endpoints from targeting arbitrary cloud hosts.
 */
export async function discoverLocalCapabilities(
  config: LocalDiscoveryConfig,
  dependencies: LocalDiscoveryDependencies
): Promise<LocalDiscoveryResult> {
  const resolveHost = dependencies.resolveHost ?? defaultResolveHost;
  const capabilities: string[] = [];
  const services: LocalDiscoveryResult["services"] = [];

  for (const [service, endpoint] of [
    ["ollama", config.ollamaUrl ?? DEFAULT_LOCAL_ENDPOINTS.ollama],
    ["comfyui", config.comfyUiUrl ?? DEFAULT_LOCAL_ENDPOINTS.comfyui],
  ] as const) {
    try {
      const result =
        service === "ollama"
          ? await discoverOllama(endpoint, dependencies, resolveHost)
          : await discoverComfyUi(endpoint, dependencies, resolveHost);
      services.push({ service, reachable: true, models: result.models });
      capabilities.push(...result.capabilities);
    } catch {
      services.push({ service, reachable: false, models: [] });
    }
  }

  let mcpServers: LocalMcpServerDiscovery[] = [];
  if (config.mcpServers?.length) {
    mcpServers = await discoverLocalMcpServers(config.mcpServers, dependencies.mcp);
    for (const server of mcpServers) {
      for (const tool of server.tools) {
        try {
          capabilities.push(localMcpCapability(server.id, tool.name));
        } catch {
          // Malformed tool names are never advertised.
        }
      }
    }
  }

  return {
    heartbeat: {
      status: "online",
      // Keep discovery aligned with the heartbeat API/database schema. A
      // single oversized local model or MCP tool name must not invalidate the
      // complete heartbeat and prevent the device from reconnecting.
      capabilities: [...new Set(capabilities)]
        .filter((capability) => capability.length <= MAX_HEARTBEAT_CAPABILITY_LENGTH)
        .slice(0, 64),
      serviceHealth: {
        ollama: services.find((service) => service.service === "ollama")?.reachable ?? false,
        comfyui: services.find((service) => service.service === "comfyui")?.reachable ?? false,
      },
    },
    services,
    ...(mcpServers.length ? { mcpServers } : {}),
  };
}
