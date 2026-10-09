import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  getLocalAgentSystemdStatus,
  installLocalAgentSystemd,
  startLocalAgentSystemd,
  stopLocalAgentSystemd,
  uninstallLocalAgentSystemd,
} from "../localAgentSystemd.mjs";
import {
  getLocalAgentLaunchdStatus,
  installLocalAgentLaunchd,
  startLocalAgentLaunchd,
  stopLocalAgentLaunchd,
  uninstallLocalAgentLaunchd,
} from "../localAgentLaunchd.mjs";
import {
  getLocalAgentWindowsTaskStatus,
  installLocalAgentWindowsTask,
  startLocalAgentWindowsTask,
  stopLocalAgentWindowsTask,
  uninstallLocalAgentWindowsTask,
} from "../localAgentWindowsTask.mjs";
import {
  deleteLocalAgentCredential,
  loadLocalAgentCredentialStore,
  readLocalAgentCredential,
  saveLocalAgentCredential,
} from "../localAgentWindowsCredentials.mjs";

const DEFAULT_CREDENTIAL_ENV = "SHIRYU_LOCAL_AGENT_CREDENTIAL";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CREDENTIAL_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isMissingWindowsKeytar(error) {
  return typeof error?.message === "string" && error.message.includes("optional keytar package");
}

function configPath(home = homedir(), platform = process.platform) {
  if (platform === "win32")
    return join(home, "AppData", "Roaming", "OmniRoute", "local-agent.json");
  return join(realpathSync(home), ".config", "omniroute", "local-agent.json");
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
}

function readWindowsPairedConfig(home = homedir()) {
  const filePath = configPath(home, "win32");
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Could not safely inspect the Windows Local Agent config.");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Refusing to read an unsafe Windows Local Agent config.");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("Windows Local Agent config is invalid.");
  }
  if (
    parsed?.managedBy !== "OmniRoute Local Agent" ||
    parsed?.credentialStorage !== "windows-credential-manager" ||
    typeof parsed.gatewayUrl !== "string" ||
    typeof parsed.deviceId !== "string" ||
    Object.hasOwn(parsed, "credential")
  ) {
    throw new Error("Refusing an unmanaged or plaintext Windows Local Agent config.");
  }
  return parsed;
}

function readPairedConfig(home = homedir(), platform = process.platform) {
  if (platform === "win32") return readWindowsPairedConfig(home);
  const canonicalHome = realpathSync(home);
  const ownerUid = currentUid();
  let directory = canonicalHome;
  for (const [index, component] of [".config", "omniroute"].entries()) {
    directory = join(directory, component);
    let directoryStats;
    try {
      directoryStats = lstatSync(directory);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error("Could not safely inspect the Local Agent pairing directory");
    }
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      directoryStats.uid !== ownerUid ||
      (directoryStats.mode & (index === 1 ? 0o077 : 0o022)) !== 0
    ) {
      throw new Error("Local Agent pairing directory has unsafe ownership or permissions");
    }
  }
  const filePath = join(directory, "local-agent.json");
  let fd;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Could not safely open the Local Agent pairing config");
  }
  try {
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== currentUid() ||
      (stats.mode & 0o077) !== 0
    ) {
      throw new Error("Local Agent pairing config must be current-user-owned with mode 0600");
    }
    const parsed = JSON.parse(readFileSync(fd, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.gatewayUrl !== "string" ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.credential !== "string"
    ) {
      throw new Error("Local Agent pairing config is invalid");
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Local Agent pairing config is invalid");
    throw error;
  } finally {
    closeSync(fd);
  }
}

function ensurePrivatePairingDirectory(home) {
  const canonicalHome = realpathSync(home);
  const ownerUid = currentUid();
  const homeStats = lstatSync(canonicalHome);
  if (!homeStats.isDirectory() || homeStats.isSymbolicLink() || homeStats.uid !== ownerUid) {
    throw new Error("Local Agent home must be a current-user-owned directory");
  }
  let currentPath = canonicalHome;
  for (const component of [".config", "omniroute"]) {
    currentPath = join(currentPath, component);
    try {
      mkdirSync(currentPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stats = lstatSync(currentPath);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      stats.uid !== ownerUid ||
      (stats.mode & 0o022) !== 0
    ) {
      throw new Error("Local Agent pairing directory must be private and current-user-owned");
    }
    chmodSync(currentPath, 0o700);
  }
  return canonicalHome;
}

function writePairedConfig(config, home = homedir(), platform = process.platform) {
  if (platform === "win32") throw new Error("Windows pairing config must use Credential Manager.");
  const canonicalHome = ensurePrivatePairingDirectory(home);
  const filePath = configPath(canonicalHome);
  try {
    const stats = lstatSync(filePath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.uid !== currentUid() ||
      (stats.mode & 0o077) !== 0
    ) {
      throw new Error("Refusing to replace an unsafe Local Agent pairing config");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let fd;
  try {
    fd = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporaryPath, { force: true });
  }
}

function writeWindowsPairedConfig(config, home = homedir()) {
  const filePath = configPath(home, "win32");
  const directory = join(home, "AppData", "Roaming", "OmniRoute");
  mkdirSync(directory, { recursive: true });
  try {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Refusing to replace an unsafe Windows Local Agent config.");
    }
    const existing = JSON.parse(readFileSync(filePath, "utf8"));
    if (existing?.managedBy !== "OmniRoute Local Agent") {
      throw new Error("Refusing to replace an unmanaged Windows Local Agent config.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        {
          managedBy: "OmniRoute Local Agent",
          credentialStorage: "windows-credential-manager",
          ...config,
        },
        null,
        2
      )}\n`,
      { flag: "wx" }
    );
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export async function saveWindowsLocalAgentConfig(config, { home = homedir(), keytarLoader } = {}) {
  const keytar = await loadLocalAgentCredentialStore(keytarLoader);
  let previousCredential;
  try {
    previousCredential = await keytar.getPassword("omniroute-local-agent", config.deviceId);
  } catch {
    throw new Error(
      "Could not read the existing Local Agent credential from Windows Credential Manager."
    );
  }
  await saveLocalAgentCredential(keytar, config.deviceId, config.credential);
  try {
    writeWindowsPairedConfig(
      {
        gatewayUrl: config.gatewayUrl,
        deviceId: config.deviceId,
        ollamaUrl: config.ollamaUrl,
        comfyUiUrl: config.comfyUiUrl,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        mcpServers: config.mcpServers ?? [],
      },
      home
    );
  } catch (error) {
    try {
      if (previousCredential === null) {
        await keytar.deletePassword("omniroute-local-agent", config.deviceId);
      } else {
        await keytar.setPassword("omniroute-local-agent", config.deviceId, previousCredential);
      }
    } catch {
      // Preserve the config-write error; credential storage never falls back to disk.
    }
    throw error;
  }
}

async function readPairingCode(stdin, stdout) {
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    stdout.write("Enter the one-time Local Agent pairing code: ");
    return await new Promise((resolve, reject) => {
      let value = "";
      const wasPaused = stdin.isPaused?.() ?? false;
      stdin.setRawMode(true);
      stdin.resume();
      const finish = (error, result) => {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        if (wasPaused) stdin.pause();
        stdout.write("\n");
        if (error) reject(error);
        else resolve(result);
      };
      const onData = (chunk) => {
        for (const character of Buffer.from(chunk).toString("utf8")) {
          if (character === "\u0003") return finish(new Error("Pairing cancelled"));
          if (character === "\r" || character === "\n") return finish(null, value);
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else if (value.length < 64) value += character;
        }
      };
      stdin.on("data", onData);
    });
  }
  let value = "";
  for await (const chunk of stdin) {
    value += Buffer.from(chunk).toString("utf8");
    if (value.length > 128) throw new Error("Invalid pairing code input");
  }
  return value.trim();
}

export async function pairLocalAgentCommand(
  options = {},
  {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    fetcher = globalThis.fetch,
    home = env.HOME || homedir(),
    readCode = readPairingCode,
    platform = process.platform,
    keytarLoader,
  } = {}
) {
  const credentialStore =
    platform === "win32" ? await loadLocalAgentCredentialStore(keytarLoader) : null;
  const gatewayUrl = parseGatewayUrl(
    requiredValue(options.gatewayUrl, env.SHIRYU_LOCAL_AGENT_GATEWAY_URL, "gateway URL")
  );
  const code = (await readCode(stdin, stdout)).trim();
  if (!PAIRING_CODE_PATTERN.test(code)) throw new Error("Invalid Local Agent pairing code");
  const response = await fetcher(new URL("/__gateway/v1/device/pair", gatewayUrl), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ version: 1, pairingCode: code }),
  });
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > 4_096) {
    throw new Error("Local Agent pairing response exceeds the size limit");
  }
  const responseText = await response.text();
  if (Buffer.byteLength(responseText, "utf8") > 4_096) {
    throw new Error("Local Agent pairing response exceeds the size limit");
  }
  let body;
  try {
    body = JSON.parse(responseText);
  } catch {
    body = null;
  }
  if (
    !response.ok ||
    !body ||
    body.version !== 1 ||
    typeof body.deviceId !== "string" ||
    !DEVICE_ID_PATTERN.test(body.deviceId) ||
    typeof body.credential !== "string" ||
    !DEVICE_CREDENTIAL_PATTERN.test(body.credential)
  ) {
    throw new Error("Local Agent pairing could not be completed");
  }
  const filePath = configPath(home, platform);
  if (platform === "win32") {
    await saveLocalAgentCredential(credentialStore, body.deviceId, body.credential);
    try {
      writeWindowsPairedConfig({ gatewayUrl, deviceId: body.deviceId }, home);
    } catch (error) {
      try {
        await deleteLocalAgentCredential(credentialStore, body.deviceId);
      } catch {
        // Preserve the config-write error; no credential is written to disk.
      }
      throw error;
    }
  } else {
    writePairedConfig({ gatewayUrl, deviceId: body.deviceId, credential: body.credential }, home);
  }
  stdout.write(
    platform === "win32"
      ? `Local Agent paired as ${body.deviceId}. Credential saved in Windows Credential Manager; config saved to ${filePath}.\n`
      : `Local Agent paired as ${body.deviceId}. Credential saved to ${filePath}.\n`
  );
  return { deviceId: body.deviceId, configPath: filePath };
}

function requiredValue(value, envValue, label) {
  const resolved = typeof value === "string" && value.trim() ? value.trim() : envValue?.trim();
  if (!resolved) throw new Error(`Missing Local Agent ${label}`);
  return resolved;
}

function parseGatewayUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Local Agent gateway URL must be a valid HTTPS URL or loopback HTTP URL");
  }
  const loopbackHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  const secureTransport = url.protocol === "https:" || (url.protocol === "http:" && loopbackHost);
  if (
    !secureTransport ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Local Agent gateway URL must be an HTTPS origin (HTTP is allowed only on loopback) without credentials or path data"
    );
  }
  return url.toString();
}

function optionalLocalUrl(value, envValue, label) {
  const resolved = typeof value === "string" && value.trim() ? value.trim() : envValue?.trim();
  if (!resolved) return undefined;
  let url;
  try {
    url = new URL(resolved);
  } catch {
    throw new Error(`${label} must be a valid HTTP URL`);
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be HTTP without credentials, query, or fragment`);
  }
  return url.toString();
}

function parsePositiveInteger(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400_000) {
    throw new Error(`${label} must be an integer between 1 and 86400000`);
  }
  return parsed;
}

function parseMcpServers(value) {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string" || value.length > 16_384) {
    throw new Error("Local MCP configuration exceeds the size limit");
  }
  let rows;
  try {
    rows = JSON.parse(value);
  } catch {
    throw new Error("Local MCP configuration must be valid JSON");
  }
  if (!Array.isArray(rows) || rows.length > 8) {
    throw new Error("Local MCP configuration must contain at most 8 servers");
  }
  const ids = new Set();
  return rows.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).some((key) => key !== "id" && key !== "endpoint") ||
      typeof row.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(row.id) ||
      ids.has(row.id) ||
      typeof row.endpoint !== "string"
    ) {
      throw new Error("Local MCP server configuration is invalid");
    }
    let endpoint;
    try {
      endpoint = new URL(row.endpoint);
    } catch {
      throw new Error("Local MCP endpoint must be a valid URL");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname.toLowerCase());
    if (
      (endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:")) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.search ||
      (!loopback && endpoint.port && endpoint.port !== "443")
    ) {
      throw new Error(
        "Local MCP endpoints must be loopback HTTP(S) or public HTTPS without credentials or query data"
      );
    }
    ids.add(row.id);
    return { id: row.id, endpoint: endpoint.toString() };
  });
}

/** Resolve process configuration without persisting or displaying the credential. */
export function resolveLocalAgentConfig(options = {}, env = process.env) {
  const credentialEnv = options.credentialEnv || DEFAULT_CREDENTIAL_ENV;
  if (!CREDENTIAL_ENV_PATTERN.test(credentialEnv)) {
    throw new Error("Invalid Local Agent credential environment variable name");
  }
  const needsStoredConfig =
    !(options.gatewayUrl || env.SHIRYU_LOCAL_AGENT_GATEWAY_URL) ||
    !(options.deviceId || env.SHIRYU_LOCAL_AGENT_DEVICE_ID) ||
    !env[credentialEnv];
  const pairedConfig = needsStoredConfig ? readPairedConfig(env.HOME || homedir()) : null;
  const gatewayUrl = parseGatewayUrl(
    requiredValue(
      options.gatewayUrl,
      env.SHIRYU_LOCAL_AGENT_GATEWAY_URL ?? pairedConfig?.gatewayUrl,
      "gateway URL"
    )
  );
  const deviceId = requiredValue(
    options.deviceId,
    env.SHIRYU_LOCAL_AGENT_DEVICE_ID ?? pairedConfig?.deviceId,
    "device ID"
  );
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("Invalid Local Agent device ID");

  const credential = env[credentialEnv] ?? pairedConfig?.credential;
  if (typeof credential !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(credential)) {
    throw new Error(`Set a valid one-time device credential in ${credentialEnv}`);
  }

  const heartbeatIntervalMs = parsePositiveInteger(
    options.heartbeatIntervalMs ?? env.SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS,
    "Heartbeat interval"
  );
  return {
    gatewayUrl,
    deviceId,
    credential,
    ollamaUrl: optionalLocalUrl(options.ollamaUrl, env.SHIRYU_LOCAL_AGENT_OLLAMA_URL, "Ollama URL"),
    comfyUiUrl: optionalLocalUrl(
      options.comfyUiUrl,
      env.SHIRYU_LOCAL_AGENT_COMFYUI_URL,
      "ComfyUI URL"
    ),
    mcpServers: options.mcpServers ?? parseMcpServers(env.SHIRYU_LOCAL_AGENT_MCP_SERVERS),
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
  };
}

export async function resolveLocalAgentConfigAsync(
  options = {},
  env = process.env,
  { platform = process.platform, home = env.HOME || homedir(), keytarLoader } = {}
) {
  if (platform !== "win32") return resolveLocalAgentConfig(options, env);
  const credentialEnv = options.credentialEnv || DEFAULT_CREDENTIAL_ENV;
  if (!CREDENTIAL_ENV_PATTERN.test(credentialEnv)) {
    throw new Error("Invalid Local Agent credential environment variable name");
  }
  const paired = readWindowsPairedConfig(home);
  const gatewayUrl = requiredValue(
    options.gatewayUrl,
    env.SHIRYU_LOCAL_AGENT_GATEWAY_URL ?? paired?.gatewayUrl,
    "gateway URL"
  );
  const deviceId = requiredValue(
    options.deviceId,
    env.SHIRYU_LOCAL_AGENT_DEVICE_ID ?? paired?.deviceId,
    "device ID"
  );
  let credential = env[credentialEnv];
  if (!credential) {
    if (!paired || paired.deviceId !== deviceId) {
      throw new Error(`Set a valid one-time device credential in ${credentialEnv}`);
    }
    const keytar = await loadLocalAgentCredentialStore(keytarLoader);
    credential = await readLocalAgentCredential(keytar, deviceId);
  }
  return resolveLocalAgentConfig(
    { ...paired, ...options, gatewayUrl, deviceId },
    { ...env, [credentialEnv]: credential }
  );
}

async function runGatewayAgent(config, signal) {
  const [{ runLocalAgentWithGateway }, { createHttpLocalAgentGatewayTransport }] =
    await Promise.all([
      import("../../../src/lib/localAgent/runner.ts"),
      import("../../../src/lib/localAgent/httpGatewayTransport.ts"),
    ]);
  const fetch = globalThis.fetch;
  const gateway = createHttpLocalAgentGatewayTransport(config.gatewayUrl, { fetch });
  await runLocalAgentWithGateway(config, { fetch, gateway }, signal);
}

/** Run one outbound-only agent process, stopping cleanly when the OS signals it. */
export async function runLocalAgentCommand(
  options = {},
  {
    env = process.env,
    signalTarget = process,
    runAgent = runGatewayAgent,
    platform = process.platform,
    keytarLoader,
  } = {}
) {
  const resolvedConfig = platform === "win32" ? null : resolveLocalAgentConfig(options, env);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  signalTarget.once("SIGINT", shutdown);
  signalTarget.once("SIGTERM", shutdown);
  try {
    const config =
      resolvedConfig ??
      (await resolveLocalAgentConfigAsync(options, env, { platform, keytarLoader }));
    if (!controller.signal.aborted) await runAgent(config, controller.signal);
  } finally {
    signalTarget.removeListener("SIGINT", shutdown);
    signalTarget.removeListener("SIGTERM", shutdown);
  }
}

/** Check customer-local AI/MCP services without pairing or contacting the gateway. */
export async function checkLocalAgentCommand(
  options = {},
  { env = process.env, stdout = process.stdout, discover = null } = {}
) {
  const discoveryFunction =
    discover ??
    (await import("../../../src/lib/localAgent/localDiscovery.ts")).discoverLocalCapabilities;
  const result = await discoveryFunction(
    {
      ollamaUrl: optionalLocalUrl(
        options.ollamaUrl,
        env.SHIRYU_LOCAL_AGENT_OLLAMA_URL,
        "Ollama URL"
      ),
      comfyUiUrl: optionalLocalUrl(
        options.comfyUiUrl,
        env.SHIRYU_LOCAL_AGENT_COMFYUI_URL,
        "ComfyUI URL"
      ),
      mcpServers: parseMcpServers(env.SHIRYU_LOCAL_AGENT_MCP_SERVERS),
    },
    { fetch: globalThis.fetch }
  );

  for (const service of result.services) {
    const state = service.reachable ? "online" : "offline";
    const models = service.models.length ? ` (${service.models.length} models)` : "";
    stdout.write(`${service.service}: ${state}${models}\n`);
  }
  for (const server of result.mcpServers ?? []) {
    stdout.write(`MCP ${server.id}: online (${server.tools.length} tools)\n`);
  }
  const capabilities = result.heartbeat.capabilities;
  stdout.write(
    capabilities.length ? `Capabilities: ${capabilities.join(", ")}\n` : "Capabilities: none\n"
  );
  return {
    ok:
      result.services.some((service) => service.reachable) || (result.mcpServers?.length ?? 0) > 0,
    result,
  };
}

export function registerLocalAgent(
  program,
  { platform = process.platform, keytarLoader, home = homedir() } = {}
) {
  const localAgent = program
    .command("local-agent")
    .description("Manage a tenant-registered outbound Local Agent");

  localAgent
    .command("check")
    .description("Check local Ollama, ComfyUI, and MCP services without pairing")
    .option("--ollama-url <url>", "Local Ollama URL (or SHIRYU_LOCAL_AGENT_OLLAMA_URL)")
    .option("--comfyui-url <url>", "Local ComfyUI URL (or SHIRYU_LOCAL_AGENT_COMFYUI_URL)")
    .action(async (options) => {
      try {
        const checked = await checkLocalAgentCommand(options);
        if (!checked.ok) process.exitCode = 1;
      } catch {
        process.stderr.write(
          "Local Agent service check failed; check the local service configuration.\n"
        );
        process.exitCode = 1;
      }
    });

  localAgent
    .command("pair")
    .description("Pair this Local Agent with a short-lived customer pairing code")
    .option("--gateway-url <url>", "HTTPS gateway base URL (or SHIRYU_LOCAL_AGENT_GATEWAY_URL)")
    .action(async (options) => {
      try {
        await pairLocalAgentCommand(options);
      } catch (error) {
        process.stderr.write(
          isMissingWindowsKeytar(error)
            ? `${error.message}\n`
            : "Local Agent pairing failed; check the gateway and pairing code.\n"
        );
        process.exitCode = 1;
      }
    });

  localAgent
    .command("run")
    .description("Connect to the HTTPS gateway and serve discovered local capabilities")
    .option("--gateway-url <url>", "HTTPS gateway base URL (or SHIRYU_LOCAL_AGENT_GATEWAY_URL)")
    .option("--device-id <id>", "Registered device ID (or SHIRYU_LOCAL_AGENT_DEVICE_ID)")
    .option(
      "--credential-env <name>",
      "Environment variable containing the one-time device credential",
      DEFAULT_CREDENTIAL_ENV
    )
    .option("--ollama-url <url>", "Local Ollama URL (or SHIRYU_LOCAL_AGENT_OLLAMA_URL)")
    .option("--comfyui-url <url>", "Local ComfyUI URL (or SHIRYU_LOCAL_AGENT_COMFYUI_URL)")
    .option(
      "--heartbeat-interval-ms <milliseconds>",
      "Heartbeat interval in milliseconds (or SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS)"
    )
    .action(async (options) => {
      try {
        await runLocalAgentCommand(options);
      } catch (error) {
        // Errors from network or capability execution can contain request data. Keep the
        // process diagnostic generic and never print device credentials or request payloads.
        process.stderr.write(
          isMissingWindowsKeytar(error)
            ? `${error.message}\n`
            : "Local Agent stopped after a configuration or runtime error.\n"
        );
        process.exitCode = 1;
      }
    });

  const service = localAgent
    .command("service")
    .description("Manage the per-user Local Agent service");
  const install = service
    .command("install")
    .description("Install and start a per-user systemd, launchd, or Windows Task Scheduler service")
    .option("--gateway-url <url>", "HTTPS gateway base URL (or SHIRYU_LOCAL_AGENT_GATEWAY_URL)")
    .option("--device-id <id>", "Registered device ID (or SHIRYU_LOCAL_AGENT_DEVICE_ID)")
    .option(
      "--credential-env <name>",
      "Environment variable containing the one-time device credential",
      DEFAULT_CREDENTIAL_ENV
    )
    .option("--ollama-url <url>", "Local Ollama URL (or SHIRYU_LOCAL_AGENT_OLLAMA_URL)")
    .option("--comfyui-url <url>", "Local ComfyUI URL (or SHIRYU_LOCAL_AGENT_COMFYUI_URL)")
    .option(
      "--heartbeat-interval-ms <milliseconds>",
      "Heartbeat interval in milliseconds (or SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS)"
    );
  install.action(async (options) => {
    try {
      const config = await resolveLocalAgentConfigAsync(options, process.env, {
        platform,
        home,
        keytarLoader,
      });
      let installed;
      if (platform === "win32") {
        await saveWindowsLocalAgentConfig(config, { home, keytarLoader });
        installed = installLocalAgentWindowsTask(config, { platform });
      } else if (platform === "darwin") {
        installed = installLocalAgentLaunchd(config);
      } else if (platform === "linux") {
        installed = installLocalAgentSystemd(config);
      } else {
        throw new Error("Local Agent service management is not supported on this platform.");
      }
      process.stdout.write(`Local Agent service installed: ${installed.serviceName}\n`);
    } catch (error) {
      process.stderr.write(
        isMissingWindowsKeytar(error)
          ? `${error.message}\n`
          : "Local Agent service install failed; check the platform service manager and configuration.\n"
      );
      process.exitCode = 1;
    }
  });

  service
    .command("uninstall")
    .description("Stop and remove the installed Local Agent user service")
    .action(() => {
      try {
        let removed;
        if (platform === "win32") removed = uninstallLocalAgentWindowsTask({ platform });
        else if (platform === "darwin") removed = uninstallLocalAgentLaunchd();
        else if (platform === "linux") removed = uninstallLocalAgentSystemd();
        else throw new Error("Local Agent service management is not supported on this platform.");
        process.stdout.write(
          removed ? "Local Agent service removed.\n" : "Local Agent service is not installed.\n"
        );
      } catch {
        process.stderr.write(
          "Local Agent service uninstall failed; existing files were preserved.\n"
        );
        process.exitCode = 1;
      }
    });

  const serviceControls =
    platform === "win32"
      ? {
          start: () => startLocalAgentWindowsTask({ platform }),
          stop: () => stopLocalAgentWindowsTask({ platform }),
          status: () => getLocalAgentWindowsTaskStatus({ platform }),
        }
      : platform === "darwin"
        ? {
            start: () => startLocalAgentLaunchd(),
            stop: () => stopLocalAgentLaunchd(),
            status: () => getLocalAgentLaunchdStatus(),
          }
        : platform === "linux"
          ? {
              start: () => startLocalAgentSystemd(),
              stop: () => stopLocalAgentSystemd(),
              status: () => getLocalAgentSystemdStatus(),
            }
          : null;

  if (serviceControls) {
    for (const operation of ["start", "stop", "status"]) {
      service
        .command(operation)
        .description(
          `${operation[0].toUpperCase()}${operation.slice(1)} the per-user Local Agent service`
        )
        .action(() => {
          try {
            const result = serviceControls[operation]();
            if (operation === "status") {
              process.stdout.write(
                result.installed
                  ? `Local Agent service: ${result.state}\n`
                  : "Local Agent service is not installed.\n"
              );
            } else {
              process.stdout.write(
                result
                  ? `Local Agent service ${operation} requested.\n`
                  : "Local Agent service is not installed.\n"
              );
            }
          } catch {
            process.stderr.write(
              `Local Agent service ${operation} failed; existing configuration was preserved.\n`
            );
            process.exitCode = 1;
          }
        });
    }
  }
}
