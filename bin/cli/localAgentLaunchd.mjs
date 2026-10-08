import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
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

function ensurePrivateDirectories(home) {
  const ownerUid = typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
  const canonicalHome = realpathSync(home);
  const homeStats = lstatSync(canonicalHome);
  if (!homeStats.isDirectory() || homeStats.uid !== ownerUid || (homeStats.mode & 0o022) !== 0) {
    throw new Error("Local Agent home must be current-user-owned and not group/world writable");
  }
  let currentPath = home;
  for (const component of ["Library", "LaunchAgents"]) {
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
      throw new Error(
        "Local Agent LaunchAgents path must use current-user-owned, non-writable directories"
      );
    }
  }
}

function readExistingPlist(filePath) {
  let fd;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Could not safely open the Local Agent launchd plist");
  }
  try {
    const stats = fstatSync(fd);
    const ownerUid = typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== ownerUid ||
      (stats.mode & 0o077) !== 0
    ) {
      throw new Error(
        "Refusing to read a Local Agent plist with unsafe file type, owner, links, or permissions"
      );
    }
    return { contents: readFileSync(fd, "utf8"), identity: { dev: stats.dev, ino: stats.ino } };
  } finally {
    closeSync(fd);
  }
}

function stillMatchesIdentity(filePath, identity) {
  let fd;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(fd);
    const ownerUid = typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
    return (
      stats.isFile() &&
      stats.nlink === 1 &&
      stats.uid === ownerUid &&
      (stats.mode & 0o077) === 0 &&
      stats.dev === identity.dev &&
      stats.ino === identity.ino
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAtomic(filePath, content, { replaceExisting = false, expectedIdentity } = {}) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let fd;
  let linkedTarget = false;
  try {
    fd = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (replaceExisting) {
      if (expectedIdentity) {
        const current = lstatSync(filePath);
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.dev !== expectedIdentity.dev ||
          current.ino !== expectedIdentity.ino
        ) {
          throw new Error("Local Agent launchd plist changed during update");
        }
      }
      renameSync(temporaryPath, filePath);
    } else {
      linkSync(temporaryPath, filePath);
      linkedTarget = true;
      unlinkSync(temporaryPath);
    }
  } catch (error) {
    if (linkedTarget) rmSync(filePath, { force: true });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporaryPath, { force: true });
  }
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
    if (error?.status === 113) {
      try {
        exec("launchctl", ["print", domain], { stdio: "ignore" });
        return false;
      } catch {
        throw new Error("Could not verify whether the Local Agent launchd domain is available");
      }
    }
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
  const canonicalHome = realpathSync(home);
  ensurePrivateDirectories(canonicalHome);
  const files = paths(canonicalHome);
  const priorFile = readExistingPlist(files.plistFile);
  const priorPlist = priorFile?.contents ?? null;
  if (priorPlist && !isManagedPlist(priorPlist)) {
    throw new Error("Refusing to replace an unmanaged Local Agent launchd plist");
  }

  const loaded = isLoaded(domain, exec);
  if (!priorPlist && loaded) {
    throw new Error(
      "Refusing to replace a loaded Local Agent launchd service without its managed plist"
    );
  }
  if (loaded) runLaunchctl(["bootout", `${domain}/${LABEL}`], exec);
  let wrotePlist = false;
  try {
    writeAtomic(
      files.plistFile,
      plistContents({ nodePath, cliPath, values: valuesFromConfig(config) }),
      { replaceExisting: priorFile !== null, expectedIdentity: priorFile?.identity }
    );
    wrotePlist = true;
    runLaunchctl(["bootstrap", domain, files.plistFile], exec);
  } catch (error) {
    try {
      if (priorPlist !== null && isLoaded(domain, exec)) {
        runLaunchctl(["bootout", `${domain}/${LABEL}`], exec);
      }
    } catch {
      // Preserve the original bootstrap failure.
    }
    let priorIsSafeToLoad = false;
    if (priorPlist === null) {
      if (wrotePlist) rmSync(files.plistFile, { force: true });
    } else if (wrotePlist) {
      writeAtomic(files.plistFile, priorPlist, { replaceExisting: true });
      priorIsSafeToLoad = true;
    } else {
      priorIsSafeToLoad = stillMatchesIdentity(files.plistFile, priorFile.identity);
    }
    if (loaded && priorIsSafeToLoad) {
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
  const canonicalHome = realpathSync(home);
  ensurePrivateDirectories(canonicalHome);
  const files = paths(canonicalHome);
  const existing = readExistingPlist(files.plistFile);
  if (!existing) return false;
  const plist = existing.contents;
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
