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
    /vpcServices\.push\(\{ binding: "OIDC_EGRESS", service_id: oidcServiceId \}\)/
  );
  assert.match(workflow, /wrangler secret put OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN/);
  assert.match(workflow, /OIDC_EGRESS_EXPECTED/);
  assert.doesNotMatch(workflow, /config\.services\s*=/);
});

test("staging MCP egress requires its own VPC Service, secret, and firewall verification", () => {
  assert.match(workflow, /CLOUDFLARE_STAGING_MCP_EGRESS_SERVICE_ID/);
  assert.match(workflow, /OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN/);
  assert.match(workflow, /CLOUDFLARE_STAGING_MCP_EGRESS_FIREWALL_VERIFIED/);
  assert.match(workflow, /Boolean\(mcpServiceId\) !== Boolean\(mcpToken\)/);
  assert.match(workflow, /mcpServiceId && !mcpFirewallVerified/);
  assert.match(
    workflow,
    /mcpFirewallVerified = process\.env\.CLOUDFLARE_STAGING_MCP_EGRESS_FIREWALL_VERIFIED === "true"/
  );
  assert.match(workflow, /mcpServiceId && mcpServiceId === oidcServiceId/);
  assert.match(workflow, /OMNIROUTE_CLOUD_MCP_EGRESS_ENABLED: mcpServiceId \? "true" : "false"/);
  assert.match(
    workflow,
    /vpcServices\.push\(\{ binding: "MCP_EGRESS", service_id: mcpServiceId \}\)/
  );
  assert.match(workflow, /if \(vpcServices\.length\) config\.vpc_services = vpcServices/);
  assert.match(
    workflow,
    /The MCP egress token must be distinct from every operator, runtime, and OIDC egress secret/
  );
  assert.match(workflow, /if: \$\{\{ vars\.CLOUDFLARE_STAGING_MCP_EGRESS_SERVICE_ID != '' \}\}/);
  assert.match(workflow, /wrangler secret put OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN/);
});

test("staging uses a dedicated provisioning-only credential and rejects owner assertions", () => {
  assert.match(workflow, /OMNIROUTE_CLOUD_PROVISIONING_TOKEN/);
  assert.match(workflow, /operator_token_names=\([^\n]*OMNIROUTE_CLOUD_PROVISIONING_TOKEN/);
  assert.match(workflow, /"OMNIROUTE_CLOUD_PROVISIONING_TOKEN"/);
  assert.match(
    workflow,
    /printf '%s' "\$OMNIROUTE_CLOUD_PROVISIONING_TOKEN" \| npx wrangler secret put OMNIROUTE_CLOUD_PROVISIONING_TOKEN/
  );
  assert.match(
    workflow,
    /provisioning_out_of_scope=.*ownerPrincipalId.*\$STAGING_URL\/__cloud\/v1\/tenants/
  );
  assert.match(workflow, /\[\[ "\$provisioning_out_of_scope" == "403" \]\]/);
});

test("staging credential keyring is validated and bound only when configured", () => {
  assert.match(workflow, /OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON/);
  assert.match(workflow, /OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID/);
  assert.match(workflow, /activeKeyId && !keyringJson/);
  assert.match(workflow, /keys = JSON\.parse\(keyringJson\)/);
  assert.match(workflow, /keys === null \|\| typeof keys !== "object" \|\| Array\.isArray\(keys\)/);
  assert.match(workflow, /A-Za-z0-9_-\]\{1,64\}/);
  assert.match(workflow, /decoded\.byteLength === 32 && decoded\.toString\("base64"\) === value/);
  assert.match(workflow, /activeKeyId && !Object\.hasOwn\(keys, activeKeyId\)/);
  assert.match(workflow, /const runtimeSecretNames = \[/);
  assert.match(workflow, /"OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN"/);
  assert.match(workflow, /"OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY"/);
  assert.match(workflow, /"OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN"/);
  assert.match(workflow, /"OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN"/);
  assert.match(workflow, /runtimeSecretValues\.has\(keyValue\)/);
  assert.match(workflow, /const seenKeys = new Set\(\)/);
  assert.match(workflow, /seenKeys\.has\(keyValue\)/);
  assert.match(
    workflow,
    /if \(credentialEncryptionActiveKeyId\)[\s\S]*config\.vars\.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = credentialEncryptionActiveKeyId/
  );
  assert.match(workflow, /if \[\[ -n "\$OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON" \]\]/);
  assert.match(workflow, /wrangler secret put OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON/);
  assert.doesNotMatch(
    workflow,
    /OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = process\.env\.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID;/
  );
  assert.doesNotMatch(
    workflow,
    /console\.(?:log|error)\([^\n]*(?:keyringJson|keyValue|legacyKey|keys)\)/
  );
});

test("staging verifies the exact R2 artifact bucket before any migration or deployment", () => {
  const r2Check = workflow.indexOf(
    "https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${expectedName}"
  );
  const d1MigrationList = workflow.indexOf("npx wrangler d1 migrations list");
  const d1Migrations = workflow.indexOf("npx wrangler d1 migrations apply");
  const workerDeploy = workflow.indexOf("npx wrangler deploy --config");

  assert.notEqual(r2Check, -1, "the workflow should call the Cloudflare R2 bucket metadata API");
  assert.ok(r2Check < d1MigrationList, "R2 must be verified before inspecting D1 migrations");
  assert.ok(r2Check < d1Migrations, "R2 must be verified before applying D1 migrations");
  assert.ok(r2Check < workerDeploy, "R2 must be verified before deploying the Worker");
  assert.match(workflow, /r2\/buckets\/\$\{expectedName\}[\s\S]*?method: "GET"/);
  assert.match(workflow, /expectedName = "omniroute-cloud-runtime-staging-artifacts"/);
  assert.match(workflow, /payload\?\.result\?\.name !== expectedName/);
  assert.match(workflow, /The dedicated staging R2 artifact bucket is missing; create/);
  assert.match(workflow, /R2 is enabled and the API token has R2 Read permission/);
  assert.match(workflow, /Could not verify the dedicated staging R2 artifact bucket/);
  assert.match(workflow, /Cloudflare returned invalid R2 bucket metadata/);
  assert.doesNotMatch(workflow, /console\.error\(JSON\.stringify\(payload\)\)/);
});

test("staging secret values are piped to Wrangler and never printed or shell-traced", () => {
  const secretNames = [
    "OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_PROVISIONING_TOKEN",
    "OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN",
    "OMNIROUTE_CLOUD_MAINTENANCE_TOKEN",
    "OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY",
    "OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY",
    "OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN",
    "OMNIROUTE_CLOUD_MCP_EGRESS_TOKEN",
    "OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON",
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
