import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeWorkerGraph } from "../../scripts/check/check-cloudflare-boundary.mjs";

function withFixture(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-worker-graph-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return run(root, path.join(root, "worker.ts"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Worker graph follows runtime imports and ignores type-only imports", () => {
  withFixture(
    {
      "worker.ts":
        'import type { LocalType } from "./types";\nimport { run } from "./runtime";\nrun();',
      "runtime.ts": "export function run() {}",
      "types.ts": 'import fs from "node:fs"; export type LocalType = typeof fs;',
    },
    (root, entry) => {
      const result = analyzeWorkerGraph(root, entry);
      assert.deepEqual(result.violations, []);
      assert.equal(result.files.length, 2);
    }
  );
});

test("Worker graph rejects Node builtins, process globals, and native packages", () => {
  withFixture(
    {
      "worker.ts": 'import "./runtime";',
      "runtime.ts":
        'import fs from "node:fs/promises"; import "better-sqlite3"; export const pid = process.pid;',
    },
    (root, entry) => {
      const result = analyzeWorkerGraph(root, entry);
      assert.equal(result.violations.length, 3);
      assert.ok(result.violations.some((item) => item.includes("node:fs/promises")));
      assert.ok(result.violations.some((item) => item.includes("native package better-sqlite3")));
      assert.ok(result.violations.some((item) => item.includes("process global")));
    }
  );
});

test("Worker graph rejects native binary paths and non-literal runtime loads", () => {
  withFixture(
    {
      "worker.ts": 'import "./runtime";',
      "runtime.ts":
        'import "./binding.node"; const moduleName = "node:fs"; require(moduleName); globalThis.process.exitCode = 1;',
    },
    (root, entry) => {
      const result = analyzeWorkerGraph(root, entry);
      assert.equal(result.violations.length, 3);
      assert.ok(result.violations.some((item) => item.includes("binding.node")));
      assert.ok(result.violations.some((item) => item.includes("non-literal require()")));
      assert.ok(result.violations.some((item) => item.includes("process global")));
    }
  );
});

test("production Worker graph includes only the Worker MCP adapter, never the Node egress proxy", () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const entry = path.join(repoRoot, "cloudflare/worker.ts");
  const result = analyzeWorkerGraph(repoRoot, entry);
  const relativeFiles = result.files.map(({ file }) => path.relative(repoRoot, file));

  assert.deepEqual(result.violations, []);
  assert.ok(relativeFiles.includes("src/cloud/mcpEgressTransport.ts"));
  assert.ok(!relativeFiles.some((file) => file.startsWith("cloudflare/mcp-egress-proxy/")));
});
