import { randomBytes } from "node:crypto";
import {
  discoverLocalCapabilities,
  type LocalDiscoveryConfig,
  type LocalDiscoveryResult,
} from "./localDiscovery";
import { LOCAL_AGENT_HEARTBEAT_PATH, signLocalAgentHeartbeat } from "./protocol";
import { executeLocalCapability } from "./capabilityExecutor";
import {
  LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
  type LocalAgentGatewayRequest,
  type LocalAgentGatewayResult,
  type LocalAgentGatewaySession,
  type LocalAgentGatewayTransport,
} from "./gatewayProtocol";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_GATEWAY_RESULT_BYTES = 64 * 1024;

export interface LocalAgentRunnerConfig extends LocalDiscoveryConfig {
  gatewayUrl: string;
  deviceId: string;
  credential: string;
  heartbeatIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  requestTimeoutMs?: number;
}

export interface LocalAgentRunnerDependencies {
  fetch: typeof fetch;
  now?: () => number;
  createNonce?: () => string;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  discover?: typeof discoverLocalCapabilities;
}

export interface LocalAgentGatewayRunnerDependencies extends LocalAgentRunnerDependencies {
  gateway: LocalAgentGatewayTransport;
  execute?: (
    request: LocalAgentGatewayRequest,
    discovery: LocalDiscoveryResult
  ) => Promise<unknown>;
}

export interface LocalAgentGatewayCycleResult {
  session: LocalAgentGatewaySession;
  processed: number;
}

export interface LocalAgentRunnerCycleResult {
  accepted: boolean;
  retryAfterMs?: number;
}

function validateConfig(config: LocalAgentRunnerConfig): URL {
  if (!config.deviceId || config.deviceId.length > 128)
    throw new Error("Invalid local agent device ID");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(config.credential)) {
    throw new Error("Invalid local agent credential");
  }
  let url: URL;
  try {
    url = new URL(config.gatewayUrl);
  } catch {
    throw new Error("Invalid local agent gateway URL");
  }
  const localHost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Local agent gateway must use HTTPS without credentials or query data");
  }
  return url;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Discover configured local services and send one signed, outbound heartbeat. */
export async function runLocalAgentCycle(
  config: LocalAgentRunnerConfig,
  dependencies: LocalAgentRunnerDependencies
): Promise<LocalAgentRunnerCycleResult> {
  const gateway = validateConfig(config);
  const discover = dependencies.discover ?? discoverLocalCapabilities;
  const discovered = await discover(
    { ollamaUrl: config.ollamaUrl, comfyUiUrl: config.comfyUiUrl },
    { fetch: dependencies.fetch }
  );
  await sendHeartbeat(config, gateway, dependencies, discovered);
  return { accepted: true };
}

async function sendHeartbeat(
  config: LocalAgentRunnerConfig,
  gateway: URL,
  dependencies: LocalAgentRunnerDependencies,
  discovered: LocalDiscoveryResult
): Promise<void> {
  const timestamp = (dependencies.now ?? Date.now)();
  const nonce = (dependencies.createNonce ?? (() => randomBytes(18).toString("base64url")))();
  const signature = signLocalAgentHeartbeat(
    config.credential,
    timestamp,
    nonce,
    discovered.heartbeat
  );
  const endpoint = new URL(LOCAL_AGENT_HEARTBEAT_PATH, gateway);
  const response = await dependencies.fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      deviceId: config.deviceId,
      credential: config.credential,
      timestamp,
      nonce,
      signature,
      payload: discovered.heartbeat,
    }),
  });
  if (!response.ok) throw new Error(`Local agent heartbeat returned HTTP ${response.status}`);
}

/**
 * Send discovery state, maintain an authenticated gateway lease, execute one
 * bounded poll batch, and return the session for the next cycle. Its transport
 * can use the versioned Worker HTTP adapter or an in-process test adapter.
 */
export async function runLocalAgentGatewayCycle(
  config: LocalAgentRunnerConfig,
  dependencies: LocalAgentGatewayRunnerDependencies,
  previousSession?: LocalAgentGatewaySession
): Promise<LocalAgentGatewayCycleResult> {
  validateConfig(config);
  const discover = dependencies.discover ?? discoverLocalCapabilities;
  const discovery = await discover(
    { ollamaUrl: config.ollamaUrl, comfyUiUrl: config.comfyUiUrl },
    { fetch: dependencies.fetch }
  );

  let session = previousSession;
  if (
    session &&
    !(await dependencies.gateway.heartbeat(session, discovery.heartbeat.capabilities))
  ) {
    session = undefined;
  }
  if (!session) {
    session = (await dependencies.gateway.connect(config.deviceId, config.credential)) ?? undefined;
    if (
      session &&
      !(await dependencies.gateway.heartbeat(session, discovery.heartbeat.capabilities))
    ) {
      session = undefined;
    }
  }
  if (!session) throw new Error("Local agent gateway connection was rejected");

  const requests = await dependencies.gateway.poll(session);
  if (requests === null) throw new Error("Local agent gateway session is unavailable");
  let processed = 0;
  for (const gatewayRequest of requests) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(gatewayRequest.requestId) ||
      typeof gatewayRequest.capability !== "string" ||
      gatewayRequest.capability.length > 128 ||
      !Number.isFinite(Date.parse(gatewayRequest.expiresAt))
    ) {
      continue;
    }
    const request: LocalAgentGatewayRequest = {
      ...gatewayRequest,
      version: LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
    };
    if (Date.parse(request.expiresAt) <= (dependencies.now ?? Date.now)()) continue;

    let outcome: LocalAgentGatewayResult["outcome"];
    try {
      const value = dependencies.execute
        ? await dependencies.execute(request, discovery)
        : await executeLocalCapability(
            { ollamaUrl: config.ollamaUrl, comfyUiUrl: config.comfyUiUrl },
            discovery,
            request,
            { fetch: dependencies.fetch }
          );
      outcome = { ok: true, value };
    } catch {
      outcome = { ok: false, error: { code: "capability_execution_failed" } };
    }
    const result: LocalAgentGatewayResult = {
      version: LOCAL_AGENT_GATEWAY_PROTOCOL_VERSION,
      requestId: request.requestId,
      outcome,
    };
    let resultFits = false;
    try {
      resultFits =
        new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_GATEWAY_RESULT_BYTES;
    } catch {
      resultFits = false;
    }
    if (!resultFits) {
      result.outcome = {
        ok: false,
        error: { code: "capability_execution_failed" },
      };
    }
    if (!(await dependencies.gateway.submitResult(session, result))) {
      throw new Error("Local agent gateway rejected a request result");
    }
    processed += 1;
  }
  return { session, processed };
}

/**
 * Keep an agent connected with capped exponential retries. This process only
 * makes outbound HTTPS heartbeat requests; it never opens a listener or port.
 */
export async function runLocalAgent(
  config: LocalAgentRunnerConfig,
  dependencies: LocalAgentRunnerDependencies,
  signal: AbortSignal
): Promise<void> {
  const sleep = dependencies.sleep ?? defaultSleep;
  const interval = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const retryBase = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMax = config.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  if (interval < 1 || retryBase < 1 || retryMax < retryBase) {
    throw new Error("Invalid local agent retry or heartbeat interval");
  }
  let failureCount = 0;
  while (!signal.aborted) {
    try {
      await runLocalAgentCycle(config, dependencies);
      failureCount = 0;
      await sleep(interval, signal);
    } catch {
      if (signal.aborted) break;
      const delay = Math.min(retryMax, retryBase * 2 ** Math.min(failureCount, 30));
      failureCount += 1;
      await sleep(delay, signal);
    }
  }
}

/** Keep discovery, gateway polling, request execution, and result submission active. */
export async function runLocalAgentWithGateway(
  config: LocalAgentRunnerConfig,
  dependencies: LocalAgentGatewayRunnerDependencies,
  signal: AbortSignal
): Promise<void> {
  const sleep = dependencies.sleep ?? defaultSleep;
  const interval = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const retryBase = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMax = config.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  if (interval < 1 || retryBase < 1 || retryMax < retryBase) {
    throw new Error("Invalid local agent retry or heartbeat interval");
  }
  let failureCount = 0;
  let session: LocalAgentGatewaySession | undefined;
  while (!signal.aborted) {
    try {
      const cycle = await runLocalAgentGatewayCycle(config, dependencies, session);
      session = cycle.session;
      failureCount = 0;
      await sleep(interval, signal);
    } catch {
      if (signal.aborted) break;
      session = undefined;
      const delay = Math.min(retryMax, retryBase * 2 ** Math.min(failureCount, 30));
      failureCount += 1;
      await sleep(delay, signal);
    }
  }
}
