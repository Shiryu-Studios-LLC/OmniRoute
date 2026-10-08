import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tenant-call-analytics-"));
process.env.DATA_DIR = DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const callLogStats = await import("../../src/lib/db/callLogStats.ts");
const providerStats = await import("../../src/lib/db/providerStats.ts");
const { runWithTenantContext } = await import("../../src/lib/tenantContext.ts");

function asTenant<T>(tenantId: string, callback: () => T): T {
  return runWithTenantContext({ tenantId, role: "owner" }, callback);
}

function insertCallLog(row: {
  id: string;
  tenantId: string;
  timestamp: string;
  status: number;
  model?: string;
  requestedModel?: string;
  provider?: string;
  requestType?: string;
  requestSummary?: string;
  errorSummary?: string;
  errorType?: string;
}) {
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO call_logs (
         id, tenant_id, timestamp, method, path, status, model, requested_model,
         provider, duration, tokens_in, tokens_out, request_type, request_summary,
         error_summary, error_type, detail_state, has_request_body,
         has_response_body, has_pipeline_details
       ) VALUES (?, ?, ?, 'POST', '/v1/test', ?, ?, ?, ?, 100, 10, 20, ?, ?, ?, ?, 'none', 0, 0, 0)`
    )
    .run(
      row.id,
      row.tenantId,
      row.timestamp,
      row.status,
      row.model ?? "gpt-4",
      row.requestedModel ?? "gpt-4",
      row.provider ?? "openai",
      row.requestType ?? null,
      row.requestSummary ?? null,
      row.errorSummary ?? null,
      row.errorType ?? null
    );
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  for (const tenantId of ["tenant_a", "tenant_b"]) {
    db.prepare(
      "INSERT INTO provider_connections (id, tenant_id, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      `conn-${tenantId}`,
      tenantId,
      tenantId === "tenant_a" ? "tenant_a_provider" : "tenant_b_provider",
      now,
      now
    );
    db.prepare(
      "INSERT INTO provider_nodes (id, tenant_id, type, name, prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      `${tenantId}_provider`,
      tenantId,
      "custom",
      `Provider ${tenantId}`,
      `${tenantId}_provider`,
      now,
      now
    );
  }

  insertCallLog({
    id: "call-a-old",
    tenantId: "tenant_a",
    provider: "tenant_a_provider",
    timestamp: "2026-01-01T00:00:00.000Z",
    status: 200,
    requestType: "search",
    requestSummary: JSON.stringify({ query: "tenant A private query", filters: { region: "A" } }),
  });
  insertCallLog({
    id: "call-b-new",
    tenantId: "tenant_b",
    provider: "tenant_b_provider",
    timestamp: "2026-01-02T00:00:00.000Z",
    status: 503,
    model: "gpt-4-mini",
    requestedModel: "gpt-4",
    requestType: "search",
    requestSummary: JSON.stringify({ query: "tenant B private query", filters: { region: "B" } }),
    errorSummary: "upstream failure",
    errorType: "upstream",
  });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("call-log provider, search, fallback and error analytics stay within tenant context", () => {
  const since = "2025-01-01T00:00:00.000Z";

  const tenantAProvider = asTenant("tenant_a", () => callLogStats.getProviderMetrics());
  const tenantBProvider = asTenant("tenant_b", () => callLogStats.getProviderMetrics());
  assert.equal(tenantAProvider[0].totalRequests, 1);
  assert.equal(tenantAProvider[0].lastStatus, 200);
  assert.equal(tenantBProvider[0].totalRequests, 1);
  assert.equal(tenantBProvider[0].lastStatus, 503);

  assert.equal(
    asTenant("tenant_a", () => callLogStats.getProviderUsageSince(since))[0].requests,
    1
  );
  assert.equal(
    asTenant("tenant_b", () => callLogStats.getProviderUsageSince(since))[0].requests,
    1
  );

  assert.equal(asTenant("tenant_a", () => callLogStats.getSearchProviderStats())[0].requests, 1);
  assert.equal(asTenant("tenant_b", () => callLogStats.getSearchProviderStats())[0].requests, 1);
  assert.match(
    asTenant("tenant_a", () => callLogStats.getRecentSearchLogs())[0].request_summary ?? "",
    /tenant A private query/
  );
  assert.doesNotMatch(
    asTenant("tenant_a", () => callLogStats.getRecentSearchLogs())[0].request_summary ?? "",
    /tenant B private query/
  );

  const tenantAStats = asTenant("tenant_a", () =>
    callLogStats.getSearchAggregateStats("2026-01-01T00:00:00.000Z")
  );
  const tenantBStats = asTenant("tenant_b", () =>
    callLogStats.getSearchAggregateStats("2026-01-01T00:00:00.000Z")
  );
  assert.equal(tenantAStats.total, 1);
  assert.equal(tenantAStats.errors, 0);
  assert.equal(tenantBStats.total, 1);
  assert.equal(tenantBStats.errors, 1);
  assert.equal(asTenant("tenant_a", () => callLogStats.getSearchProviderCounts())[0].cnt, 1);
  assert.equal(asTenant("tenant_b", () => callLogStats.getSearchProviderCounts())[0].cnt, 1);

  assert.equal(asTenant("tenant_a", () => callLogStats.getFallbackStats("", {})).fallbacks, 0);
  assert.equal(asTenant("tenant_b", () => callLogStats.getFallbackStats("", {})).fallbacks, 1);
  assert.deepEqual(
    asTenant("tenant_a", () => callLogStats.getErrorTypeBreakdown("", {})),
    []
  );
  assert.deepEqual(
    asTenant("tenant_b", () => callLogStats.getErrorTypeBreakdown("", {})),
    [{ errorType: "upstream", count: 1 }]
  );
});

test("provider and model call stats only join nodes belonging to the current tenant", () => {
  const tenantAProvider = asTenant("tenant_a", () => providerStats.getProviderCallStats());
  const tenantBProvider = asTenant("tenant_b", () => providerStats.getProviderCallStats());
  assert.equal(tenantAProvider.length, 1);
  assert.equal(tenantAProvider[0].totalRequests, 1);
  assert.equal(tenantAProvider[0].nodeName, "Provider tenant_a");
  assert.equal(tenantBProvider.length, 1);
  assert.equal(tenantBProvider[0].totalRequests, 1);
  assert.equal(tenantBProvider[0].nodeName, "Provider tenant_b");

  const tenantAModels = asTenant("tenant_a", () => providerStats.getModelCallStats());
  const tenantBModels = asTenant("tenant_b", () => providerStats.getModelCallStats());
  assert.equal(tenantAModels.length, 1);
  assert.equal(tenantAModels[0].requests, 1);
  assert.equal(tenantAModels[0].nodeName, "Provider tenant_a");
  assert.equal(tenantBModels.length, 1);
  assert.equal(tenantBModels[0].requests, 1);
  assert.equal(tenantBModels[0].nodeName, "Provider tenant_b");
});
