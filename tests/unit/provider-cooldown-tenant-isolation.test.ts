import test from "node:test";
import assert from "node:assert/strict";

import { runWithTenantContext } from "../../src/lib/tenantContext.ts";
import {
  clearCooldownState,
  isProviderInCooldown,
  recordProviderCooldown,
} from "../../open-sse/services/providerCooldownTracker.ts";

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

test.beforeEach(() => clearCooldownState());
test.after(() => clearCooldownState());

test("provider and connection cooldowns are isolated between tenants", () => {
  asTenant("tenant_a", () => {
    recordProviderCooldown("shared-provider", undefined);
    recordProviderCooldown("shared-provider", "shared-connection-id");
  });

  assert.equal(
    asTenant("tenant_a", () => isProviderInCooldown("shared-provider", undefined)),
    true
  );
  assert.equal(
    asTenant("tenant_a", () => isProviderInCooldown("shared-provider", "shared-connection-id")),
    true
  );
  assert.equal(
    asTenant("tenant_b", () => isProviderInCooldown("shared-provider", undefined)),
    false
  );
  assert.equal(
    asTenant("tenant_b", () => isProviderInCooldown("shared-provider", "shared-connection-id")),
    false
  );
});
