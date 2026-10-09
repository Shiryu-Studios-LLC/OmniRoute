import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  join(process.cwd(), ".github/workflows/cloudflare-worker-check.yml"),
  "utf8"
);

test("Cloudflare Worker build validation runs for pushes, pull requests, and manual checks", () => {
  assert.match(workflow, /^  push:/m);
  assert.match(workflow, /^  pull_request:/m);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /run: npm run cloudflare:build/);
  assert.match(workflow, /run: npm run check:migration-numbering/);
});

test("Cloudflare Worker CI has read-only permissions and never deploys or needs secrets", () => {
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /wrangler deploy|cloudflare:open-next:build/i);
});
