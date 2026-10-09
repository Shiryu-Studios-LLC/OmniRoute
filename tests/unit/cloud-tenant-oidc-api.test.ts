import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import {
  decryptCloudCredential,
  isCloudCredentialEnvelope,
} from "../../src/cloud/credentialEncryption";
import { createCloudCustomerMembership } from "../../src/cloud/customerIdentity";
import { addCloudTenantOidcIdentity } from "../../src/cloud/tenantOidc";
import { createCloudCustomerTenant } from "../../src/cloud/tenants";
import { handleCloudApiRequest } from "../../src/cloud/httpApi";

const ADMIN_TOKEN = "test-cloud-oidc-admin-token";
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(41)));
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

async function makeDb() {
  const db = new SqliteCloudDb();
  for (const name of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0005_cloud_customer_identity.sql",
    "0015_cloud_tenant_oidc.sql",
    "0016_cloud_tenant_oidc_sessions.sql",
    "0018_cloud_tenant_membership_invitations.sql",
    "0020_cloud_tenant_oidc_owner_claims.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", name), "utf8"));
  }
  await createCloudCustomerTenant(db, {
    id: "customer-a",
    name: "Customer A",
    slug: "customer-a",
    now: NOW,
  });
  await createCloudCustomerTenant(db, {
    id: "customer-b",
    name: "Customer B",
    slug: "customer-b",
    now: NOW,
  });
  const ownerA = await createCloudCustomerMembership(db, {
    tenantId: "customer-a",
    principalId: "principal-a-owner",
    role: "owner",
    now: NOW,
  });
  const memberA = await createCloudCustomerMembership(db, {
    tenantId: "customer-a",
    principalId: "principal-a-member",
    role: "member",
    now: NOW,
  });
  const ownerB = await createCloudCustomerMembership(db, {
    tenantId: "customer-b",
    principalId: "principal-b-owner",
    role: "owner",
    now: NOW,
  });
  return { db, ownerA, memberA, ownerB };
}

async function call(
  db: CloudDb,
  path: string,
  method = "GET",
  body?: unknown,
  token = ADMIN_TOKEN
): Promise<Response> {
  return handleCloudApiRequest(
    new Request(`https://worker.example/__cloud/v1/tenants/${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      db,
      adminToken: ADMIN_TOKEN,
      credentialEncryptionKey: ENCRYPTION_KEY,
      now: () => new Date(NOW),
    }
  );
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

test("Cloud OIDC admin API encrypts secrets and rejects unverified identity links", async () => {
  const { db, ownerA, ownerB } = await makeDb();
  assert.equal((await call(db, "customer-a/oidc", "GET", undefined, "")).status, 401);
  const maintenanceAccess = await handleCloudApiRequest(
    new Request("https://worker.example/__cloud/v1/tenants/customer-a/oidc", {
      headers: { Authorization: "Bearer maintenance-token" },
    }),
    {
      db,
      adminToken: ADMIN_TOKEN,
      maintenanceToken: "maintenance-token",
      credentialEncryptionKey: ENCRYPTION_KEY,
      now: () => new Date(NOW),
    }
  );
  assert.equal(
    maintenanceAccess.status,
    401,
    "only the platform-admin token may manage OIDC links"
  );
  const tenantMemberAccess = await handleCloudApiRequest(
    new Request("https://worker.example/__cloud/v1/tenants/customer-a/oidc", {
      headers: { Authorization: "Bearer orc_live_customer_key" },
    }),
    {
      db,
      adminToken: ADMIN_TOKEN,
      credentialEncryptionKey: ENCRYPTION_KEY,
      now: () => new Date(NOW),
    }
  );
  assert.equal(tenantMemberAccess.status, 401, "customer membership keys cannot manage OIDC links");
  assert.equal((await call(db, "customer-a/oidc", "GET")).status, 200);
  assert.deepEqual(await json(await call(db, "customer-a/oidc", "GET")), null);

  const missingSecret = await call(db, "customer-a/oidc", "PUT", {
    issuer: "https://id.example.com/tenant-a",
    clientId: "client-a",
  });
  assert.equal(missingSecret.status, 400);

  const created = await call(db, "customer-a/oidc", "PUT", {
    issuer: "https://id.example.com/tenant-a",
    clientId: "client-a",
    clientSecret: "private-client-secret",
    scopes: ["openid", "profile"],
    isEnabled: true,
  });
  assert.equal(created.status, 201);
  const config = (await json(created)) as Record<string, unknown>;
  assert.equal(config.tenantId, "customer-a");
  assert.equal(config.issuer, "https://id.example.com/tenant-a");
  assert.equal(config.isEnabled, true);
  assert.equal(config.hasClientSecret, true);
  assert.equal("clientSecret" in config, false);
  assert.equal(JSON.stringify(config).includes("private-client-secret"), false);
  const stored = db.db
    .prepare("SELECT client_secret_encrypted FROM cloud_tenant_oidc_configs WHERE tenant_id = ?")
    .get("customer-a") as { client_secret_encrypted: string };
  assert.equal(isCloudCredentialEnvelope(stored.client_secret_encrypted), true);
  assert.equal(
    await decryptCloudCredential(stored.client_secret_encrypted, ENCRYPTION_KEY, {
      tenantId: "customer-a",
      connectionId: "tenant-oidc",
      field: "clientSecret",
    }),
    "private-client-secret"
  );

  const unverifiedIdentityLink = await call(db, "customer-a/oidc/identities", "POST", {
    issuer: "https://id.example.com/tenant-a",
    subject: "subject:Exact-Case-123",
    membershipId: ownerA.id,
  });
  assert.equal(unverifiedIdentityLink.status, 405);
  assert.deepEqual(await json(await call(db, "customer-a/oidc/identities")), []);
  const auditRows = db.db
    .prepare(
      "SELECT details_json, metadata_json FROM cloud_compliance_audit WHERE action LIKE 'customer.oidc.%'"
    )
    .all() as Array<{ details_json: string | null; metadata_json: string | null }>;
  const auditText = JSON.stringify(auditRows);
  assert.equal(auditText.includes("private-client-secret"), false);
  assert.equal(auditText.includes("subject:Exact-Case-123"), false);

  assert.equal(ownerA.tenantId, "customer-a");
  assert.equal(ownerB.tenantId, "customer-b");
});

test("first-owner claims require the platform admin, enabled OIDC, and no existing owner", async () => {
  const { db, ownerA } = await makeDb();
  const configured = await call(db, "customer-a/oidc", "PUT", {
    issuer: "https://id.example.com/tenant-a",
    clientId: "client-a",
    clientSecret: "private-client-secret",
    isEnabled: true,
  });
  assert.equal(configured.status, 201);

  const path = "https://worker.example/__cloud/v1/tenants/customer-a/oidc/owner-claims";
  const unauthenticated = await handleCloudApiRequest(new Request(path, { method: "POST" }), {
    db,
    adminToken: ADMIN_TOKEN,
    now: () => new Date(NOW),
  });
  assert.equal(unauthenticated.status, 401);

  const maintenance = await handleCloudApiRequest(
    new Request(path, {
      method: "POST",
      headers: { Authorization: "Bearer maintenance-token" },
    }),
    {
      db,
      adminToken: ADMIN_TOKEN,
      maintenanceToken: "maintenance-token",
      now: () => new Date(NOW),
    }
  );
  assert.equal(maintenance.status, 401, "maintenance credentials cannot enroll a customer owner");

  await db
    .prepare("UPDATE cloud_customer_memberships SET is_active = 0 WHERE tenant_id = ? AND id = ?")
    .bind("customer-a", ownerA.id)
    .run();
  const issued = await call(db, "customer-a/oidc/owner-claims", "POST");
  assert.equal(issued.status, 201);
  const firstClaim = (await issued.json()) as {
    code: string;
    expiresAt: string;
    redeemPath: string;
  };
  assert.equal(firstClaim.redeemPath, "/__cloud/auth/oidc/owner/claim");
  assert.equal(Date.parse(firstClaim.expiresAt), Date.parse(NOW) + 15 * 60 * 1000);
  const stored = db.db
    .prepare(
      "SELECT code_hash, issuer, expires_at_ms FROM cloud_tenant_oidc_owner_claims WHERE tenant_id = ?"
    )
    .get("customer-a") as { code_hash: string; issuer: string; expires_at_ms: number };
  assert.equal(stored.code_hash, createHash("sha256").update(firstClaim.code).digest("hex"));
  assert.equal(stored.issuer, "https://id.example.com/tenant-a");
  assert.equal(stored.expires_at_ms, Date.parse(firstClaim.expiresAt));

  const reissued = await call(db, "customer-a/oidc/owner-claims", "POST");
  assert.equal(reissued.status, 201);
  const replacement = (await reissued.json()) as { code: string };
  assert.notEqual(replacement.code, firstClaim.code);
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM cloud_tenant_oidc_owner_claims WHERE tenant_id = ?")
      .get("customer-a")?.count,
    1,
    "reissue replaces the old pending code"
  );
  assert.equal(
    db.db
      .prepare("SELECT code_hash FROM cloud_tenant_oidc_owner_claims WHERE tenant_id = ?")
      .get("customer-a")?.code_hash,
    createHash("sha256").update(replacement.code).digest("hex")
  );

  await db
    .prepare("UPDATE cloud_customer_memberships SET is_active = 1 WHERE tenant_id = ? AND id = ?")
    .bind("customer-a", ownerA.id)
    .run();
  const ownerExists = await call(db, "customer-a/oidc/owner-claims", "POST");
  assert.equal(ownerExists.status, 409);
  const noConfig = await call(db, "customer-b/oidc/owner-claims", "POST");
  assert.equal(noConfig.status, 409);
});

test("Cloud OIDC config changes clear old issuer links and deletion clears the tenant config", async () => {
  const { db, memberA } = await makeDb();
  const created = await call(db, "customer-a/oidc", "PUT", {
    issuer: "https://id.example.com/tenant-a",
    clientId: "client-a",
    clientSecret: "private-client-secret",
    isEnabled: true,
  });
  assert.equal(created.status, 201);
  await addCloudTenantOidcIdentity(db, {
    tenantId: "customer-a",
    issuer: "https://id.example.com/tenant-a",
    subject: "member-subject",
    membershipId: memberA.id,
    now: NOW,
  });

  const update = await call(db, "customer-a/oidc", "PUT", {
    issuer: "https://id.example.com/tenant-a-v2",
    clientId: "client-a-v2",
  });
  assert.equal(update.status, 200);
  const updatedConfig = (await json(update)) as Record<string, unknown>;
  assert.equal(updatedConfig.isEnabled, true, "updates preserve the enabled flag unless provided");
  assert.equal(updatedConfig.hasClientSecret, true, "updates preserve the encrypted secret");
  assert.equal(
    ((await json(await call(db, "customer-a/oidc/identities"))) as unknown[]).length,
    0,
    "changing issuer clears exact links tied to the previous issuer"
  );

  const relinked = await addCloudTenantOidcIdentity(db, {
    tenantId: "customer-a",
    issuer: "https://id.example.com/tenant-a-v2",
    subject: "member-subject-v2",
    membershipId: memberA.id,
    now: NOW,
  });
  assert.equal(relinked.issuer, "https://id.example.com/tenant-a-v2");

  const deleted = await call(db, "customer-a/oidc", "DELETE");
  assert.equal(deleted.status, 200);
  assert.deepEqual(await json(deleted), { deleted: true });
  assert.deepEqual(await json(await call(db, "customer-a/oidc", "GET")), null);
  assert.deepEqual(await json(await call(db, "customer-a/oidc/identities")), []);
});

test("OIDC config stays disabled by default and fails closed without the encryption key", async () => {
  const { db } = await makeDb();
  const response = await handleCloudApiRequest(
    new Request("https://worker.example/__cloud/v1/tenants/customer-a/oidc", {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        issuer: "https://id.example.com/tenant-a",
        clientId: "client-a",
        clientSecret: "private-client-secret",
      }),
    }),
    { db, adminToken: ADMIN_TOKEN, now: () => new Date(NOW) }
  );
  assert.equal(response.status, 503);

  const created = await call(db, "customer-a/oidc", "PUT", {
    issuer: "https://id.example.com/tenant-a",
    clientId: "client-a",
    clientSecret: "private-client-secret",
  });
  assert.equal(created.status, 201);
  assert.equal(((await json(created)) as Record<string, unknown>).isEnabled, false);
});
