import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  join(process.cwd(), ".github/workflows/deploy-cloudflare-staging.yml"),
  "utf8"
);
const wranglerConfig = JSON.parse(
  readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8").replace(/,\s*([}\]])/g, "$1")
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
  assert.equal(wranglerConfig.vars?.OMNIROUTE_ENV, "production");
  assert.equal(
    wranglerConfig.vpc_services,
    undefined,
    "production config must not bind staging OIDC egress"
  );
  assert.match(workflow, /"vars"/);
  assert.match(workflow, /OMNIROUTE_ENV: "staging"/);
  assert.match(workflow, /config\.name = "omniroute-cloud-runtime-staging"/);
  assert.match(workflow, /config\.workers_dev = true/);
  assert.match(workflow, /config\.routes = \[\]/);
  assert.deepEqual(wranglerConfig.r2_buckets, [
    {
      binding: "GATEWAY_ARTIFACTS",
      bucket_name: "omniroute-cloud-gateway-artifacts",
      preview_bucket_name: "omniroute-cloud-gateway-artifacts-preview",
    },
  ]);
  assert.match(workflow, /Expected exactly one private R2 image-artifact binding/);
  assert.match(workflow, /artifactBucket\.binding !== "GATEWAY_ARTIFACTS"/);
  assert.match(
    workflow,
    /config\.r2_buckets\[0\]\.bucket_name = "omniroute-cloud-runtime-staging-artifacts"/
  );
  assert.match(
    workflow,
    /config\.r2_buckets\[0\]\.preview_bucket_name = "omniroute-cloud-runtime-staging-artifacts-preview"/
  );
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

test("staging OIDC egress stays off unless a dedicated VPC Service and token are supplied", () => {
  assert.match(workflow, /"vpc_services"/);
  assert.match(workflow, /CLOUDFLARE_STAGING_OIDC_EGRESS_SERVICE_ID/);
  assert.match(workflow, /OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN/);
  assert.match(workflow, /Boolean\(oidcServiceId\) !== Boolean\(oidcToken\)/);
  assert.match(
    workflow,
    /config\.vars[\s\S]*OMNIROUTE_CLOUD_OIDC_EGRESS_ENABLED: oidcServiceId \? "true" : "false"/
  );
  assert.match(
    workflow,
    /config\.vpc_services = \[\{ binding: "OIDC_EGRESS", service_id: oidcServiceId \}\]/
  );
  assert.match(workflow, /wrangler secret put OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN/);
  assert.match(workflow, /OIDC_EGRESS_EXPECTED/);
  assert.doesNotMatch(workflow, /config\.services\s*=/);
});

test("staging secret values are piped to Wrangler and never printed or shell-traced", () => {
  const secretNames = [
    "OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_MAINTENANCE_TOKEN",
    "OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY",
    "OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY",
    "OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN",
  ];

  for (const name of secretNames) {
    assert.match(
      workflow,
      new RegExp(`printf '%s' \\"\\$${name}\\" \\| npx wrangler secret put ${name}`)
    );
    assert.doesNotMatch(workflow, new RegExp(`(?:echo|printf)\\s+(?:\\"|')?\\$${name}(?![\\w])`));
  }

  assert.doesNotMatch(workflow, /OMNIROUTE_CLOUD_ADMIN_TOKEN/);
  assert.doesNotMatch(workflow, /^\s*set -x\s*$/m);
  assert.doesNotMatch(workflow, /wrangler secret put[^\n]*--var/);
});
