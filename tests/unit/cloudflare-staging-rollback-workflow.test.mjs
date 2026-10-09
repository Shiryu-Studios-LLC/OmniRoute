import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  join(process.cwd(), ".github/workflows/rollback-cloudflare-staging.yml"),
  "utf8"
);

test("staging rollback is manual, environment protected, and requires explicit confirmations", () => {
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.doesNotMatch(workflow, /^  pull_request:/m);
  assert.match(workflow, /environment: cloudflare-staging/);
  assert.match(workflow, /confirm_rollback:[\s\S]*?required: true[\s\S]*?type: string/);
  assert.match(workflow, /confirm_data_compatibility:[\s\S]*?required: true[\s\S]*?type: string/);
  assert.match(workflow, /CONFIRM_ROLLBACK" == "rollback-staging"/);
  assert.match(workflow, /CONFIRM_DATA_COMPATIBILITY" == "d1-do-compatible"/);
  assert.match(workflow, /TARGET_VERSION_ID" =~ \^\[\[:xdigit:\]\]\{8\}/);
});

test("rollback verifies the supplied version against the exact staging Worker before rollback", () => {
  const verifyIndex = workflow.indexOf(
    'npx wrangler versions view "$TARGET_VERSION_ID" --name "$STAGING_WORKER_NAME" --json'
  );
  const rollbackIndex = workflow.indexOf('npx wrangler rollback "$TARGET_VERSION_ID"');

  assert.notEqual(verifyIndex, -1);
  assert.notEqual(rollbackIndex, -1);
  assert.ok(verifyIndex < rollbackIndex);
  assert.match(workflow, /STAGING_WORKER_NAME: omniroute-cloud-runtime-staging/);
  assert.match(workflow, /--name "\$STAGING_WORKER_NAME"/);
  assert.match(workflow, /--message "Manual staging rollback to \$TARGET_VERSION_ID"/);
  assert.doesNotMatch(workflow, /wrangler rollback(?![^\n]*TARGET_VERSION_ID)/);
  assert.doesNotMatch(workflow, /wrangler deploy|wrangler d1 migrations apply|wrangler d1 restore/);
  assert.doesNotMatch(workflow, /wrangler rollback[^\n]*(?:production|omniroute\s)/i);
});

test("rollback uses protected staging credentials and does not configure production routes or data bindings", () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.doesNotMatch(
    workflow,
    /CLOUDFLARE_PRODUCTION|omniroute\.shiryu\.org|custom_domains|routes:/i
  );
  assert.doesNotMatch(workflow, /wrangler secret put|wrangler d1|wrangler r2|wrangler deployments/);
});
