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
import { installLocalAgentSystemd, uninstallLocalAgentSystemd } from "../localAgentSystemd.mjs";
import { installLocalAgentLaunchd, uninstallLocalAgentLaunchd } from "../localAgentLaunchd.mjs";

const DEFAULT_CREDENTIAL_ENV = "SHIRYU_LOCAL_AGENT_CREDENTIAL";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CREDENTIAL_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function configPath(home = homedir()) {
  return join(realpathSync(home), ".config", "omniroute", "local-agent.json");
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
}

function readPairedConfig(home = homedir()) {
  if (process.platform === "win32") return null;
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
  if (process.platform === "win32") {
    throw new Error(
      "Local Agent pairing is not supported on Windows; configure the credential manually"
    );
  }
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

function writePairedConfig(config, home = homedir()) {
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
  } = {}
) {
  if (process.platform === "win32") {
    throw new Error(
      "Local Agent pairing is not supported on Windows; configure the credential manually"
    );
  }
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
  const filePath = configPath(home);
  writePairedConfig({ gatewayUrl, deviceId: body.deviceId, credential: body.credential }, home);
  stdout.write(`Local Agent paired as ${body.deviceId}. Credential saved to ${filePath}.\n`);
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
    mcpServers: parseMcpServers(env.SHIRYU_LOCAL_AGENT_MCP_SERVERS),
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
  };
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
  { env = process.env, signalTarget = process, runAgent = runGatewayAgent } = {}
) {
  const config = resolveLocalAgentConfig(options, env);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  signalTarget.once("SIGINT", shutdown);
  signalTarget.once("SIGTERM", shutdown);
  try {
    await runAgent(config, controller.signal);
  } finally {
    signalTarget.removeListener("SIGINT", shutdown);
    signalTarget.removeListener("SIGTERM", shutdown);
  }
}

export function registerLocalAgent(program) {
  const localAgent = program
    .command("local-agent")
    .description("Manage a tenant-registered outbound Local Agent");

  localAgent
    .command("pair")
    .description("Pair this Local Agent with a short-lived customer pairing code")
    .option("--gateway-url <url>", "HTTPS gateway base URL (or SHIRYU_LOCAL_AGENT_GATEWAY_URL)")
    .action(async (options) => {
      try {
        await pairLocalAgentCommand(options);
      } catch {
        process.stderr.write("Local Agent pairing failed; check the gateway and pairing code.\n");
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
      } catch {
        // Errors from network or capability execution can contain request data. Keep the
        // process diagnostic generic and never print device credentials or request payloads.
        process.stderr.write("Local Agent stopped after a configuration or runtime error.\n");
        process.exitCode = 1;
      }
    });

  const service = localAgent
    .command("service")
    .description("Install or remove the per-user Local Agent service");
  const install = service
    .command("install")
    .description("Install and start a protected Linux systemd or macOS launchd user service")
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
      const config = resolveLocalAgentConfig(options);
      const installed =
        process.platform === "darwin"
          ? installLocalAgentLaunchd(config)
          : installLocalAgentSystemd(config);
      process.stdout.write(`Local Agent service installed: ${installed.serviceName}\n`);
    } catch {
      process.stderr.write(
        "Local Agent service install failed; check systemd or launchd and configuration.\n"
      );
      process.exitCode = 1;
    }
  });

  service
    .command("uninstall")
    .description("Stop and remove the installed Local Agent user service")
    .action(() => {
      try {
        const removed =
          process.platform === "darwin"
            ? uninstallLocalAgentLaunchd()
            : uninstallLocalAgentSystemd();
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
}
