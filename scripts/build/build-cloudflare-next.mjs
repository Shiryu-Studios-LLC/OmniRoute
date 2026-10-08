import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stageCloudflareBrowserProfiles } from "./cloudflareBrowserProfileStaging.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const nextCli = require.resolve("next/dist/bin/next");
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cloudflare-browser-profile-"));
let restoreBrowserProfiles = () => {};

try {
  restoreBrowserProfiles = stageCloudflareBrowserProfiles(repoRoot);
  // `.next` is reserved for the OpenNext target in open-next.config.ts. Remove
  // old middleware/instrumentation NFT traces so a rebuild cannot copy entries
  // left behind by a previous local-data graph.
  fs.rmSync(path.join(repoRoot, ".next"), { recursive: true, force: true });
  const result = spawnSync(process.execPath, [nextCli, "build"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NEXT_DIST_DIR: ".next",
      OMNIROUTE_INTERNAL_ADOBE_BROWSER_PROFILE_DIR: profileRoot,
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(profileRoot, { recursive: true, force: true });
  restoreBrowserProfiles();
}
