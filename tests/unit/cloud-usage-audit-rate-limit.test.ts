import assert from "node:assert/strict";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "@/cloud/db";
import { appendCloudComplianceAudit, listCloudComplianceAudit } from "@/cloud/complianceAudit";
import { consumeCloudRateLimit } from "@/cloud/rateLimit";
import { appendCloudUsageRecord, listCloudUsageRecords } from "@/cloud/usage";

type Row = Record<string, unknown>;

class MemoryD1 implements CloudDb {
  readonly usage = new Map<string, Row>();
  readonly audits = new Map<string, Row>();
  readonly rateLimits = new Map<string, Row>();

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new MemoryStatement<T>(this, sql);
  }

  async batch() {
    throw new Error("The cloud repositories should not depend on a process-local batch fallback");
  }

  async exec() {
    throw new Error("The cloud repositories should not depend on an in-memory database");
  }

  async first<U>(sql: string, values: unknown[]): Promise<U | null> {
    assert.equal(
      (sql.match(/\?/g) ?? []).length,
      values.length,
      "statement bindings match placeholders"
    );
    if (sql.includes("INSERT INTO cloud_rate_limits")) {
      const [tenantId, bucketHash, nowMs, windowMs, limitCount, ...checks] = values;
      const mapKey = `${tenantId}:${bucketHash}`;
      const existing = this.rateLimits.get(mapKey);
      const stale =
        existing === undefined ||
        existing.window_ms !== windowMs ||
        existing.limit_count !== limitCount ||
        Number(checks[1]) - Number(existing.window_started_at_ms) >= Number(existing.window_ms);
      const next = {
        tenant_id: tenantId,
        bucket_hash: bucketHash,
        window_started_at_ms: stale ? nowMs : existing.window_started_at_ms,
        window_ms: windowMs,
        limit_count: limitCount,
        request_count: stale
          ? 1
          : Math.min(Number(existing.request_count) + 1, Number(limitCount) + 1),
        updated_at: new Date(Number(nowMs)).toISOString(),
      };
      this.rateLimits.set(mapKey, next);
      return {
        request_count: next.request_count,
        window_started_at_ms: next.window_started_at_ms,
        window_ms: next.window_ms,
        limit_count: next.limit_count,
      } as U;
    }
    return null;
  }

  async all<U>(sql: string, values: unknown[]): Promise<{ results: U[]; success: boolean }> {
    assert.equal(
      (sql.match(/\?/g) ?? []).length,
      values.length,
      "statement bindings match placeholders"
    );
    if (sql.startsWith("SELECT * FROM cloud_usage_history")) {
      const tenantId = values[0];
      const rows = [...this.usage.values()].filter((row) => row.tenant_id === tenantId);
      return { results: rows as U[], success: true };
    }
    if (sql.startsWith("SELECT * FROM cloud_compliance_audit")) {
      const tenantId = values[0];
      const rows = [...this.audits.values()].filter((row) => row.tenant_id === tenantId);
      return { results: rows as U[], success: true };
    }
    if (sql.includes("INSERT INTO cloud_rate_limits")) {
      const row = await this.first<U>(sql, values);
      return { results: row ? [row] : [], success: true };
    }
    return { results: [], success: true };
  }

  async run(sql: string, values: unknown[]) {
    assert.equal(
      (sql.match(/\?/g) ?? []).length,
      values.length,
      "statement bindings match placeholders"
    );
    if (sql.startsWith("INSERT INTO cloud_usage_history")) {
      const [
        id,
        tenant_id,
        provider,
        model,
        connection_id,
        api_key_id,
        api_key_name,
        tokens_input,
        tokens_output,
        tokens_cache_read,
        tokens_cache_creation,
        tokens_reasoning,
        service_tier,
        status,
        success,
        latency_ms,
        ttft_ms,
        error_code,
        combo_strategy,
        endpoint,
        timestamp,
      ] = values;
      this.usage.set(`${tenant_id}:${id}`, {
        id,
        tenant_id,
        provider,
        model,
        connection_id,
        api_key_id,
        api_key_name,
        tokens_input,
        tokens_output,
        tokens_cache_read,
        tokens_cache_creation,
        tokens_reasoning,
        service_tier,
        status,
        success,
        latency_ms,
        ttft_ms,
        error_code,
        combo_strategy,
        endpoint,
        timestamp,
      });
      return { success: true };
    }
    if (sql.startsWith("INSERT INTO cloud_compliance_audit")) {
      const [
        id,
        tenant_id,
        timestamp,
        action,
        actor,
        target,
        details_json,
        ip_address,
        resource_type,
        status,
        request_id,
        metadata_json,
      ] = values;
      this.audits.set(`${tenant_id}:${id}`, {
        id,
        tenant_id,
        timestamp,
        action,
        actor,
        target,
        details_json,
        ip_address,
        resource_type,
        status,
        request_id,
        metadata_json,
      });
      return { success: true };
    }
    return { success: true };
  }
}

class MemoryStatement<T = unknown> implements CloudDbStatement<T> {
  constructor(
    private readonly db: MemoryD1,
    private readonly sql: string,
    private readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]) {
    return new MemoryStatement<T>(this.db, this.sql, values);
  }

  first<U = T>() {
    return this.db.first<U>(this.sql, this.values);
  }

  all<U = T>() {
    return this.db.all<U>(this.sql, this.values);
  }

  run() {
    return this.db.run(this.sql, this.values);
  }
}

test("D1 usage history requires tenant scope and keeps tenant A/B rows separate", async () => {
  const db = new MemoryD1();
  const timestamp = "2026-10-08T12:00:00.000Z";
  await appendCloudUsageRecord(db, {
    id: "usage-a",
    tenantId: "tenant-a",
    provider: "openai",
    model: "model-a",
    tokensInput: 120,
    tokensOutput: 40,
    latencyMs: 175,
    endpoint: "/v1/chat/completions?api_key=secret-value",
    timestamp,
  });
  await appendCloudUsageRecord(db, {
    id: "usage-b",
    tenantId: "tenant-b",
    provider: "openai",
    model: "model-b",
    tokensInput: 900,
    timestamp,
  });

  const rowsA = await listCloudUsageRecords(db, "tenant-a");
  assert.equal(rowsA.length, 1);
  assert.equal(rowsA[0].id, "usage-a");
  assert.equal(rowsA[0].tokensInput, 120);
  assert.equal(rowsA[0].endpoint, "/v1/chat/completions");
  assert.equal((await listCloudUsageRecords(db, "tenant-b"))[0].id, "usage-b");
  await assert.rejects(
    appendCloudUsageRecord(db, {
      id: "usage-invalid",
      tenantId: "tenant-a",
      tokensInput: -1,
      timestamp,
    }),
    /non-negative safe integer/
  );
  await assert.rejects(listCloudUsageRecords(db, "tenant-a", { limit: 501 }), /between 1 and 500/);
});

test("D1 compliance audit is tenant-scoped and scrubs sensitive metadata", async () => {
  const db = new MemoryD1();
  await appendCloudComplianceAudit(db, {
    id: "audit-a",
    tenantId: "tenant-a",
    action: "provider.connection.create",
    actor: "admin-a",
    details: {
      apiKey: "plaintext-secret",
      resource: "provider-connection",
      prompt: "private request text",
    },
    metadata: { authorization: "Bearer super-secret", note: "enc:v1:abcdef:012345" },
  });
  await appendCloudComplianceAudit(db, {
    id: "audit-b",
    tenantId: "tenant-b",
    action: "provider.connection.create",
  });

  const auditA = await listCloudComplianceAudit(db, "tenant-a");
  assert.equal(auditA.length, 1);
  assert.deepEqual(auditA[0].details, {
    apiKey: "[redacted]",
    resource: "provider-connection",
    prompt: "[redacted]",
  });
  assert.deepEqual(auditA[0].metadata, {
    authorization: "[redacted]",
    note: "[redacted]",
  });
  assert.equal((await listCloudComplianceAudit(db, "tenant-b"))[0].id, "audit-b");
  await assert.rejects(
    appendCloudComplianceAudit(db, {
      id: "audit-too-large",
      tenantId: "tenant-a",
      action: "test",
      metadata: { data: "x".repeat(40_000) },
    }),
    /characters/
  );
  await assert.rejects(
    appendCloudComplianceAudit(db, {
      id: "audit-over-budget",
      tenantId: "tenant-a",
      action: "test",
      metadata: Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`field-${index}`, "x".repeat(1_700)])
      ),
    }),
    /byte limit/
  );
});

test("D1 rate limits use hashed tenant buckets, cap increments, and reset safely", async () => {
  const db = new MemoryD1();
  const first = await consumeCloudRateLimit(db, {
    tenantId: "tenant-a",
    bucketKey: "route:chat",
    limit: 2,
    windowMs: 1_000,
    nowMs: 100,
  });
  const second = await consumeCloudRateLimit(db, {
    tenantId: "tenant-a",
    bucketKey: "route:chat",
    limit: 2,
    windowMs: 1_000,
    nowMs: 101,
  });
  const denied = await consumeCloudRateLimit(db, {
    tenantId: "tenant-a",
    bucketKey: "route:chat",
    limit: 2,
    windowMs: 1_000,
    nowMs: 102,
  });
  const tenantB = await consumeCloudRateLimit(db, {
    tenantId: "tenant-b",
    bucketKey: "route:chat",
    limit: 2,
    windowMs: 1_000,
    nowMs: 102,
  });
  const reset = await consumeCloudRateLimit(db, {
    tenantId: "tenant-a",
    bucketKey: "route:chat",
    limit: 2,
    windowMs: 1_000,
    nowMs: 1_100,
  });
  const clockRollback = await consumeCloudRateLimit(db, {
    tenantId: "tenant-a",
    bucketKey: "route:chat",
    limit: 2,
    windowMs: 1_000,
    nowMs: 1_050,
  });

  assert.equal(first.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(denied.allowed, false);
  assert.equal(denied.count, 3);
  assert.equal(tenantB.count, 1);
  assert.equal(reset.count, 1);
  assert.equal(reset.resetAtMs, 2_100);
  assert.equal(clockRollback.allowed, true);
  assert.equal(clockRollback.count, 2);
  assert.equal(clockRollback.windowStartedAtMs, 1_100);
  assert.equal([...db.rateLimits.values()][0].bucket_hash === "route:chat", false);
  await assert.rejects(
    consumeCloudRateLimit(db, {
      tenantId: "tenant-a",
      bucketKey: "route:chat",
      limit: 0,
      windowMs: 1_000,
      nowMs: 1_101,
    }),
    /limit must be/
  );
});
