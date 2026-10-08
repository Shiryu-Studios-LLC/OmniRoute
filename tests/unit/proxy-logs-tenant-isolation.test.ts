import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-proxy-logs-tenant-db-"));

const proxyLogger = await import("../../src/lib/proxyLogger.ts");
const proxyLogsDb = await import("../../src/lib/db/proxyLogs.ts");
const { getDbInstance } = await import("../../src/lib/db/core.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

test("proxy log reads and clears are tenant scoped", () => {
  asTenant("tenant-proxy-a", () =>
    proxyLogger.logProxyEvent({
      provider: "provider-a",
      account: "private-a",
      connectionId: "conn-a",
      egressIp: "192.0.2.1",
    })
  );
  asTenant("tenant-proxy-b", () =>
    proxyLogger.logProxyEvent({
      provider: "provider-b",
      account: "private-b",
      connectionId: "conn-b",
      egressIp: "192.0.2.2",
    })
  );
  proxyLogger.flushProxyLogsSync();

  assert.deepEqual(
    asTenant("tenant-proxy-a", () => proxyLogger.getProxyLogs()).map((row) => row.account),
    ["private-a"]
  );
  assert.deepEqual(
    asTenant("tenant-proxy-b", () => proxyLogger.getProxyLogs()).map((row) => row.account),
    ["private-b"]
  );
  assert.deepEqual(
    asTenant("tenant-proxy-b", () =>
      proxyLogsDb.exportProxyLogsSince("1970-01-01T00:00:00.000Z")
    ).map((row) => row.account),
    ["private-b"]
  );
  assert.equal(
    asTenant("tenant-proxy-b", () =>
      proxyLogsDb.getRecentEgressIpForConnection("conn-a", "1970-01-01T00:00:00.000Z")
    ),
    null
  );

  asTenant("tenant-proxy-a", () => proxyLogger.clearProxyLogs());
  assert.equal(asTenant("tenant-proxy-a", () => proxyLogger.getProxyLogs()).length, 0);
  assert.equal(asTenant("tenant-proxy-b", () => proxyLogger.getProxyLogs()).length, 1);
  const stored = getDbInstance()
    .prepare("SELECT tenant_id FROM proxy_logs WHERE connection_id = 'conn-b'")
    .get() as { tenant_id: string };
  assert.equal(stored.tenant_id, "tenant-proxy-b");
});
