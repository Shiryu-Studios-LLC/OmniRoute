import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wranglerBin = fs.realpathSync(path.join(repoRoot, "node_modules/.bin/wrangler"));
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cloudflare-worker-"));

try {
  const metaFile = path.join(outputDir, "bundle-meta.json");
  const result = spawnSync(
    process.execPath,
    [wranglerBin, "deploy", "--dry-run", "--outdir", outputDir, "--metafile", metaFile],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const workerFile = path.join(outputDir, "worker.js");
    if (!fs.existsSync(workerFile) || !fs.existsSync(metaFile)) {
      throw new Error("Wrangler dry run did not produce worker.js and bundle metadata.");
    }
    const bundle = fs.readFileSync(workerFile);
    const compressed = gzipSync(bundle);
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    const inputCount = Object.keys(meta.inputs ?? {}).length;
    const external = Object.values(meta.inputs ?? {}).flatMap((input) =>
      (input.imports ?? [])
        // `cloudflare:*` is a Worker runtime builtin resolved by workerd.
        .filter(
          (item) =>
            item.external && item.path !== "<runtime>" && !item.path.startsWith("cloudflare:")
        )
        .map((item) => item.path)
    );
    if (external.length) {
      throw new Error("Worker bundle contains unresolved external imports: " + external.join(", "));
    }
    console.log("Cloudflare Worker dry-run bundle evidence:");
    console.log("  entry: cloudflare/worker.ts (wrangler.jsonc)");
    console.log("  bundled inputs: " + inputCount);
    console.log("  bundle bytes: " + bundle.byteLength);
    console.log("  gzip bytes: " + compressed.byteLength);
    console.log("  sha256: " + createHash("sha256").update(bundle).digest("hex"));
    console.log("  deployment: skipped (--dry-run)");
  }
} catch (error) {
  console.error("Cloudflare Worker bundle evidence failed:", error);
  process.exitCode = 1;
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
