import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  join(process.cwd(), ".github/workflows/deploy-cloudflare-staging.yml"),
  "utf8"
);

test("Cloudflare staging deployment is manual and requires an explicit staging confirmation", () => {
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.doesNotMatch(workflow, /^  pull_request:/m);
  assert.match(workflow, /confirm_staging:[\s\S]*?required: true[\s\S]*?type: string/);
  assert.match(workflow, /CONFIRM_STAGING" != "deploy-staging"/);
  assert.match(workflow, /environment: cloudflare-staging/);
});

test("staging deploy constructs a staging-only Worker config without production routes", () => {
  assert.match(workflow, /config\.name = "omniroute-cloud-runtime-staging"/);
  assert.match(workflow, /config\.workers_dev = true/);
  assert.match(workflow, /config\.routes = \[\]/);
  assert.match(
    workflow,
    /config\.d1_databases\[0\]\.database_name = "omniroute-cloud-runtime-staging"/
  );
  assert.match(
    workflow,
    /config\.d1_databases\[0\]\.database_id = process\.env\.CLOUDFLARE_STAGING_D1_DATABASE_ID/
  );
  assert.match(
    workflow,
    /if \(config\.routes\?\.length \|\| config\.route \|\| config\.custom_domains\?\.length\)/
  );
  assert.match(workflow, /expectedName = "omniroute-cloud-runtime-staging"/);
  assert.match(workflow, /payload\?\.result\?\.name !== expectedName/);
  assert.match(workflow, /https:\/\/omniroute-cloud-runtime-staging\.\*\.workers\.dev/);
  assert.doesNotMatch(
    workflow,
    /wrangler deploy[^\n]*(?:--env\s+production|--name\s+omniroute(?:\s|$))/i
  );
});

test("staging secret values are piped to Wrangler and never printed or shell-traced", () => {
  const secretNames = [
    "OMNIROUTE_CLOUD_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_MAINTENANCE_TOKEN",
    "OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY",
    "OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY",
  ];

  for (const name of secretNames) {
    assert.match(
      workflow,
      new RegExp(`printf '%s' \\"\\$${name}\\" \\| npx wrangler secret put ${name}`)
    );
    assert.doesNotMatch(workflow, new RegExp(`(?:echo|printf)\\s+(?:\\"|')?\\$${name}(?![\\w])`));
  }

  assert.doesNotMatch(workflow, /^\s*set -x\s*$/m);
  assert.doesNotMatch(workflow, /wrangler secret put[^\n]*--var/);
});
