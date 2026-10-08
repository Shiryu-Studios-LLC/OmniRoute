import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assertProfilesAreInactive(profileRoot) {
  for (const profileName of fs.readdirSync(profileRoot)) {
    const lockPath = path.join(profileRoot, profileName, "SingletonLock");
    let lock;
    try {
      lock = fs.lstatSync(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    if (!lock.isSymbolicLink()) {
      throw new Error(
        `Cannot safely stage Adobe Chrome profile with an unverified lock: ${lockPath}`
      );
    }

    const target = fs.readlinkSync(lockPath);
    const pidMatch = /-(\d+)$/.exec(target);
    if (!pidMatch) {
      throw new Error(`Cannot identify the Adobe Chrome profile lock owner: ${lockPath}`);
    }

    try {
      process.kill(Number(pidMatch[1]), 0);
      throw new Error(`Adobe Chrome profile is in use by process ${pidMatch[1]}: ${lockPath}`);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

/** Temporarily move only local Chromium profiles outside Next's tracing root. */
export function stageCloudflareBrowserProfiles(repoRoot, options = {}) {
  const profileRoot = path.join(repoRoot, ".data", "adobe-chrome-profiles");
  if (!fs.existsSync(profileRoot)) return () => {};

  assertProfilesAreInactive(profileRoot);

  const stagingRoot = path.join(
    path.dirname(repoRoot),
    `.${path.basename(repoRoot)}-adobe-profiles-${process.pid}-${options.suffix ?? Date.now()}`
  );
  if (fs.existsSync(stagingRoot)) {
    throw new Error(`Cloudflare build profile staging path already exists: ${stagingRoot}`);
  }

  // This sibling is on the same filesystem and outside outputFileTracingRoot.
  // Rename preserves file contents, permissions, and symlinks without copying or deleting them.
  fs.renameSync(profileRoot, stagingRoot);

  return () => {
    if (fs.existsSync(profileRoot)) {
      throw new Error(
        `Adobe Chrome profiles were recreated during the build; original profiles remain at ${stagingRoot}`
      );
    }
    fs.mkdirSync(path.dirname(profileRoot), { recursive: true });
    fs.renameSync(stagingRoot, profileRoot);
  };
}
