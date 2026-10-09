import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import { provisionCloudCustomer } from "../../src/cloud/provisioning";
import {
  createCloudCustomerMembership,
  revokeCloudCustomerApiKey,
} from "../../src/cloud/customerIdentity";
import { registerCloudGatewayDevice } from "../../src/cloud/gatewayDevices";
import { createCloudRuntime } from "../../src/cloud/runtime";
import { registerAdminVerifiedCustomerHost } from "../../src/cloud/tenantHosts";

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
    return (this.db.prepare(this.sql).get(...(this.values as never[])) as U | undefined) ?? null;
  }

  async all<U = T>() {
    return {
      results: this.db.prepare(this.sql).all(...(this.values as never[])) as U[],
      success: true,
    };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...(this.values as never[]));
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

const NOW = "2026-10-09T12:00:00.000Z";
const ADMIN_TOKEN = "frontdesk-config-admin-token-0123456789";
const SERVICE_TOKEN = "frontdesk-config-service-token-0123456789";
const MAINTENANCE_TOKEN = "frontdesk-config-maintenance-token-0123456789";
const IDEMPOTENCY_KEY = "frontdesk-config-idempotency-key-0123456789";
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)));
const DASHBOARD_SECRET = "dashboard_token_secret_for_tenant_b_0123456789";

async function fixture(
  options: {
    now?: () => Date;
    customerHostTxtResolver?: (recordName: string) => Promise<string[] | null>;
  } = {}
) {
  const db = new SqliteCloudDb();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0004_cloud_gateway_devices.sql",
    "0005_cloud_customer_identity.sql",
    "0007_gateway_device_service_health.sql",
    "0008_cloud_tenant_settings.sql",
    "0015_cloud_tenant_oidc.sql",
    "0016_cloud_tenant_oidc_sessions.sql",
    "0021_cloud_maintenance_runs.sql",
    "0025_verified_customer_hosts.sql",
    "0028_cloud_frontdesk_configs.sql",
    "0029_cloud_maintenance_image_job_task.sql",
    "0030_cloud_customer_host_verification_challenges.sql",
  ]) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }

  const [tenantA, tenantB] = await Promise.all(
    ["frontdesk-tenant-a", "frontdesk-tenant-b"].map((id) =>
      provisionCloudCustomer(db, {
        id,
        name: id,
        slug: id,
        ownerPrincipalId: `${id}-owner`,
        now: NOW,
      })
    )
  );
  const hosts = [
    { tenantId: tenantA.tenant.id, hostname: "front-a.example.test" },
    { tenantId: tenantB.tenant.id, hostname: "front-b.example.test" },
  ];
  for (const host of hosts) {
    await registerAdminVerifiedCustomerHost(db, {
      ...host,
      verifiedAt: NOW,
      verifiedBy: "test-platform-admin",
    });
  }

  const [, deviceB] = await Promise.all(
    [tenantA, tenantB].map((tenant, index) =>
      registerCloudGatewayDevice(db, {
        tenantId: tenant.tenant.id,
        id: `frontdesk-device-${index === 0 ? "a" : "b"}`,
        credentialHash: String(index + 1).repeat(64),
        capabilities: ["ollama:chat:llama-3.2"],
        now: NOW,
      })
    )
  );
  const runtime = createCloudRuntime({
    env: {
      DB: db,
      OMNIROUTE_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN,
      OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: MAINTENANCE_TOKEN,
      OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
      OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: IDEMPOTENCY_KEY,
      OMNIROUTE_FRONT_DESK_CONFIG_TOKEN: SERVICE_TOKEN,
      OMNIROUTE_CLOUD_PUBLIC_ORIGIN: "https://cloud.test",
    },
    now: options.now ?? (() => new Date(NOW)),
    customerHostTxtResolver: options.customerHostTxtResolver,
  });

  const call = (path: string, options: { method?: string; token?: string; body?: unknown } = {}) =>
    runtime.fetch(
      new Request(`https://cloud.test${path}`, {
        method: options.method ?? "GET",
        headers: {
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
    );

  const configBody = (hostname: string, customerApiKey: string, deviceId: string) => ({
    hostname,
    customerApiKey,
    dashboardToken: DASHBOARD_SECRET,
    gateway: {
      baseUrl: "http://127.0.0.1:20128",
      deviceId,
      ollamaModel: "llama-3.2",
      imageGeneration: null,
    },
  });

  return {
    db,
    tenantA,
    tenantB,
    deviceB,
    runtime,
    call,
    configBody,
  };
}

test("Front Desk config writes, service retrieval, and admin listing isolate tenant secrets", async () => {
  const { db, tenantA, tenantB, deviceB, call, configBody } = await fixture();
  try {
    const crossTenantWrite = await call("/__cloud/v1/front-desk/configs", {
      method: "PUT",
      token: ADMIN_TOKEN,
      body: configBody("front-b.example.test", tenantA.ownerApiKey.token, deviceB.id),
    });
    const crossTenantResponse = await crossTenantWrite.text();
    assert.equal(crossTenantWrite.status, 403, crossTenantResponse);
    assert.doesNotMatch(crossTenantResponse, /orc_live_|dashboard_token_secret/);

    const unauthenticatedRead = await call(
      "/__cloud/v1/front-desk/config?hostname=front-b.example.test"
    );
    assert.equal(unauthenticatedRead.status, 401);

    const successfulWrite = await call("/__cloud/v1/front-desk/configs", {
      method: "PUT",
      token: ADMIN_TOKEN,
      body: configBody("front-b.example.test", tenantB.ownerApiKey.token, deviceB.id),
    });
    const successfulWriteText = await successfulWrite.text();
    assert.equal(successfulWrite.status, 200, successfulWriteText);
    assert.doesNotMatch(successfulWriteText, new RegExp(tenantB.ownerApiKey.token));
    assert.doesNotMatch(successfulWriteText, new RegExp(DASHBOARD_SECRET));
    assert.match(successfulWriteText, /"hasCustomerApiKey":true/);
    assert.match(successfulWriteText, /"hasDashboardToken":true/);

    const serviceRead = await call("/__cloud/v1/front-desk/config?hostname=front-b.example.test", {
      token: SERVICE_TOKEN,
    });
    const serviceReadText = await serviceRead.text();
    assert.equal(serviceRead.status, 200, serviceReadText);
    assert.match(serviceReadText, new RegExp(tenantB.ownerApiKey.token));
    assert.match(serviceReadText, new RegExp(DASHBOARD_SECRET));
    assert.doesNotMatch(serviceReadText, new RegExp(tenantA.ownerApiKey.token));

    const adminList = await call("/__cloud/v1/front-desk/configs?tenantId=frontdesk-tenant-b", {
      token: ADMIN_TOKEN,
    });
    const adminListText = await adminList.text();
    assert.equal(adminList.status, 200, adminListText);
    assert.match(adminListText, /"hostname":"front-b.example.test"/);
    assert.match(adminListText, /"hasCustomerApiKey":true/);
    assert.match(adminListText, /"hasDashboardToken":true/);
    assert.doesNotMatch(adminListText, new RegExp(tenantB.ownerApiKey.token));
    assert.doesNotMatch(adminListText, new RegExp(DASHBOARD_SECRET));
    assert.doesNotMatch(adminListText, /customer_api_key_encrypted|dashboard_token_encrypted/);

    const stored = await db
      .prepare<{ customer_api_key_encrypted: string; dashboard_token_encrypted: string }>(
        `SELECT customer_api_key_encrypted, dashboard_token_encrypted
           FROM cloud_frontdesk_configs WHERE hostname = ?`
      )
      .bind("front-b.example.test")
      .first();
    assert.ok(stored);
    assert.notEqual(stored.customer_api_key_encrypted, tenantB.ownerApiKey.token);
    assert.notEqual(stored.dashboard_token_encrypted, DASHBOARD_SECRET);

    assert.equal(
      await revokeCloudCustomerApiKey(db, {
        tenantId: tenantB.tenant.id,
        apiKeyId: tenantB.ownerApiKey.id,
        now: NOW,
      }),
      true
    );
    const revokedKeyRead = await call(
      "/__cloud/v1/front-desk/config?hostname=front-b.example.test",
      { token: SERVICE_TOKEN }
    );
    const revokedKeyBody = await revokedKeyRead.text();
    assert.equal(revokedKeyRead.status, 503);
    assert.doesNotMatch(revokedKeyBody, new RegExp(tenantB.ownerApiKey.token));
    assert.doesNotMatch(revokedKeyBody, new RegExp(DASHBOARD_SECRET));
  } finally {
    db.db.close();
  }
});

test("customer Front Desk portal is tenant scoped, owner/admin only, redacted, and feeds service retrieval", async () => {
  const { db, tenantA, tenantB, deviceB, runtime, configBody } = await fixture();
  const sessionToken = "frontdesk-portal-session-token-01234567890123456789";
  const memberToken = "frontdesk-member-session-token-012345678901234567890";
  const hashToken = async (token: string) => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return Array.from(new Uint8Array(hash), (part) => part.toString(16).padStart(2, "0")).join("");
  };
  const addOidcSession = async (
    tenant: typeof tenantA,
    membershipId: string,
    token: string,
    identityId: string,
    subject: string
  ) => {
    const issuer = `https://${tenant.tenant.slug}.identity.example.test`;
    await db
      .prepare(
        `INSERT OR IGNORE INTO cloud_tenant_oidc_configs
         (tenant_id, issuer, client_id, client_secret_encrypted, scopes_json, is_enabled, created_at, updated_at)
       VALUES (?, ?, 'client', 'enc:v1:test', '["openid"]', 1, ?, ?)`
      )
      .bind(tenant.tenant.id, issuer, NOW, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_identities
         (id, tenant_id, issuer, subject, membership_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(identityId, tenant.tenant.id, issuer, subject, membershipId, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_sessions
         (token_hash, tenant_id, membership_id, identity_id, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        await hashToken(token),
        tenant.tenant.id,
        membershipId,
        identityId,
        Date.parse(NOW),
        Date.parse(NOW) + 3_600_000
      )
      .run();
  };
  const member = await createCloudCustomerMembership(db, {
    tenantId: tenantA.tenant.id,
    principalId: "frontdesk-tenant-a-member",
    role: "member",
    now: NOW,
  });
  await addOidcSession(
    tenantA,
    tenantA.ownerMembership.id,
    sessionToken,
    "frontdesk-owner-id",
    "owner-subject"
  );
  await addOidcSession(tenantA, member.id, memberToken, "frontdesk-member-id", "member-subject");

  const call = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
    runtime.fetch(
      new Request(`https://cloud.test${path}`, {
        method: init.method ?? "GET",
        headers: {
          Cookie: `omni_customer_session=${token}`,
          ...(init.body === undefined
            ? {}
            : { Origin: "https://cloud.test", "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    );
  try {
    const listed = await call("/__cloud/auth/front-desk", sessionToken);
    const listedBody = (await listed.json()) as { hosts: Array<{ hostname: string }> };
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listedBody.hosts.map((host) => host.hostname),
      ["front-a.example.test"]
    );

    const memberDenied = await call("/__cloud/auth/front-desk", memberToken, {
      method: "PUT",
      body: configBody("front-a.example.test", tenantA.ownerApiKey.token, "frontdesk-device-a"),
    });
    assert.equal(memberDenied.status, 403);

    const crossTenant = await call("/__cloud/auth/front-desk", sessionToken, {
      method: "PUT",
      body: configBody("front-b.example.test", tenantB.ownerApiKey.token, deviceB.id),
    });
    assert.equal(crossTenant.status, 404);

    const saved = await call("/__cloud/auth/front-desk", sessionToken, {
      method: "PUT",
      body: configBody("front-a.example.test", tenantA.ownerApiKey.token, "frontdesk-device-a"),
    });
    const savedText = await saved.text();
    assert.equal(saved.status, 200, savedText);
    assert.match(savedText, /"hasCustomerApiKey":true/);
    assert.match(savedText, /"hasDashboardToken":true/);
    assert.doesNotMatch(savedText, new RegExp(tenantA.ownerApiKey.token));
    assert.doesNotMatch(savedText, new RegExp(DASHBOARD_SECRET));

    const serviceRead = await callService(runtime, "front-a.example.test", SERVICE_TOKEN);
    const serviceText = await serviceRead.text();
    assert.equal(serviceRead.status, 200, serviceText);
    assert.match(serviceText, new RegExp(tenantA.ownerApiKey.token));
    assert.match(serviceText, new RegExp(DASHBOARD_SECRET));

    const missingOrigin = await runtime.fetch(
      new Request("https://cloud.test/__cloud/auth/front-desk", {
        method: "PUT",
        headers: {
          Cookie: `omni_customer_session=${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          configBody("front-a.example.test", tenantA.ownerApiKey.token, "frontdesk-device-a")
        ),
      })
    );
    assert.equal(missingOrigin.status, 403);

    await db
      .prepare("UPDATE cloud_gateway_devices SET revoked_at = ? WHERE id = ?")
      .bind(NOW, "frontdesk-device-a")
      .run();
    const revokedDeviceSave = await call("/__cloud/auth/front-desk", sessionToken, {
      method: "PUT",
      body: configBody("front-a.example.test", tenantA.ownerApiKey.token, "frontdesk-device-a"),
    });
    assert.equal(revokedDeviceSave.status, 403);

    const audits = await db
      .prepare<{
        action: string;
        actor: string;
        details_json: string | null;
        metadata_json: string | null;
      }>(
        `SELECT action, actor, details_json, metadata_json FROM cloud_compliance_audit
        WHERE action = 'customer.frontdesk.config.write'`
      )
      .all();
    assert.equal(audits.results.length, 1);
    assert.equal(audits.results[0].actor, `membership:${tenantA.ownerMembership.id}`);
    assert.doesNotMatch(JSON.stringify(audits.results[0]), new RegExp(tenantA.ownerApiKey.token));
    assert.doesNotMatch(JSON.stringify(audits.results[0]), new RegExp(DASHBOARD_SECRET));

    const deleted = await runtime.fetch(
      new Request("https://cloud.test/__cloud/auth/front-desk/front-a.example.test", {
        method: "DELETE",
        headers: {
          Cookie: `omni_customer_session=${sessionToken}`,
          Origin: "https://cloud.test",
        },
      })
    );
    assert.equal(deleted.status, 200, await deleted.clone().text());
    const afterDelete = await callService(runtime, "front-a.example.test", SERVICE_TOKEN);
    assert.equal(afterDelete.status, 404);

    await db
      .prepare("UPDATE cloud_tenant_oidc_sessions SET revoked_at_ms = ? WHERE token_hash = ?")
      .bind(Date.parse(NOW), await hashToken(sessionToken))
      .run();
    const afterRevocation = await call("/__cloud/auth/front-desk", sessionToken, {
      method: "PUT",
      body: configBody("front-a.example.test", tenantA.ownerApiKey.token, "frontdesk-device-a"),
    });
    assert.equal(afterRevocation.status, 403);
  } finally {
    db.db.close();
  }
});

test("customer host portal is tenant isolated and protects DNS challenges across session changes", async () => {
  let nowMs = Date.parse(NOW);
  let dnsValues: string[] = [];
  let onDnsLookup: () => Promise<void> = async () => undefined;
  const { db, tenantA, tenantB, runtime } = await fixture({
    now: () => new Date(nowMs),
    customerHostTxtResolver: async () => {
      await onDnsLookup();
      return dnsValues;
    },
  });
  const hashToken = async (token: string) => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return Array.from(new Uint8Array(hash), (part) => part.toString(16).padStart(2, "0")).join("");
  };
  const addSession = async (
    tenant: typeof tenantA,
    membershipId: string,
    token: string,
    identityId: string,
    subject: string
  ) => {
    const issuer = `https://${tenant.tenant.slug}.identity.example.test`;
    await db
      .prepare(
        `INSERT OR IGNORE INTO cloud_tenant_oidc_configs
      (tenant_id, issuer, client_id, client_secret_encrypted, scopes_json, is_enabled, created_at, updated_at)
      VALUES (?, ?, 'client', 'enc:v1:test', '["openid"]', 1, ?, ?)`
      )
      .bind(tenant.tenant.id, issuer, NOW, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_identities
      (id, tenant_id, issuer, subject, membership_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(identityId, tenant.tenant.id, issuer, subject, membershipId, NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_sessions
      (token_hash, tenant_id, membership_id, identity_id, created_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        await hashToken(token),
        tenant.tenant.id,
        membershipId,
        identityId,
        nowMs,
        nowMs + 3_600_000
      )
      .run();
  };
  const ownerA = "host-portal-owner-session-token-01234567890123456789";
  const ownerB = "host-portal-owner-b-session-token-01234567890123456789";
  const memberToken = "host-portal-member-session-token-01234567890123456789";
  const viewerToken = "host-portal-viewer-session-token-01234567890123456789";
  const member = await createCloudCustomerMembership(db, {
    tenantId: tenantA.tenant.id,
    principalId: "host-portal-member",
    role: "member",
    now: NOW,
  });
  const viewer = await createCloudCustomerMembership(db, {
    tenantId: tenantA.tenant.id,
    principalId: "host-portal-viewer",
    role: "viewer",
    now: NOW,
  });
  await addSession(tenantA, tenantA.ownerMembership.id, ownerA, "host-owner-a", "owner-a");
  await addSession(tenantA, member.id, memberToken, "host-member-a", "member-a");
  await addSession(tenantA, viewer.id, viewerToken, "host-viewer-a", "viewer-a");
  await addSession(tenantB, tenantB.ownerMembership.id, ownerB, "host-owner-b", "owner-b");
  const call = (path: string, token: string, method = "GET", body?: unknown, origin = true) =>
    runtime.fetch(
      new Request(`https://cloud.test${path}`, {
        method,
        headers: {
          Cookie: `omni_customer_session=${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(body === undefined || !origin ? {} : { Origin: "https://cloud.test" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
  const challenge = async (token: string, hostname: string) => {
    const response = await call("/__cloud/auth/front-desk/hosts/challenge", token, "POST", {
      hostname,
    });
    return {
      response,
      body: (await response.json()) as { challengeId?: string; recordValue?: string },
    };
  };

  try {
    assert.equal(
      (
        await call("/__cloud/auth/front-desk/hosts/challenge", memberToken, "POST", {
          hostname: "member.example.test",
        })
      ).status,
      403
    );
    assert.equal(
      (
        await call("/__cloud/auth/front-desk/hosts/challenge", viewerToken, "POST", {
          hostname: "viewer.example.test",
        })
      ).status,
      403
    );
    assert.equal(
      (await call(`/__cloud/auth/front-desk/hosts?tenantId=${tenantB.tenant.id}`, ownerA)).status,
      400
    );
    assert.equal(
      (
        await call("/__cloud/auth/front-desk/hosts/challenge", ownerA, "POST", {
          hostname: "spoof.example.test",
          tenantId: tenantB.tenant.id,
        })
      ).status,
      400
    );
    assert.equal(
      (
        await call(
          "/__cloud/auth/front-desk/hosts/challenge",
          ownerA,
          "POST",
          {
            hostname: "missing-origin.example.test",
          },
          false
        )
      ).status,
      403
    );

    const [issuedA, issuedB] = await Promise.all([
      challenge(ownerA, "success.customer-a.example.test"),
      challenge(ownerB, "pending.customer-b.example.test"),
    ]);
    assert.equal(issuedA.response.status, 201);
    assert.equal(issuedB.response.status, 201);
    assert.ok(issuedA.body.challengeId && issuedA.body.recordValue);
    assert.ok(issuedB.body.challengeId && issuedB.body.recordValue);
    const rotatedA = await challenge(ownerA, "success.customer-a.example.test");
    assert.equal(rotatedA.response.status, 201);
    assert.notEqual(rotatedA.body.challengeId, issuedA.body.challengeId);
    assert.notEqual(rotatedA.body.recordValue, issuedA.body.recordValue);
    const crossTenantVerify = await call("/__cloud/auth/front-desk/hosts/verify", ownerA, "POST", {
      hostname: "pending.customer-b.example.test",
      challengeId: issuedB.body.challengeId,
    });
    assert.equal(crossTenantVerify.status, 404);

    const mismatchChallenge = await challenge(ownerA, "attempts.customer-a.example.test");
    assert.equal(mismatchChallenge.response.status, 201);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const mismatch = await call("/__cloud/auth/front-desk/hosts/verify", ownerA, "POST", {
        hostname: "attempts.customer-a.example.test",
        challengeId: mismatchChallenge.body.challengeId,
      });
      assert.equal(mismatch.status, 422);
    }
    const exhausted = await call("/__cloud/auth/front-desk/hosts/verify", ownerA, "POST", {
      hostname: "attempts.customer-a.example.test",
      challengeId: mismatchChallenge.body.challengeId,
    });
    assert.equal(exhausted.status, 410);

    const expiredChallenge = await challenge(ownerA, "expired.customer-a.example.test");
    assert.equal(expiredChallenge.response.status, 201);
    nowMs += 31 * 60_000;
    const expired = await call("/__cloud/auth/front-desk/hosts/verify", ownerA, "POST", {
      hostname: "expired.customer-a.example.test",
      challengeId: expiredChallenge.body.challengeId,
    });
    assert.equal(expired.status, 410);

    const pending = await challenge(ownerA, "rollback.customer-a.example.test");
    assert.equal(pending.response.status, 201);
    dnsValues = [pending.body.recordValue!];
    const tokenHash = await hashToken(pending.body.recordValue!);
    const storedChallenge = await db
      .prepare<{ token_hash: string }>(
        "SELECT token_hash FROM cloud_customer_host_verification_challenges WHERE hostname = ?"
      )
      .bind("rollback.customer-a.example.test")
      .first();
    assert.equal(storedChallenge?.token_hash, tokenHash);
    assert.notEqual(storedChallenge?.token_hash, pending.body.recordValue);

    await db.exec(`CREATE TRIGGER reject_customer_host_verify_audit BEFORE INSERT ON cloud_compliance_audit
      WHEN NEW.action = 'customer.host.verify' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const rolledBack = await call("/__cloud/auth/front-desk/hosts/verify", ownerA, "POST", {
      hostname: "rollback.customer-a.example.test",
      challengeId: pending.body.challengeId,
    });
    assert.equal(rolledBack.status, 503);
    assert.equal(
      await db
        .prepare("SELECT 1 FROM cloud_verified_customer_hosts WHERE hostname = ?")
        .bind("rollback.customer-a.example.test")
        .first(),
      null
    );
    assert.ok(
      await db
        .prepare("SELECT 1 FROM cloud_customer_host_verification_challenges WHERE hostname = ?")
        .bind("rollback.customer-a.example.test")
        .first()
    );
    await db.exec("DROP TRIGGER reject_customer_host_verify_audit");

    const verified = await call("/__cloud/auth/front-desk/hosts/verify", ownerA, "POST", {
      hostname: "rollback.customer-a.example.test",
      challengeId: pending.body.challengeId,
    });
    assert.equal(verified.status, 201, await verified.clone().text());
    const replay = await call("/__cloud/auth/front-desk/hosts/verify", ownerA, "POST", {
      hostname: "rollback.customer-a.example.test",
      challengeId: pending.body.challengeId,
    });
    assert.equal(replay.status, 404);
    const listed = await call("/__cloud/auth/front-desk/hosts", ownerA);
    const listedText = await listed.text();
    assert.equal(listed.status, 200, listedText);
    assert.match(listedText, /rollback\.customer-a\.example\.test/);
    assert.doesNotMatch(listedText, new RegExp(pending.body.recordValue!));
    const audit = await db
      .prepare<{ actor: string; action: string; metadata_json: string | null }>(
        `SELECT actor, action, metadata_json FROM cloud_compliance_audit
        WHERE action IN ('customer.host.challenge.issue', 'customer.host.verify')`
      )
      .all();
    assert.ok(
      audit.results.some((row) => row.actor === `membership:${tenantA.ownerMembership.id}`)
    );
    assert.ok(audit.results.some((row) => row.action === "customer.host.verify"));
    assert.doesNotMatch(JSON.stringify(audit.results), new RegExp(pending.body.recordValue!));

    const revokedSessionChallenge = await challenge(
      ownerA,
      "revoked-session.customer-a.example.test"
    );
    assert.equal(revokedSessionChallenge.response.status, 201);
    dnsValues = [revokedSessionChallenge.body.recordValue!];
    onDnsLookup = async () => {
      await db
        .prepare("UPDATE cloud_tenant_oidc_sessions SET revoked_at_ms = ? WHERE token_hash = ?")
        .bind(nowMs, await hashToken(ownerA))
        .run();
    };
    const revokedDuringLookup = await call(
      "/__cloud/auth/front-desk/hosts/verify",
      ownerA,
      "POST",
      {
        hostname: "revoked-session.customer-a.example.test",
        challengeId: revokedSessionChallenge.body.challengeId,
      }
    );
    assert.equal(revokedDuringLookup.status, 403);
    assert.equal(
      await db
        .prepare("SELECT 1 FROM cloud_verified_customer_hosts WHERE hostname = ?")
        .bind("revoked-session.customer-a.example.test")
        .first(),
      null
    );
    onDnsLookup = async () => undefined;
  } finally {
    db.db.close();
  }
});

async function callService(
  runtime: ReturnType<typeof createCloudRuntime>,
  hostname: string,
  token: string
) {
  return runtime.fetch(
    new Request(`https://cloud.test/__cloud/v1/front-desk/config?hostname=${hostname}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  );
}
