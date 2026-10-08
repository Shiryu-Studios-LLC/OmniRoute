import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_NAME = "omniroute-local-agent.service";
const SERVICE_MARKER = "# Managed by OmniRoute Local Agent";
const ENV_MARKER = "# Managed by OmniRoute Local Agent";
const MANAGED_ENV_KEYS = [
  "SHIRYU_LOCAL_AGENT_GATEWAY_URL",
  "SHIRYU_LOCAL_AGENT_DEVICE_ID",
  "SHIRYU_LOCAL_AGENT_CREDENTIAL",
  "SHIRYU_LOCAL_AGENT_OLLAMA_URL",
  "SHIRYU_LOCAL_AGENT_COMFYUI_URL",
  "SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS",
];

function paths(home) {
  const configDir = join(home, ".config", "omniroute");
  const serviceDir = join(home, ".config", "systemd", "user");
  return {
    configDir,
    envFile: join(configDir, "local-agent.env"),
    serviceDir,
    unitFile: join(serviceDir, SERVICE_NAME),
  };
}

function quoteExecArg(value) {
  if (/[\0-\x1f\x7f]/.test(value)) throw new Error("Unsupported control character in systemd path");
  const escaped = value.replace(/%/g, "%%");
  if (!/[ \t"'\\]/.test(escaped)) return escaped;
  return `"${escaped.replace(/(["\\])/g, "\\$1")}"`;
}

function encodeEnvironmentValue(value) {
  return `"${String(value).replace(/([\\"`$])/g, "\\$1")}"`;
}

function serviceContents({ nodePath, cliPath, envFile }) {
  return [
    SERVICE_MARKER,
    "[Unit]",
    "Description=OmniRoute customer Local Agent",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${quoteExecArg(nodePath)} ${quoteExecArg(cliPath)} local-agent run`,
    `EnvironmentFile=${quoteExecArg(envFile)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function writeAtomic(filePath, content, mode) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, content, { mode });
  chmodSync(temporaryPath, mode);
  renameSync(temporaryPath, filePath);
}

function runSystemctl(args, exec = execFileSync) {
  exec("systemctl", ["--user", ...args], { stdio: "ignore" });
}

function currentCliPath() {
  const argPath = process.argv[1];
  if (argPath) return resolve(argPath);
  return fileURLToPath(new URL("../omniroute.mjs", import.meta.url));
}

/** Install/update a per-user systemd service and a protected credential file. */
export function installLocalAgentSystemd(
  config,
  {
    home = process.env.HOME || homedir(),
    platform = process.platform,
    nodePath = process.execPath,
    cliPath = currentCliPath(),
    exec = execFileSync,
  } = {}
) {
  if (platform !== "linux") throw new Error("Local Agent service install is supported on Linux");
  const files = paths(home);
  if (!isAbsolute(nodePath) || !isAbsolute(cliPath) || !isAbsolute(files.envFile)) {
    throw new Error("Local Agent systemd paths must be absolute");
  }
  mkdirSync(files.configDir, { recursive: true, mode: 0o700 });
  chmodSync(files.configDir, 0o700);
  mkdirSync(files.serviceDir, { recursive: true, mode: 0o700 });
  const priorUnit = existsSync(files.unitFile) ? readFileSync(files.unitFile, "utf8") : null;
  if (priorUnit && !priorUnit.startsWith(`${SERVICE_MARKER}\n`)) {
    throw new Error("Refusing to replace an unmanaged Local Agent systemd unit");
  }

  const priorEnv = existsSync(files.envFile) ? readFileSync(files.envFile, "utf8") : null;
  if (priorEnv && !priorEnv.startsWith(`${ENV_MARKER}\n`)) {
    throw new Error("Refusing to replace an unmanaged Local Agent environment file");
  }
  const values = {
    SHIRYU_LOCAL_AGENT_GATEWAY_URL: config.gatewayUrl,
    SHIRYU_LOCAL_AGENT_DEVICE_ID: config.deviceId,
    SHIRYU_LOCAL_AGENT_CREDENTIAL: config.credential,
    SHIRYU_LOCAL_AGENT_OLLAMA_URL: config.ollamaUrl ?? "",
    SHIRYU_LOCAL_AGENT_COMFYUI_URL: config.comfyUiUrl ?? "",
    SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS: config.heartbeatIntervalMs?.toString() ?? "",
  };
  const envContent =
    `${ENV_MARKER}\n` +
    MANAGED_ENV_KEYS.map((key) => `${key}=${encodeEnvironmentValue(values[key])}`).join("\n") +
    "\n";
  const unitContent = serviceContents({ nodePath, cliPath, envFile: files.envFile });
  let wasActive = false;
  if (priorUnit) {
    try {
      exec("systemctl", ["--user", "is-active", "--quiet", SERVICE_NAME], { stdio: "ignore" });
      wasActive = true;
    } catch {
      // Existing but inactive services remain inactive if an update rolls back.
    }
  }
  writeAtomic(files.envFile, envContent, 0o600);
  writeAtomic(files.unitFile, unitContent, 0o600);

  try {
    runSystemctl(["daemon-reload"], exec);
    if (priorUnit) {
      runSystemctl(["enable", SERVICE_NAME], exec);
      runSystemctl(["restart", SERVICE_NAME], exec);
    } else {
      runSystemctl(["enable", "--now", SERVICE_NAME], exec);
    }
  } catch (error) {
    try {
      runSystemctl(["stop", SERVICE_NAME], exec);
    } catch {
      // A not-yet-installed or already-stopped unit needs no cleanup.
    }
    if (priorEnv === null) rmSync(files.envFile, { force: true });
    else writeAtomic(files.envFile, priorEnv, 0o600);
    if (priorUnit === null) rmSync(files.unitFile, { force: true });
    else writeAtomic(files.unitFile, priorUnit, 0o600);
    try {
      runSystemctl(["daemon-reload"], exec);
    } catch {
      // Preserve the original systemctl failure for the caller.
    }
    if (priorUnit && wasActive) {
      try {
        runSystemctl(["start", SERVICE_NAME], exec);
      } catch {
        // The old unit files are restored; callers can retry service startup.
      }
    }
    throw error;
  }
  return { serviceName: SERVICE_NAME, unitFile: files.unitFile, envFile: files.envFile };
}

/** Remove only the service and credential file created by this installer. */
export function uninstallLocalAgentSystemd({
  home = process.env.HOME || homedir(),
  platform = process.platform,
  exec = execFileSync,
} = {}) {
  if (platform !== "linux") throw new Error("Local Agent service uninstall is supported on Linux");
  const files = paths(home);
  if (!existsSync(files.unitFile)) {
    if (!existsSync(files.envFile)) return false;
    const orphanEnvironment = readFileSync(files.envFile, "utf8");
    if (!orphanEnvironment.startsWith(`${ENV_MARKER}\n`)) {
      throw new Error("Refusing to remove an unmanaged Local Agent environment file");
    }
    let active = false;
    try {
      exec("systemctl", ["--user", "is-active", "--quiet", SERVICE_NAME], { stdio: "ignore" });
      active = true;
    } catch (error) {
      if (error?.status !== 3 && error?.status !== 4) {
        throw new Error("Could not verify the orphaned Local Agent service is stopped");
      }
    }
    if (active) runSystemctl(["stop", SERVICE_NAME], exec);
    rmSync(files.envFile, { force: true });
    return true;
  }
  const unit = readFileSync(files.unitFile, "utf8");
  if (!unit.startsWith(`${SERVICE_MARKER}\n`)) {
    throw new Error("Refusing to remove an unmanaged Local Agent systemd unit");
  }
  if (existsSync(files.envFile)) {
    const environment = readFileSync(files.envFile, "utf8");
    if (!environment.startsWith(`${ENV_MARKER}\n`)) {
      throw new Error("Refusing to remove an unmanaged Local Agent environment file");
    }
  }
  runSystemctl(["disable", "--now", SERVICE_NAME], exec);
  rmSync(files.unitFile, { force: true });
  if (existsSync(files.envFile)) rmSync(files.envFile, { force: true });
  try {
    runSystemctl(["daemon-reload"], exec);
  } catch {
    // Unit and credential files are already removed; systemd can reload on its next operation.
  }
  return true;
}
