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
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.omniroute.local-agent";
const PLIST_MARKER = "<!-- Managed by OmniRoute Local Agent -->";
const MANAGED_ENV_KEYS = [
  "SHIRYU_LOCAL_AGENT_GATEWAY_URL",
  "SHIRYU_LOCAL_AGENT_DEVICE_ID",
  "SHIRYU_LOCAL_AGENT_CREDENTIAL",
  "SHIRYU_LOCAL_AGENT_OLLAMA_URL",
  "SHIRYU_LOCAL_AGENT_COMFYUI_URL",
  "SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS",
];

function paths(home) {
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  return { launchAgentsDir, plistFile: join(launchAgentsDir, `${LABEL}.plist`) };
}

function xml(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Unsupported control character in Local Agent launchd configuration");
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistContents({ nodePath, cliPath, values }) {
  const environment = MANAGED_ENV_KEYS.map(
    (key) => `\t\t<key>${key}</key>\n\t\t<string>${xml(values[key])}</string>`
  ).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    PLIST_MARKER,
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    `\t\t<string>${xml(nodePath)}</string>`,
    `\t\t<string>${xml(cliPath)}</string>`,
    "\t\t<string>local-agent</string>",
    "\t\t<string>run</string>",
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    environment,
    "\t</dict>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<dict>",
    "\t\t<key>SuccessfulExit</key>",
    "\t\t<false/>",
    "\t</dict>",
    "\t<key>ThrottleInterval</key>",
    "\t<integer>5</integer>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function isManagedPlist(contents) {
  return contents.startsWith(`<?xml version="1.0" encoding="UTF-8"?>\n${PLIST_MARKER}\n`);
}

function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, content, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, filePath);
}

function runLaunchctl(args, exec = execFileSync) {
  exec("launchctl", args, { stdio: "ignore" });
}

function currentCliPath() {
  const argPath = process.argv[1];
  if (argPath) return resolve(argPath);
  return fileURLToPath(new URL("../omniroute.mjs", import.meta.url));
}

function valuesFromConfig(config) {
  return {
    SHIRYU_LOCAL_AGENT_GATEWAY_URL: config.gatewayUrl,
    SHIRYU_LOCAL_AGENT_DEVICE_ID: config.deviceId,
    SHIRYU_LOCAL_AGENT_CREDENTIAL: config.credential,
    SHIRYU_LOCAL_AGENT_OLLAMA_URL: config.ollamaUrl ?? "",
    SHIRYU_LOCAL_AGENT_COMFYUI_URL: config.comfyUiUrl ?? "",
    SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS: config.heartbeatIntervalMs?.toString() ?? "",
  };
}

function launchDomain(uid) {
  if (!Number.isSafeInteger(uid) || uid < 1) {
    throw new Error("Local Agent launchd install requires a non-root macOS user");
  }
  return `gui/${uid}`;
}

function isLoaded(domain, exec) {
  try {
    exec("launchctl", ["print", `${domain}/${LABEL}`], { stdio: "ignore" });
    return true;
  } catch (error) {
    if (error?.status === 113) return false;
    throw new Error("Could not verify whether the Local Agent launchd service is loaded");
  }
}

/** Install/update a per-user macOS LaunchAgent with an owner-only credential plist. */
export function installLocalAgentLaunchd(
  config,
  {
    home = process.env.HOME || homedir(),
    platform = process.platform,
    uid = userInfo().uid,
    nodePath = process.execPath,
    cliPath = currentCliPath(),
    exec = execFileSync,
  } = {}
) {
  if (platform !== "darwin") throw new Error("Local Agent launchd install is supported on macOS");
  if (!isAbsolute(nodePath) || !isAbsolute(cliPath)) {
    throw new Error("Local Agent launchd program paths must be absolute");
  }
  const domain = launchDomain(uid);
  const files = paths(home);
  mkdirSync(files.launchAgentsDir, { recursive: true, mode: 0o700 });
  const priorPlist = existsSync(files.plistFile) ? readFileSync(files.plistFile, "utf8") : null;
  if (priorPlist && !isManagedPlist(priorPlist)) {
    throw new Error("Refusing to replace an unmanaged Local Agent launchd plist");
  }

  const loaded = priorPlist ? isLoaded(domain, exec) : false;
  if (loaded) runLaunchctl(["bootout", `${domain}/${LABEL}`], exec);
  let wrotePlist = false;
  try {
    writeAtomic(
      files.plistFile,
      plistContents({ nodePath, cliPath, values: valuesFromConfig(config) })
    );
    wrotePlist = true;
    runLaunchctl(["bootstrap", domain, files.plistFile], exec);
  } catch (error) {
    try {
      if (isLoaded(domain, exec)) runLaunchctl(["bootout", `${domain}/${LABEL}`], exec);
    } catch {
      // Preserve the original bootstrap failure.
    }
    if (priorPlist === null) rmSync(files.plistFile, { force: true });
    else if (wrotePlist) writeAtomic(files.plistFile, priorPlist);
    if (loaded) {
      try {
        runLaunchctl(["bootstrap", domain, files.plistFile], exec);
      } catch {
        // The previous plist is restored; the caller can retry loading it.
      }
    }
    throw error;
  }
  return { serviceName: LABEL, plistFile: files.plistFile };
}

/** Remove only a LaunchAgent plist created by this installer. */
export function uninstallLocalAgentLaunchd({
  home = process.env.HOME || homedir(),
  platform = process.platform,
  uid = userInfo().uid,
  exec = execFileSync,
} = {}) {
  if (platform !== "darwin") throw new Error("Local Agent launchd uninstall is supported on macOS");
  const files = paths(home);
  if (!existsSync(files.plistFile)) return false;
  const plist = readFileSync(files.plistFile, "utf8");
  if (!isManagedPlist(plist)) {
    throw new Error("Refusing to remove an unmanaged Local Agent launchd plist");
  }
  const domain = launchDomain(uid);
  const loaded = isLoaded(domain, exec);
  if (loaded) runLaunchctl(["bootout", `${domain}/${LABEL}`], exec);
  try {
    rmSync(files.plistFile, { force: true });
  } catch (error) {
    if (loaded) {
      try {
        runLaunchctl(["bootstrap", domain, files.plistFile], exec);
      } catch {
        // Preserve the original removal failure; the plist remains for manual recovery.
      }
    }
    throw error;
  }
  return true;
}
