import {
  requestLocalServiceBytes,
  requestLocalServiceJson,
  requestLocalServiceStream,
  type LocalDiscoveryConfig,
  type LocalDiscoveryResult,
} from "./localDiscovery";
import {
  invokeLocalMcpTool,
  parseLocalMcpCapability,
  type LocalMcpDependencies,
  validateLocalMcpServers,
} from "./localMcp";
import type { LocalAgentGatewayStreamEvent } from "./gatewayProtocol";
import {
  CLOUD_IMAGE_CAPABILITY,
  CLOUD_IMAGE_MAX_ARTIFACT_BYTES,
  parseCloudImageJobParameters,
  type CloudImageJobParameters,
} from "../../shared/imageJobContract";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_GATEWAY_RESULT_BYTES = 56 * 1024;
const MAX_STREAM_OUTPUT_BYTES = 128 * 1024;
const MAX_STREAM_LINE_BYTES = 64 * 1024;
const STREAM_DELTA_BYTES = 4 * 1024;
const OLLAMA_CHAT_TIMEOUT_MS = 25_000;
const COMFYUI_POLL_TIMEOUT_MS = 270_000;
const COMFYUI_POLL_INTERVAL_MS = 400;
const COMFYUI_CONTROL_POLL_INTERVAL_MS = 2_000;
const TRUNCATION_MARKER = "\n[local agent result truncated]";

export interface LocalCapabilityRequest {
  capability: string;
  payload: unknown;
}

export interface LocalCapabilityExecutorDependencies {
  fetch: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  mcp?: LocalMcpDependencies;
  signal?: AbortSignal;
}

export interface LocalCapabilityStreamDependencies extends LocalCapabilityExecutorDependencies {
  signal: AbortSignal;
  emit: (
    event: Extract<LocalAgentGatewayStreamEvent, { type: "delta" | "usage" }>
  ) => Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedJson(value: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new Error("Local capability payload must be JSON serializable");
  }
  if (typeof body !== "string" || new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new Error("Local capability payload exceeds the size limit");
  }
  return body;
}

function validateOllamaChatPayload(payload: unknown): Record<string, unknown> {
  const body = record(payload);
  if (
    !body ||
    Object.keys(body).some(
      (key) => !["messages", "options", "format", "think", "tools", "keep_alive"].includes(key)
    )
  ) {
    throw new Error("Ollama chat payload contains unsupported fields");
  }
  if (
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > 128 ||
    body.messages.some((entry) => {
      const message = record(entry);
      return (
        !message ||
        Object.keys(message).some(
          (key) => !["role", "content", "images", "tool_calls"].includes(key)
        ) ||
        typeof message.role !== "string" ||
        !["system", "user", "assistant", "tool"].includes(message.role) ||
        (typeof message.content !== "string" && !Array.isArray(message.content))
      );
    })
  ) {
    throw new Error("Ollama chat payload has invalid messages");
  }
  for (const key of ["options", "format"]) {
    if (body[key] !== undefined && typeof body[key] !== "string" && !record(body[key])) {
      throw new Error(`Ollama chat ${key} must be an object or string`);
    }
  }
  if (body.think !== undefined && typeof body.think !== "boolean") {
    throw new Error("Ollama chat think must be a boolean");
  }
  if (
    body.keep_alive !== undefined &&
    typeof body.keep_alive !== "string" &&
    typeof body.keep_alive !== "number"
  ) {
    throw new Error("Ollama chat keep_alive must be a string or number");
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error("Ollama chat tools must be an array");
  }
  return body;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const suffixBytes = new TextEncoder().encode(TRUNCATION_MARKER).byteLength;
  const budget = Math.max(0, maxBytes - suffixBytes);
  let output = "";
  let used = 0;
  for (const character of value) {
    const size = new TextEncoder().encode(character).byteLength;
    if (used + size > budget) break;
    output += character;
    used += size;
  }
  return `${output}${TRUNCATION_MARKER}`;
}

function projectOllamaChatResponse(value: Record<string, unknown>): Record<string, unknown> {
  const sourceMessage = record(value.message);
  if (!sourceMessage || typeof sourceMessage.role !== "string") {
    throw new Error("Ollama returned an invalid chat response");
  }
  const message: Record<string, unknown> = { role: sourceMessage.role.slice(0, 32) };
  if (typeof sourceMessage.content === "string") message.content = sourceMessage.content;
  if (typeof sourceMessage.thinking === "string") message.thinking = sourceMessage.thinking;
  if (Array.isArray(sourceMessage.tool_calls)) message.tool_calls = sourceMessage.tool_calls;

  const result: Record<string, unknown> = { message };
  if (typeof value.model === "string") result.model = value.model.slice(0, 128);
  if (typeof value.created_at === "string") result.created_at = value.created_at.slice(0, 64);
  if (typeof value.done === "boolean") result.done = value.done;
  if (typeof value.done_reason === "string") result.done_reason = value.done_reason.slice(0, 64);
  for (const key of [
    "total_duration",
    "load_duration",
    "prompt_eval_count",
    "prompt_eval_duration",
    "eval_count",
    "eval_duration",
  ]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
  }

  if (new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_GATEWAY_RESULT_BYTES) {
    return result;
  }

  const originalContent = typeof sourceMessage.content === "string" ? sourceMessage.content : "";
  const fallback: Record<string, unknown> = {
    ...result,
    message: { role: message.role, content: "" },
    truncated: true,
  };
  const fallbackMessage = fallback.message as Record<string, unknown>;
  for (let contentBudget = MAX_GATEWAY_RESULT_BYTES; contentBudget >= 0; contentBudget -= 512) {
    fallbackMessage.content = truncateUtf8(originalContent, contentBudget);
    if (new TextEncoder().encode(JSON.stringify(fallback)).byteLength <= MAX_GATEWAY_RESULT_BYTES) {
      return fallback;
    }
  }
  fallbackMessage.content = TRUNCATION_MARKER;
  return fallback;
}

function comfyUiOutputFiles(history: Record<string, unknown>, promptId: string) {
  const entry = record(history[promptId]);
  const outputs = record(entry?.outputs);
  if (!outputs) return null;
  const images: Array<{ filename: string; subfolder: string; type: string }> = [];
  for (const nodeOutput of Object.values(outputs)) {
    const rows = record(nodeOutput)?.images;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const image = record(row);
      if (
        !image ||
        typeof image.filename !== "string" ||
        image.filename.length > 255 ||
        !/^[A-Za-z0-9][A-Za-z0-9_. -]*$/.test(image.filename) ||
        typeof image.subfolder !== "string" ||
        image.subfolder.length > 512 ||
        (image.subfolder !== "" &&
          image.subfolder
            .split("/")
            .some((part) => !/^[A-Za-z0-9_. -]+$/.test(part) || part === "." || part === "..")) ||
        image.type !== "output"
      ) {
        continue;
      }
      images.push({ filename: image.filename, subfolder: image.subfolder, type: image.type });
      if (images.length >= 1) return images;
    }
  }
  return images.length > 0 ? images : null;
}

async function fetchComfyUiImage(
  baseUrl: string,
  image: { filename: string; subfolder: string; type: string },
  dependencies: LocalCapabilityExecutorDependencies
) {
  const result = await requestLocalServiceBytes(
    baseUrl,
    "/view",
    { filename: image.filename, subfolder: image.subfolder, type: image.type },
    dependencies.fetch,
    dependencies.resolveHost,
    dependencies.signal,
    CLOUD_IMAGE_MAX_ARTIFACT_BYTES,
    120_000
  );
  const allowedTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  const extension = image.filename.slice(image.filename.lastIndexOf(".")).toLowerCase();
  const contentType = allowedTypes[extension];
  if (
    !contentType ||
    result.contentType !== contentType ||
    result.bytes.byteLength === 0 ||
    result.bytes.byteLength > CLOUD_IMAGE_MAX_ARTIFACT_BYTES ||
    !hasImageMagic(result.bytes, contentType)
  ) {
    throw new Error("ComfyUI returned an unsupported image output");
  }
  return {
    contentType,
    bytes: result.bytes,
  };
}

function hasImageMagic(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/png") {
    return (
      bytes.byteLength >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (contentType === "image/jpeg") {
    return bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/webp") {
    return (
      bytes.byteLength >= 12 &&
      String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
    );
  }
  return false;
}

export function buildComfyUiImageWorkflow(
  parameters: CloudImageJobParameters,
  discovery: LocalDiscoveryResult
): Record<string, unknown> {
  const validated = parseCloudImageJobParameters(parameters);
  if (!validated) throw new Error("ComfyUI image request parameters are invalid");
  const comfy = discovery.services.find((service) => service.service === "comfyui");
  if (!comfy?.reachable || !discovery.heartbeat.capabilities.includes(CLOUD_IMAGE_CAPABILITY)) {
    throw new Error("ComfyUI image capability is unavailable");
  }
  const discoveredCheckpoints = comfy.models.flatMap((model) =>
    model.startsWith("comfyui:checkpoint:") ? [model.slice("comfyui:checkpoint:".length)] : []
  );
  const checkpoint = validated.checkpoint ?? discoveredCheckpoints[0];
  if (!checkpoint || !discoveredCheckpoints.includes(checkpoint)) {
    throw new Error("ComfyUI checkpoint is unavailable");
  }
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: validated.prompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: validated.negativePrompt ?? "", clip: ["1", 1] },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: validated.width, height: validated.height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        seed: validated.seed,
        steps: validated.steps,
        cfg: validated.cfg,
        sampler_name: "euler",
        scheduler: "normal",
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
        denoise: 1,
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": {
      class_type: "SaveImage",
      inputs: { images: ["6", 0], filename_prefix: "omniroute-local" },
    },
  };
}

export type LocalImageJobControl = () => Promise<"running" | "cancelled" | "expired" | null>;

export class LocalImageJobStoppedError extends Error {
  constructor(readonly status: "cancelled" | "expired") {
    super(`ComfyUI image job ${status}`);
  }
}

export interface LocalComfyUiImageArtifact {
  promptId: string;
  contentType: string;
  bytes: Uint8Array;
}

export async function executeLocalComfyUiImageJob(
  config: LocalDiscoveryConfig,
  discovery: LocalDiscoveryResult,
  payload: unknown,
  dependencies: LocalCapabilityExecutorDependencies,
  checkControl: LocalImageJobControl
): Promise<LocalComfyUiImageArtifact> {
  const parameters = parseCloudImageJobParameters(payload);
  if (!parameters) throw new Error("ComfyUI image request is invalid");
  if (!config.comfyUiUrl) throw new Error("ComfyUI image capability is unavailable");
  const workflow = buildComfyUiImageWorkflow(parameters, discovery);
  let lastControlCheckAt = Number.NEGATIVE_INFINITY;
  const requireRunning = async (force = false) => {
    if (dependencies.signal?.aborted) throw new LocalImageJobStoppedError("expired");
    const now = Date.now();
    if (!force && now - lastControlCheckAt < COMFYUI_CONTROL_POLL_INTERVAL_MS) return;
    lastControlCheckAt = now;
    const state = await checkControl();
    if (state !== "running") {
      throw new LocalImageJobStoppedError(state === "cancelled" ? "cancelled" : "expired");
    }
  };
  await requireRunning(true);
  const submitted = record(
    await requestLocalServiceJson(
      config.comfyUiUrl,
      "/prompt",
      dependencies.fetch,
      dependencies.resolveHost,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow }),
        signal: dependencies.signal,
      }
    )
  );
  const promptId = submitted?.prompt_id;
  if (typeof promptId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(promptId)) {
    throw new Error("ComfyUI returned an invalid prompt identifier");
  }
  await requireRunning(true);

  const deadline = Date.now() + COMFYUI_POLL_TIMEOUT_MS;
  let outputFiles: ReturnType<typeof comfyUiOutputFiles> = null;
  while (Date.now() < deadline) {
    await requireRunning();
    const history = record(
      await requestLocalServiceJson(
        config.comfyUiUrl,
        `/history/${promptId}`,
        dependencies.fetch,
        dependencies.resolveHost,
        { signal: dependencies.signal }
      )
    );
    const historyEntry = history ? record(history[promptId]) : null;
    outputFiles = history ? comfyUiOutputFiles(history, promptId) : null;
    if (outputFiles?.length) {
      break;
    }
    const status = record(historyEntry?.status);
    if (status?.status_str === "error") {
      throw new Error("ComfyUI workflow execution failed");
    }
    if (status?.completed === true) {
      throw new Error("ComfyUI completed without safe image output metadata");
    }
    await requireRunning();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, COMFYUI_POLL_INTERVAL_MS);
      function done() {
        dependencies.signal?.removeEventListener("abort", cancel);
        resolve();
      }
      function cancel() {
        clearTimeout(timer);
        reject(new Error("ComfyUI workflow was canceled"));
      }
      dependencies.signal?.addEventListener("abort", cancel, { once: true });
      if (dependencies.signal?.aborted) cancel();
    });
  }
  if (!outputFiles?.length) throw new Error("ComfyUI prompt did not produce an image in time");

  await requireRunning(true);
  const image = await fetchComfyUiImage(config.comfyUiUrl, outputFiles[0], dependencies);
  await requireRunning(true);
  return { promptId, ...image };
}

/**
 * Dispatch only capabilities actually advertised by this agent's latest local
 * discovery. Requests are mapped to fixed service paths; callers cannot choose
 * a URL, model, or ComfyUI endpoint in the payload.
 */
export async function executeLocalCapability(
  config: LocalDiscoveryConfig,
  discovery: LocalDiscoveryResult,
  request: LocalCapabilityRequest,
  dependencies: LocalCapabilityExecutorDependencies
): Promise<unknown> {
  const serializedPayload = boundedJson(request.payload);
  if (!discovery.heartbeat.capabilities.includes(request.capability)) {
    throw new Error("Local capability is unavailable");
  }

  const chatPrefix = "ollama:chat:";
  if (request.capability.startsWith(chatPrefix)) {
    const model = request.capability.slice(chatPrefix.length);
    if (!model || model.length > 128 || !config.ollamaUrl) {
      throw new Error("Ollama chat capability is unavailable");
    }
    const payload = validateOllamaChatPayload(JSON.parse(serializedPayload) as unknown);
    const response = await requestLocalServiceJson(
      config.ollamaUrl,
      "/api/chat",
      dependencies.fetch,
      dependencies.resolveHost,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, model, stream: false }),
        signal: dependencies.signal,
      },
      OLLAMA_CHAT_TIMEOUT_MS
    );
    const chatResponse = record(response);
    if (!chatResponse) throw new Error("Ollama returned an invalid chat response");
    return projectOllamaChatResponse(chatResponse);
  }

  if (request.capability === "comfyui:image") {
    throw new Error("ComfyUI image jobs require the artifact upload protocol");
  }

  const mcpCapability = parseLocalMcpCapability(request.capability);
  if (mcpCapability) {
    const configured = validateLocalMcpServers(config.mcpServers ?? []).find(
      (server) => server.id === mcpCapability.serverId
    );
    const discovered = discovery.mcpServers?.find(
      (server) => server.id === mcpCapability.serverId && server.endpoint === configured?.endpoint
    );
    if (!configured || !discovered) throw new Error("Local MCP server is unavailable");
    return invokeLocalMcpTool(
      discovered,
      mcpCapability.toolName,
      request.payload,
      dependencies.mcp
    );
  }

  throw new Error("Local capability is unsupported");
}

/** Stream only advertised Ollama chat capabilities through bounded normalized events. */
export async function executeLocalCapabilityStream(
  config: LocalDiscoveryConfig,
  discovery: LocalDiscoveryResult,
  request: LocalCapabilityRequest,
  dependencies: LocalCapabilityStreamDependencies
): Promise<void> {
  const serializedPayload = boundedJson(request.payload);
  const chatPrefix = "ollama:chat:";
  if (!request.capability.startsWith(chatPrefix)) {
    throw new Error("Streaming is supported only for local Ollama chat capabilities");
  }
  if (!discovery.heartbeat.capabilities.includes(request.capability)) {
    throw new Error("Local capability is unavailable");
  }
  const model = request.capability.slice(chatPrefix.length);
  if (!model || model.length > 128 || !config.ollamaUrl) {
    throw new Error("Ollama chat capability is unavailable");
  }
  const payload = validateOllamaChatPayload(JSON.parse(serializedPayload) as unknown);
  if (payload.tools !== undefined) {
    throw new Error("Streaming Ollama tool calls are not supported");
  }
  const response = await requestLocalServiceStream(
    config.ollamaUrl,
    "/api/chat",
    dependencies.fetch,
    dependencies.resolveHost,
    {
      method: "POST",
      signal: dependencies.signal,
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ ...payload, model, stream: true }),
    }
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let outputBytes = 0;
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  let terminalSeen = false;

  const consumeLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (new TextEncoder().encode(trimmed).byteLength > MAX_STREAM_LINE_BYTES) {
      throw new Error("Ollama stream line exceeds the size limit");
    }
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      throw new Error("Ollama returned an invalid chat stream");
    }
    const row = record(value);
    if (!row) throw new Error("Ollama returned an invalid chat stream");
    if (row.error !== undefined) throw new Error("Ollama chat stream failed");
    const message = record(row.message);
    if (message?.tool_calls !== undefined) {
      throw new Error("Streaming Ollama tool calls are not supported");
    }
    if (typeof message?.content === "string" && message.content.length > 0) {
      const bytes = new TextEncoder().encode(message.content);
      outputBytes += bytes.byteLength;
      if (outputBytes > MAX_STREAM_OUTPUT_BYTES) {
        throw new Error("Ollama stream output exceeds the size limit");
      }
      let part = "";
      let partBytes = 0;
      for (const character of message.content) {
        const characterBytes = new TextEncoder().encode(character).byteLength;
        if (partBytes + characterBytes > STREAM_DELTA_BYTES && part) {
          await dependencies.emit({ type: "delta", data: { content: part } });
          part = "";
          partBytes = 0;
        }
        part += character;
        partBytes += characterBytes;
      }
      if (part) await dependencies.emit({ type: "delta", data: { content: part } });
    }
    if (row.done === true) {
      terminalSeen = true;
      const promptTokens = row.prompt_eval_count;
      const completionTokens = row.eval_count;
      if (
        typeof promptTokens === "number" &&
        Number.isSafeInteger(promptTokens) &&
        promptTokens >= 0 &&
        typeof completionTokens === "number" &&
        Number.isSafeInteger(completionTokens) &&
        completionTokens >= 0
      ) {
        usage = { promptTokens, completionTokens };
      }
    }
  };

  try {
    while (true) {
      if (dependencies.signal.aborted) throw new Error("Ollama stream was canceled");
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (new TextEncoder().encode(pending).byteLength > MAX_STREAM_LINE_BYTES * 2) {
        throw new Error("Ollama stream buffer exceeds the size limit");
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        await consumeLine(line);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending.trim()) await consumeLine(pending);
    if (!terminalSeen) throw new Error("Ollama stream ended before completion");
    if (usage) await dependencies.emit({ type: "usage", data: usage });
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
