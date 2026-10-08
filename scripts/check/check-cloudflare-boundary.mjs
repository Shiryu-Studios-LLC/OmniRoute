import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entry = path.join(repoRoot, "cloudflare/worker.ts");
const cloudSourceRoot = path.join(repoRoot, "src/cloud");
const forbiddenBuiltins = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "os",
  "path",
  "sqlite",
  "tls",
  "worker_threads",
]);

const importPattern = /(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g;
const visited = new Set();
const violations = [];

function resolveLocal(specifier, fromFile) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".js",
    base + ".mjs",
    path.join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function inspect(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const source = fs.readFileSync(file, "utf8");
  importPattern.lastIndex = 0;
  let match;
  while ((match = importPattern.exec(source))) {
    const specifier = match[1];
    if (specifier.startsWith("node:")) {
      const builtin = specifier.slice(5);
      if (forbiddenBuiltins.has(builtin)) {
        violations.push(path.relative(repoRoot, file) + " -> " + specifier);
      }
      continue;
    }
    if (forbiddenBuiltins.has(specifier)) {
      violations.push(path.relative(repoRoot, file) + " -> " + specifier);
    }
    const resolved = resolveLocal(specifier, file);
    if (resolved) inspect(resolved);
  }
}

if (!fs.existsSync(entry)) {
  console.error("Missing Cloudflare entry: " + path.relative(repoRoot, entry));
  process.exit(1);
}

inspect(entry);

if (fs.existsSync(cloudSourceRoot)) {
  for (const name of fs.readdirSync(cloudSourceRoot, { withFileTypes: true })) {
    const file = path.join(cloudSourceRoot, name.name);
    if (name.isFile() && /\.(ts|tsx|js|mjs)$/.test(name.name)) inspect(file);
  }
}

if (violations.length) {
  console.error("Cloudflare runtime boundary contains forbidden Node-only imports:");
  for (const violation of violations) console.error("- " + violation);
  process.exit(1);
}

const files = [...visited].map((file) => ({ file, bytes: fs.statSync(file).size }));
const sourceBytes = files.reduce((sum, item) => sum + item.bytes, 0);
console.log(
  "Cloudflare boundary OK: " + files.length + " source files, " + sourceBytes + " source bytes."
);
for (const item of files) {
  console.log("  " + path.relative(repoRoot, item.file) + " (" + item.bytes + " bytes)");
}
