import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { handleCloudApiRequest } from "../../src/cloud/httpApi";
import { reserveCloudInferenceTokens } from "../../src/cloud/inferencePolicy";

const ADMIN_TOKEN = "test-inference-admin-secret";
const MAINTENANCE_TOKEN = "test-inference-maintenance-secret";
const NOW = "2026-10-08T12:00:00.000Z";

class SqliteStatement<T = unknown> implements CloudDbStatement<T> {
  private values: unknown[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): CloudDbStatement<T> {
    this.values = values;
    return this;
  }

  async first<U = T>(): Promise<U | null> {
    return (
      (this.db
        .prepare(this.sql)
        .get(...(this.values as (null | number | bigint | string | Uint8Array)[])) as
        U | undefined) ?? null
    );
  }

  async all<U = T>(): Promise<{ results: U[]; success: boolean }> {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...(this.values as (null | number | bigint | string | Uint8Array)[])) as U[],
      success: true,
    };
  }

  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    const result = this.db
      .prepare(this.sql)
      .run(...(this.values as (null | number | bigint | string | Uint8Array)[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteCloudDb implements CloudDb {
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new SqliteStatement<T>(this.db, sql);
  }

  async batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<unknown> {
    return this.db.exec(sql);
  }
}

async function makeDb(): Promise<SqliteCloudDb> {
  const db = new SqliteCloudDb();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0010_cloud_inference_policy.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  for (const [id, name, slug] of [
    ["tenant-a", "Tenant A", "tenant-a"],
    ["tenant-b", "Tenant B", "tenant-b"],
  ]) {
    await db
      .prepare(
        `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'customer', 1, ?, ?)`
      )
      .bind(id, name, slug, NOW, NOW)
      .run();
  }
  return db;
}

function request(
  path: string,
  input: { method?: string; token?: string; body?: unknown } = {}
): Request {
  const headers = new Headers();
  if (input.token) headers.set("Authorization", `Bearer ${input.token}`);
  if (input.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`https://omniroute.test/__cloud/v1/tenants/${path}`, {
    method: input.method ?? "GET",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

function app(db: CloudDb) {
  return (requestValue: Request) =>
    handleCloudApiRequest(requestValue, {
      db,
      adminToken: ADMIN_TOKEN,
      maintenanceToken: MAINTENANCE_TOKEN,
      now: () => new Date(NOW),
    });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("inference policy management is available only to the server-side admin token", async () => {
  const db = await makeDb();
  try {
    const run = app(db);
    const path = "tenant-a/inference-entitlements";
    assert.equal((await run(request(path))).status, 401);
    assert.equal((await run(request(path, { token: MAINTENANCE_TOKEN }))).status, 401);
    assert.equal(
      (await run(request(path, { method: "PUT", token: MAINTENANCE_TOKEN, body: {} }))).status,
      401
    );
    assert.equal(
      (await run(request(path, { token: ADMIN_TOKEN }))).status,
      200,
      "the admin token can inspect tenant policy"
    );
    assert.equal(
      (await run(request("tenant_shiryu_admin/inference-budget", { token: ADMIN_TOKEN }))).status,
      404,
      "inference policy cannot be configured on the platform tenant"
    );
  } finally {
    db.db.close();
  }
});

test("admin can configure tenant entitlements and monthly token budgets with mutation audit", async () => {
  const db = await makeDb();
  try {
    const run = app(db);
    const entitlementPath = "tenant-a/inference-entitlements";
    const before = await json(await run(request(entitlementPath, { token: ADMIN_TOKEN })));
    assert.deepEqual(before, []);

    const configured = await run(
      request(entitlementPath, {
        method: "PUT",
        token: ADMIN_TOKEN,
        body: {
          provider: "openai",
          model: "gpt-4o-mini",
          enabled: true,
          maxInputTokens: 8000,
          maxOutputTokens: 2000,
        },
      })
    );
    assert.equal(configured.status, 200);
    const entitlement = await json(configured);
    assert.equal(entitlement.enabled, true);
    assert.equal(entitlement.provider, "openai");
    assert.equal(entitlement.model, "gpt-4o-mini");

    const budgetWrite = await run(
      request("tenant-a/inference-budget", {
        method: "PUT",
        token: ADMIN_TOKEN,
        body: { monthlyTokenLimit: 100_000 },
      })
    );
    assert.equal(budgetWrite.status, 200);
    assert.equal((await json(budgetWrite)).monthlyTokenLimit, 100_000);

    const budgetRead = await json(
      await run(request("tenant-a/inference-budget", { token: ADMIN_TOKEN }))
    );
    assert.equal(budgetRead.consumedTokens, 0);
    assert.equal(budgetRead.remainingTokens, 100_000);

    const tenantB = await json(
      await run(request("tenant-b/inference-entitlements", { token: ADMIN_TOKEN }))
    );
    assert.deepEqual(tenantB, [], "tenant policy stays isolated");
    const tenantBBudget = await json(
      await run(request("tenant-b/inference-budget", { token: ADMIN_TOKEN }))
    );
    assert.equal(tenantBBudget.monthlyTokenLimit, null);

    const audit = db.db
      .prepare(
        `SELECT tenant_id, action, actor, target, status, metadata_json
           FROM cloud_compliance_audit
          WHERE action LIKE 'cloud.inference.%'
          ORDER BY action`
      )
      .all() as Array<{
      tenant_id: string;
      action: string;
      actor: string;
      target: string;
      status: string;
      metadata_json: string;
    }>;
    assert.equal(audit.length, 2);
    assert.deepEqual(
      audit.map((row) => ({
        tenantId: row.tenant_id,
        action: row.action,
        actor: row.actor,
        target: row.target,
        status: row.status,
      })),
      [
        {
          tenantId: "tenant-a",
          action: "cloud.inference.budget.configure",
          actor: "cloud-admin",
          target: "monthly-token-budget",
          status: "success",
        },
        {
          tenantId: "tenant-a",
          action: "cloud.inference.entitlement.configure",
          actor: "cloud-admin",
          target: "openai/gpt-4o-mini",
          status: "success",
        },
      ]
    );
    assert.equal(
      audit.some((row) => row.metadata_json.includes("secret")),
      false
    );
  } finally {
    db.db.close();
  }
});

test("admin API validates policy fields, rejects tenant overrides, and keeps token language explicit", async () => {
  const db = await makeDb();
  try {
    const run = app(db);
    const path = "tenant-a/inference-entitlements";
    const invalidBodies = [
      {
        provider: "https://provider.example",
        model: "gpt-4o-mini",
        enabled: true,
        maxInputTokens: 1,
        maxOutputTokens: 1,
      },
      {
        provider: "openai",
        model: "gpt-4o-mini",
        enabled: true,
        maxInputTokens: -1,
        maxOutputTokens: 1,
      },
      {
        provider: "openai",
        model: "gpt-4o-mini",
        enabled: true,
        maxInputTokens: 1,
        maxOutputTokens: Number.MAX_SAFE_INTEGER + 1,
      },
      {
        provider: "openai",
        model: "gpt-4o-mini",
        enabled: true,
        maxInputTokens: 1,
        maxOutputTokens: 1,
        tenantId: "tenant-b",
      },
    ];
    for (const body of invalidBodies) {
      assert.equal(
        (await run(request(path, { method: "PUT", token: ADMIN_TOKEN, body }))).status,
        400
      );
    }
    assert.equal(
      (
        await run(
          request("tenant-a/inference-budget", {
            method: "PUT",
            token: ADMIN_TOKEN,
            body: { monthlyTokenLimit: 100, provider: "openai" },
          })
        )
      ).status,
      400,
      "unknown budget fields are rejected"
    );
    assert.equal(
      (
        await run(
          request("tenant-a/inference-budget", {
            method: "PUT",
            token: ADMIN_TOKEN,
            body: { monthlyTokenLimit: -1 },
          })
        )
      ).status,
      400
    );
    assert.equal(
      db.db.prepare("SELECT COUNT(*) AS count FROM cloud_inference_entitlements").get()?.count,
      0,
      "invalid requests do not create entitlements"
    );
  } finally {
    db.db.close();
  }
});

test("admin configuration flows into tenant-scoped token reservation only", async () => {
  const db = await makeDb();
  try {
    const run = app(db);
    await run(
      request("tenant-a/inference-entitlements", {
        method: "PUT",
        token: ADMIN_TOKEN,
        body: {
          provider: "openai",
          model: "gpt-4o-mini",
          enabled: true,
          maxInputTokens: 100,
          maxOutputTokens: 50,
        },
      })
    );
    await run(
      request("tenant-a/inference-budget", {
        method: "PUT",
        token: ADMIN_TOKEN,
        body: { monthlyTokenLimit: 120 },
      })
    );

    assert.equal(
      (
        await reserveCloudInferenceTokens(db, {
          tenantId: "tenant-a",
          reservationId: "admin-route-reservation",
          provider: "openai",
          model: "gpt-4o-mini",
          inputTokens: 80,
          maxOutputTokens: 40,
          now: NOW,
        })
      ).kind,
      "reserved"
    );
    assert.equal(
      (
        await reserveCloudInferenceTokens(db, {
          tenantId: "tenant-a",
          reservationId: "over-budget-reservation",
          provider: "openai",
          model: "gpt-4o-mini",
          inputTokens: 1,
          maxOutputTokens: 1,
          now: NOW,
        })
      ).kind,
      "denied"
    );
    const status = await json(
      await run(request("tenant-a/inference-budget", { token: ADMIN_TOKEN }))
    );
    assert.equal(status.reservedTokens, 120);
    assert.equal(status.remainingTokens, 0);
  } finally {
    db.db.close();
  }
});
