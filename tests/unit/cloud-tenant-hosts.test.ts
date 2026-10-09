import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { provisionCloudCustomer } from "../../src/cloud/provisioning";
import { createCloudRuntime } from "../../src/cloud/runtime";
import { setCloudCustomerTenantActive } from "../../src/cloud/tenants";
import { listAdminVerifiedCustomerHosts } from "../../src/cloud/tenantHosts";

const ADMIN_TOKEN = "test-cloud-admin-token";

class Statement<T = unknown> implements CloudDbStatement<T> {
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
  async all<U = T>() {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...(this.values as (null | number | bigint | string | Uint8Array)[])) as U[],
      success: true,
    };
  }
  async run() {
    const result = this.db
      .prepare(this.sql)
      .run(...(this.values as (null | number | bigint | string | Uint8Array)[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class TestD1 implements CloudDb {
  readonly db = new DatabaseSync(":memory:");
  constructor() {
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new Statement<T>(this.db, sql);
  }
  async batch(statements: CloudDbStatement[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async exec(sql: string) {
    return this.db.exec(sql);
  }
}

async function migratedDb() {
  const db = new TestD1();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0005_cloud_customer_identity.sql",
    "0008_cloud_tenant_settings.sql",
    "0023_cloud_tenant_business_profiles.sql",
    "0024_cloud_tenant_business_profile_configuration.sql",
    "0025_verified_customer_hosts.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  return db;
}

test("verified exact-host resolution is D1-backed, tenant-bound, and credential free", async () => {
  const db = await migratedDb();
  try {
    const a = await provisionCloudCustomer(db, {
      id: "host-tenant-a",
      name: "Host Tenant A",
      slug: "host-tenant-a",
      ownerPrincipalId: "owner-a",
      now: "2026-10-09T12:00:00.000Z",
    });
    const b = await provisionCloudCustomer(db, {
      id: "host-tenant-b",
      name: "Host Tenant B",
      slug: "host-tenant-b",
      ownerPrincipalId: "owner-b",
      now: "2026-10-09T12:00:00.000Z",
    });
    const app = createCloudRuntime({
      env: { DB: db, OMNIROUTE_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN },
      now: () => new Date("2026-10-09T12:01:00.000Z"),
    });
    const admin = (path: string, method: string, body?: unknown) =>
      app.fetch(
        new Request(`https://omniroute.test${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );

    const missingBeforeRegistration = await app.fetch(
      new Request(
        "https://omniroute.test/__cloud/v1/tenant-hosts/resolve?hostname=front-a.example.test"
      )
    );
    assert.equal(missingBeforeRegistration.status, 404);

    const registeredA = await admin("/__cloud/v1/tenant-hosts", "POST", {
      tenantId: a.tenant.id,
      hostname: "Front-A.Example.Test.",
    });
    assert.equal(registeredA.status, 201, await registeredA.text());
    const otherTenantClaim = await admin("/__cloud/v1/tenant-hosts", "POST", {
      tenantId: b.tenant.id,
      hostname: "front-a.example.test",
    });
    assert.equal(otherTenantClaim.status, 409);
    const registeredB = await admin("/__cloud/v1/tenant-hosts", "POST", {
      tenantId: b.tenant.id,
      hostname: "front-b.example.test",
    });
    assert.equal(registeredB.status, 201);

    const resolvedA = await app.fetch(
      new Request(
        "https://omniroute.test/__cloud/v1/tenant-hosts/resolve?hostname=FRONT-A.EXAMPLE.TEST:443"
      )
    );
    assert.equal(resolvedA.status, 200);
    const responseText = await resolvedA.text();
    assert.match(responseText, /host-tenant-a/);
    assert.match(responseText, /front-a\.example\.test/);
    assert.doesNotMatch(responseText, new RegExp(a.ownerApiKey.token));
    assert.doesNotMatch(responseText, new RegExp(b.ownerApiKey.token));
    assert.doesNotMatch(responseText, /orc_live_/);

    const suffixLookalike = await app.fetch(
      new Request(
        "https://omniroute.test/__cloud/v1/tenant-hosts/resolve?hostname=front-a.example.test.evil.test"
      )
    );
    assert.equal(suffixLookalike.status, 404);

    const crossTenantDelete = await admin(
      "/__cloud/v1/tenant-hosts/front-a.example.test?tenantId=host-tenant-b",
      "DELETE"
    );
    assert.equal(crossTenantDelete.status, 404);
    const stillBoundToA = await app.fetch(
      new Request(
        "https://omniroute.test/__cloud/v1/tenant-hosts/resolve?hostname=front-a.example.test"
      )
    );
    assert.equal(stillBoundToA.status, 200);

    await setCloudCustomerTenantActive(db, a.tenant.id, false, "2026-10-09T12:02:00.000Z");
    const suspendedResolution = await app.fetch(
      new Request(
        "https://omniroute.test/__cloud/v1/tenant-hosts/resolve?hostname=front-a.example.test"
      )
    );
    assert.equal(suspendedResolution.status, 404);

    const removed = await admin(
      "/__cloud/v1/tenant-hosts/front-a.example.test?tenantId=host-tenant-a",
      "DELETE"
    );
    assert.equal(removed.status, 200);
    const afterRemoval = await app.fetch(
      new Request(
        "https://omniroute.test/__cloud/v1/tenant-hosts/resolve?hostname=front-a.example.test"
      )
    );
    assert.equal(afterRemoval.status, 404);
    const removalAudit = await db
      .prepare<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cloud_compliance_audit WHERE action = 'customer.host.remove'"
      )
      .first();
    assert.equal(removalAudit?.count, 1);
  } finally {
    db.db.close();
  }
});

test("only the platform admin can register verified hosts and registration is audited", async () => {
  const db = await migratedDb();
  try {
    const customer = await provisionCloudCustomer(db, {
      id: "host-auth-tenant",
      name: "Host Auth Tenant",
      slug: "host-auth-tenant",
      ownerPrincipalId: "owner-host-auth",
      now: "2026-10-09T12:00:00.000Z",
    });
    const app = createCloudRuntime({ env: { DB: db, OMNIROUTE_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN } });
    const unauthorized = await app.fetch(
      new Request("https://omniroute.test/__cloud/v1/tenant-hosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: customer.tenant.id, hostname: "owned.example.test" }),
      })
    );
    assert.equal(unauthorized.status, 401);

    const malformed = await app.fetch(
      new Request("https://omniroute.test/__cloud/v1/tenant-hosts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tenantId: customer.tenant.id, hostname: "*.example.test" }),
      })
    );
    assert.equal(malformed.status, 400);

    const registered = await app.fetch(
      new Request("https://omniroute.test/__cloud/v1/tenant-hosts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tenantId: customer.tenant.id, hostname: "owned.example.test" }),
      })
    );
    assert.equal(registered.status, 201, await registered.text());
    const duplicate = await app.fetch(
      new Request("https://omniroute.test/__cloud/v1/tenant-hosts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tenantId: customer.tenant.id, hostname: "owned.example.test" }),
      })
    );
    assert.equal(duplicate.status, 409);
    const audit = await db
      .prepare<{ action: string; metadata_json: string }>(
        "SELECT action, metadata_json FROM cloud_compliance_audit WHERE action = 'customer.host.register'"
      )
      .all();
    assert.equal(audit.results.length, 1);
    assert.match(audit.results[0].metadata_json, /host-auth-tenant/);
    assert.match(audit.results[0].metadata_json, /out_of_band/);
  } finally {
    db.db.close();
  }
});

test("host listing reports an unsuccessful D1 read instead of an empty registry", async () => {
  const db = {
    prepare: () => ({
      bind() {
        return this;
      },
      async all() {
        return { results: [], success: false };
      },
    }),
  } as unknown as CloudDb;

  await assert.rejects(listAdminVerifiedCustomerHosts(db, "host-tenant"), {
    message: "D1 customer host list failed",
  });
});

test("host mutation rolls back when its audit write fails", async () => {
  const db = await migratedDb();
  try {
    const customer = await provisionCloudCustomer(db, {
      id: "host-atomic-tenant",
      name: "Host Atomic Tenant",
      slug: "host-atomic-tenant",
      ownerPrincipalId: "owner-host-atomic",
      now: "2026-10-09T12:00:00.000Z",
    });
    const app = createCloudRuntime({ env: { DB: db, OMNIROUTE_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN } });
    const register = () =>
      app.fetch(
        new Request("https://omniroute.test/__cloud/v1/tenant-hosts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tenantId: customer.tenant.id, hostname: "atomic.example.test" }),
        })
      );
    const resolve = () =>
      app.fetch(
        new Request(
          "https://omniroute.test/__cloud/v1/tenant-hosts/resolve?hostname=atomic.example.test"
        )
      );

    db.db.exec(`CREATE TRIGGER fail_host_register_audit BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action = 'customer.host.register'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    assert.equal((await register()).status, 503);
    assert.equal((await resolve()).status, 404);
    db.db.exec("DROP TRIGGER fail_host_register_audit");

    assert.equal((await register()).status, 201);
    db.db.exec(`CREATE TRIGGER fail_host_remove_audit BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action = 'customer.host.remove'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const remove = await app.fetch(
      new Request(
        "https://omniroute.test/__cloud/v1/tenant-hosts/atomic.example.test?tenantId=host-atomic-tenant",
        { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }
      )
    );
    assert.equal(remove.status, 503);
    assert.equal((await resolve()).status, 200);
  } finally {
    db.db.close();
  }
});
