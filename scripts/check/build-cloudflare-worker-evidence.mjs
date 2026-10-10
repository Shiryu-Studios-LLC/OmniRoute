import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wranglerBin = fs.realpathSync(path.join(repoRoot, "node_modules/.bin/wrangler"));
const builds = [];

function buildWorker(index) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `omniroute-cloudflare-worker-${index}-`));
  try {
    const metaFile = path.join(outputDir, "bundle-meta.json");
    const result = spawnSync(
      process.execPath,
      [wranglerBin, "deploy", "--dry-run", "--outdir", outputDir, "--metafile", metaFile],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(`Wrangler dry run ${index} failed with status ${result.status ?? "unknown"}`);
    }
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
    return {
      inputCount,
      bundleBytes: bundle.byteLength,
      gzipBytes: compressed.byteLength,
      sha256: createHash("sha256").update(bundle).digest("hex"),
    };
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

try {
  builds.push(buildWorker(1));
  builds.push(buildWorker(2));
  if (JSON.stringify(builds[0]) !== JSON.stringify(builds[1])) {
    throw new Error(
      `Cloudflare Worker dry-run output is not reproducible: ${JSON.stringify(builds)}`
    );
  }
  const evidence = builds[0];
  console.log("Cloudflare Worker reproducible dry-run bundle evidence:");
  console.log("  entry: cloudflare/worker.ts (wrangler.jsonc)");
  console.log("  repeat builds: 2 (identical)");
  console.log("  bundled inputs: " + evidence.inputCount);
  console.log("  bundle bytes: " + evidence.bundleBytes);
  console.log("  gzip bytes: " + evidence.gzipBytes);
  console.log("  sha256: " + evidence.sha256);
  console.log("  deployment: skipped (--dry-run)");
} catch (error) {
  console.error("Cloudflare Worker bundle evidence failed:", error);
  process.exitCode = 1;
}
