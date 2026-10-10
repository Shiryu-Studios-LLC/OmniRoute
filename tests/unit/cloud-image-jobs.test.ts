import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import type {
  GatewayCoordinatorStub,
  GatewayDurableObjectNamespace,
  GatewayDurableStorage,
  GatewayDurableStorageTransaction,
} from "../../src/cloud/connectorGatewayDurableObject";
import { GatewaySessionDurableObject } from "../../src/cloud/connectorGatewayDurableObject";
import { createConnectorGateway } from "../../src/cloud/connectorGateway";
import {
  D1GatewayDeviceDirectory,
  registerCloudGatewayDevice,
} from "../../src/cloud/gatewayDevices";
import { coordinatorFromNamespace } from "../../src/cloud/gatewayHttpApi";
import { createCloudRuntime } from "../../src/cloud/runtime";
import { handleGatewayImageJobRequest } from "../../src/cloud/gatewayImageJobHttpApi";
import { cleanupExpiredCloudImageJobs } from "../../src/cloud/imageJobs";
import {
  createCloudCustomerMembership,
  issueCloudCustomerApiKey,
} from "../../src/cloud/customerIdentity";
import type { GatewayImageArtifactBucket } from "../../src/cloud/imageJobs";

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

  async all<U = T>(): Promise<{ results: U[]; success: boolean; meta?: Record<string, unknown> }> {
    return {
      results: this.db.prepare(this.sql).all(...(this.values as never[])) as U[],
      success: true,
    };
  }

  async run(): Promise<{ success: boolean; meta?: Record<string, unknown> }> {
    const result = this.db.prepare(this.sql).run(...(this.values as never[]));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 implements CloudDb {
  readonly db = new DatabaseSync(":memory:");

  prepare<T = unknown>(sql: string): CloudDbStatement<T> {
    return new SqliteStatement<T>(this.db, sql);
  }

  async batch(statements: CloudDbStatement[]): Promise<unknown[]> {
    const result: unknown[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) result.push(await statement.run());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<unknown> {
    return this.db.exec(sql);
  }
}

function failRunForSqlPrefix(db: CloudDb, sqlPrefix: string): CloudDb {
  return {
    prepare<T = unknown>(sql: string): CloudDbStatement<T> {
      const statement = db.prepare<T>(sql);
      if (!sql.trimStart().startsWith(sqlPrefix)) return statement;
      const failed: CloudDbStatement<T> = {
        bind(...values: unknown[]) {
          statement.bind(...values);
          return failed;
        },
        first<U = T>(column?: string) {
          return statement.first<U>(column);
        },
        all<U = T>() {
          return statement.all<U>();
        },
        async run() {
          return { success: false, meta: { changes: 0 } };
        },
      };
      return failed;
    },
    batch(statements) {
      return db.batch(statements);
    },
    exec(sql) {
      return db.exec(sql);
    },
  };
}

class MemoryStorage implements GatewayDurableStorage, GatewayDurableStorageTransaction {
  private readonly values = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async transaction<T>(callback: (transaction: GatewayDurableStorageTransaction) => Promise<T>) {
    return callback(this);
  }
}

class TestDurableObjectNamespace implements GatewayDurableObjectNamespace<GatewayCoordinatorStub> {
  private readonly objects = new Map<string, GatewaySessionDurableObject>();

  idFromName(name: string): string {
    return name;
  }

  get(id: unknown): GatewayCoordinatorStub {
    const name = String(id);
    let instance = this.objects.get(name);
    if (!instance) {
      instance = new GatewaySessionDurableObject({
        id: { name },
        storage: new MemoryStorage(),
      });
      this.objects.set(name, instance);
    }
    return instance;
  }
}

class MemoryBucket implements GatewayImageArtifactBucket {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  failAfterPut = false;

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown> {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, {
      bytes: bytes.slice(),
      contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
    });
    if (this.failAfterPut) throw new Error("simulated R2 response uncertainty");
    return {};
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new Response(object.bytes.slice()).body,
      size: object.bytes.byteLength,
      httpMetadata: { contentType: object.contentType },
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

async function sha256(value: string): Promise<string> {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixture() {
  const db = new SqliteD1();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0004_cloud_gateway_devices.sql",
    "0005_cloud_customer_identity.sql",
    "0006_gateway_invocation_idempotency.sql",
    "0007_gateway_device_service_health.sql",
    "0008_cloud_tenant_settings.sql",
    "0027_cloud_gateway_image_jobs.sql",
  ]) {
    db.db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  let nowMs = Date.parse("2026-10-09T12:00:00.000Z");
  const now = new Date(nowMs).toISOString();
  for (const tenant of ["tenant-a", "tenant-b"]) {
    db.db
      .prepare(
        `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'customer', 1, ?, ?)`
      )
      .run(tenant, tenant, tenant, now, now);
    db.db
      .prepare("UPDATE cloud_tenant_settings SET local_ai_enabled = 1 WHERE tenant_id = ?")
      .run(tenant);
  }

  const ownerA = await createCloudCustomerMembership(db, {
    tenantId: "tenant-a",
    principalId: "principal-a",
    role: "owner",
    now,
  });
  const keyA = await issueCloudCustomerApiKey(db, {
    tenantId: "tenant-a",
    membershipId: ownerA.id,
    now,
  });
  const otherA = await createCloudCustomerMembership(db, {
    tenantId: "tenant-a",
    principalId: "principal-a2",
    role: "owner",
    now,
  });
  const keyA2 = await issueCloudCustomerApiKey(db, {
    tenantId: "tenant-a",
    membershipId: otherA.id,
    now,
  });
  const ownerB = await createCloudCustomerMembership(db, {
    tenantId: "tenant-b",
    principalId: "principal-b",
    role: "owner",
    now,
  });
  const keyB = await issueCloudCustomerApiKey(db, {
    tenantId: "tenant-b",
    membershipId: ownerB.id,
    now,
  });

  const deviceCredential = "test-device-credential-which-is-long-enough";
  const deviceId = "device-a";
  await registerCloudGatewayDevice(db, {
    tenantId: "tenant-a",
    id: deviceId,
    credentialHash: await sha256(deviceCredential),
    capabilities: ["comfyui:image"],
    now,
  });
  const sessions = new TestDurableObjectNamespace();
  const gateway = createConnectorGateway({
    directory: new D1GatewayDeviceDirectory(db),
    coordinator: coordinatorFromNamespace(sessions),
    now: () => nowMs,
  });
  const session = await gateway.connect(deviceId, deviceCredential);
  assert.ok(session);
  const bucket = new MemoryBucket();
  const runtime = createCloudRuntime({
    env: { DB: db, GATEWAY_SESSIONS: sessions, GATEWAY_ARTIFACTS: bucket },
    now: () => new Date(nowMs),
    gatewayRequestBodyTimeoutMs: 15,
  });
  return {
    db,
    sessions,
    bucket,
    runtime,
    gateway,
    deviceId,
    deviceCredential,
    session,
    keyA,
    keyA2,
    keyB,
    now,
    advanceTime(milliseconds: number) {
      nowMs += milliseconds;
    },
    currentTime() {
      return nowMs;
    },
  };
}

function customerHeaders(token: string, idempotencyKey?: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

function deviceHeaders(deviceId: string, token: string, contentType?: string): HeadersInit {
  return {
    "x-device-id": deviceId,
    authorization: `Bearer ${token}`,
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

async function createJob(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  key = "image-job-key-0001"
) {
  return fixture.runtime.fetch(
    new Request("https://cloud.test/__gateway/v1/customer/image-jobs", {
      method: "POST",
      headers: { ...customerHeaders(fixture.keyA.token, key), "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: fixture.deviceId,
        prompt: "a red apple on a table",
        width: 512,
        height: 512,
        steps: 20,
        cfg: 7,
        seed: 42,
      }),
    })
  );
}

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

test("image job creates once, uploads private binary, completes, and replays its stable identity", async () => {
  const fixture = await createFixture();
  const created = await createJob(fixture);
  assert.equal(created.status, 202);
  const job = (await created.json()) as { jobId: string; status: string; expiresAt: string };
  assert.equal(job.status, "queued");

  const replay = await createJob(fixture);
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).jobId, job.jobId);

  const control = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/control`, {
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken),
    })
  );
  assert.deepEqual(await control.json(), { status: "running" });

  const uploadRequest = new Request(
    `https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/artifact`,
    {
      method: "PUT",
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken, "image/png"),
      body: png,
    }
  );
  const upload = await handleGatewayImageJobRequest(uploadRequest, {
    db: fixture.db,
    sessions: fixture.sessions,
    artifacts: fixture.bucket,
    now: () => Date.parse(fixture.now),
  });
  assert.ok(upload);
  assert.equal(upload.status, 200, await upload.clone().text());

  const complete = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/complete`, {
      method: "POST",
      headers: {
        ...deviceHeaders(fixture.deviceId, fixture.session!.sessionToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ promptId: "comfy-prompt-1" }),
    })
  );
  assert.equal(complete.status, 200);
  const retainedRequest = await coordinatorFromNamespace(fixture.sessions).getRequest(
    fixture.deviceId,
    job.jobId,
    fixture.now
  );
  assert.equal(retainedRequest, null, "terminal jobs should release the DO queue slot");

  const status = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/customer/image-jobs/${job.jobId}`, {
      headers: customerHeaders(fixture.keyA.token),
    })
  );
  assert.deepEqual(await status.json(), {
    jobId: job.jobId,
    status: "succeeded",
    imageAvailable: true,
  });

  const image = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/customer/image-jobs/${job.jobId}/image`, {
      headers: customerHeaders(fixture.keyA.token),
    })
  );
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);

  for (const token of [fixture.keyA2.token, fixture.keyB.token]) {
    const denied = await fixture.runtime.fetch(
      new Request(`https://cloud.test/__gateway/v1/customer/image-jobs/${job.jobId}/image`, {
        headers: customerHeaders(token),
      })
    );
    assert.equal(denied.status, 404);
  }
});

test("image-job insert failure is reported as unavailable rather than exhausted capacity", async () => {
  const fixture = await createFixture();
  const response = await handleGatewayImageJobRequest(
    new Request("https://cloud.test/__gateway/v1/customer/image-jobs", {
      method: "POST",
      headers: {
        ...customerHeaders(fixture.keyA.token, "image-job-storage-failure"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: fixture.deviceId,
        prompt: "a red apple on a table",
        width: 512,
        height: 512,
        steps: 20,
        cfg: 7,
        seed: 42,
      }),
    }),
    {
      db: failRunForSqlPrefix(fixture.db, "INSERT OR IGNORE INTO cloud_gateway_image_jobs"),
      sessions: fixture.sessions,
      artifacts: fixture.bucket,
      now: () => fixture.currentTime(),
    }
  );
  assert.equal(response?.status, 503);
  assert.deepEqual(await response?.json(), { error: "Image-job storage is unavailable" });
  const stored = fixture.db.db
    .prepare("SELECT COUNT(*) AS count FROM cloud_gateway_image_jobs")
    .get() as { count: number };
  assert.equal(stored.count, 0);
});

test("image-job control reports D1 state-update failures instead of a false cancellation", async () => {
  const fixture = await createFixture();
  const created = await createJob(fixture, "image-job-control-storage-failure");
  const job = (await created.json()) as { jobId: string };

  const response = await handleGatewayImageJobRequest(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/control`, {
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken),
    }),
    {
      db: failRunForSqlPrefix(
        fixture.db,
        "UPDATE cloud_gateway_image_jobs\n          SET state = 'running'"
      ),
      sessions: fixture.sessions,
      artifacts: fixture.bucket,
      now: () => fixture.currentTime(),
    }
  );

  assert.equal(response?.status, 503);
  assert.deepEqual(await response?.json(), { error: "Image-job storage is unavailable" });
  const stored = fixture.db.db
    .prepare("SELECT state FROM cloud_gateway_image_jobs WHERE job_id = ?")
    .get(job.jobId) as { state: string };
  assert.equal(stored.state, "queued");
});

test("image job rejects mismatched idempotency input and cancellation rejects late artifacts", async () => {
  const fixture = await createFixture();
  const first = await createJob(fixture);
  const job = (await first.json()) as { jobId: string };
  const conflict = await fixture.runtime.fetch(
    new Request("https://cloud.test/__gateway/v1/customer/image-jobs", {
      method: "POST",
      headers: {
        ...customerHeaders(fixture.keyA.token, "image-job-key-0001"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: fixture.deviceId,
        prompt: "different prompt",
        width: 512,
        height: 512,
        steps: 20,
        cfg: 7,
        seed: 42,
      }),
    })
  );
  assert.equal(conflict.status, 409);

  const cancelled = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/customer/image-jobs/${job.jobId}`, {
      method: "DELETE",
      headers: customerHeaders(fixture.keyA.token),
    })
  );
  assert.equal(cancelled.status, 202);
  assert.equal((await cancelled.json()).status, "cancelled");

  const lateUpload = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/artifact`, {
      method: "PUT",
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken, "image/png"),
      body: png,
    })
  );
  assert.equal(lateUpload.status, 409);
});

test("device failure after artifact upload removes the object and releases its DO request", async () => {
  const fixture = await createFixture();
  const created = await createJob(fixture, "image-job-failure-0001");
  const job = (await created.json()) as { jobId: string };
  await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/control`, {
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken),
    })
  );
  const upload = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/artifact`, {
      method: "PUT",
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken, "image/png"),
      body: png,
    })
  );
  assert.equal(upload.status, 200);
  const row = await fixture.db
    .prepare<{ object_key: string }>(
      "SELECT object_key FROM cloud_gateway_image_jobs WHERE job_id = ?"
    )
    .bind(job.jobId)
    .first();
  assert.ok(row);
  assert.ok(await fixture.bucket.get(row.object_key));

  const failed = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/fail`, {
      method: "POST",
      headers: {
        ...deviceHeaders(fixture.deviceId, fixture.session!.sessionToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: "execution_failed" }),
    })
  );
  assert.equal(failed.status, 200);
  assert.equal(await fixture.bucket.get(row.object_key), null);
  assert.equal(
    await coordinatorFromNamespace(fixture.sessions).getRequest(
      fixture.deviceId,
      job.jobId,
      fixture.now
    ),
    null
  );
});

test("image artifact rejects MIME spoofing, oversize input, and stalled request bodies", async () => {
  const fixture = await createFixture();
  const invalidParameters = await fixture.runtime.fetch(
    new Request("https://cloud.test/__gateway/v1/customer/image-jobs", {
      method: "POST",
      headers: {
        ...customerHeaders(fixture.keyA.token, "image-job-invalid-0001"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: fixture.deviceId,
        prompt: "invalid dimension",
        width: 65,
        height: 512,
        steps: 20,
        cfg: 7,
        seed: 42,
      }),
    })
  );
  assert.equal(invalidParameters.status, 400);

  const created = await createJob(fixture, "image-job-key-0002");
  const job = (await created.json()) as { jobId: string };
  const controlUrl = `https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/control`;
  await fixture.runtime.fetch(
    new Request(controlUrl, {
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken),
    })
  );

  const spoofed = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/artifact`, {
      method: "PUT",
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken, "image/jpeg"),
      body: png,
    })
  );
  assert.equal(spoofed.status, 415);

  const invalidMagic = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/artifact`, {
      method: "PUT",
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken, "image/png"),
      body: new Uint8Array(12),
    })
  );
  assert.equal(invalidMagic.status, 415);

  const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
  const tooLarge = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/artifact`, {
      method: "PUT",
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken, "image/png"),
      body: oversized,
    })
  );
  assert.equal(tooLarge.status, 413);

  const stalledBody = new ReadableStream<Uint8Array>({ start() {} });
  const stalled = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/artifact`, {
      method: "PUT",
      headers: deviceHeaders(fixture.deviceId, fixture.session!.sessionToken, "image/png"),
      body: stalledBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" })
  );
  assert.equal(stalled.status, 413);
});

test("image job active caps recover after expiry and uncertain R2 writes are deleted", async () => {
  const fixture = await createFixture();
  const first = await createJob(fixture, "image-job-capacity-001");
  const second = await createJob(fixture, "image-job-capacity-002");
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  const full = await createJob(fixture, "image-job-capacity-003");
  assert.equal(full.status, 429);

  fixture.advanceTime(5 * 60_000 + 1);
  const reconnected = await fixture.gateway.connect(fixture.deviceId, fixture.deviceCredential);
  assert.ok(reconnected);
  const afterExpiry = await createJob(fixture, "image-job-capacity-004");
  assert.equal(afterExpiry.status, 202);
  const job = (await afterExpiry.json()) as { jobId: string };
  await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/control`, {
      headers: deviceHeaders(fixture.deviceId, reconnected.sessionToken),
    })
  );

  fixture.bucket.failAfterPut = true;
  const failedUpload = await fixture.runtime.fetch(
    new Request(`https://cloud.test/__gateway/v1/device/image-jobs/${job.jobId}/artifact`, {
      method: "PUT",
      headers: deviceHeaders(fixture.deviceId, reconnected.sessionToken, "image/png"),
      body: png,
    })
  );
  assert.equal(failedUpload.status, 503);
  const row = await fixture.db
    .prepare<{ object_key: string }>(
      "SELECT object_key FROM cloud_gateway_image_jobs WHERE job_id = ?"
    )
    .bind(job.jobId)
    .first();
  assert.ok(row);
  assert.equal(await fixture.bucket.get(row.object_key), null);
});

test("image-job cleanup reports failed D1 deletion and a later pass recovers", async () => {
  const fixture = await createFixture();
  const created = await createJob(fixture, "image-job-cleanup-retry-0001");
  const job = (await created.json()) as { jobId: string };
  const cleanupAtMs = fixture.currentTime() + 5 * 60_000 + 1;
  const cleanupAt = new Date(cleanupAtMs).toISOString();
  const expiryAt = new Date(cleanupAtMs - 1).toISOString();
  await fixture.db
    .prepare(
      `UPDATE cloud_gateway_image_jobs
          SET expires_at = ?, retention_expires_at = ?
        WHERE job_id = ?`
    )
    .bind(expiryAt, cleanupAt, job.jobId)
    .run();
  const row = await fixture.db
    .prepare<{ object_key: string }>(
      "SELECT object_key FROM cloud_gateway_image_jobs WHERE job_id = ?"
    )
    .bind(job.jobId)
    .first();
  assert.ok(row);
  await fixture.bucket.put(row.object_key, png, { httpMetadata: { contentType: "image/png" } });

  await assert.rejects(
    cleanupExpiredCloudImageJobs(
      failRunForSqlPrefix(fixture.db, "DELETE FROM cloud_gateway_image_jobs"),
      fixture.bucket,
      cleanupAt
    ),
    { message: "D1 gateway image-job cleanup delete failed" }
  );
  assert.equal(await fixture.bucket.get(row.object_key), null);
  assert.ok(
    await fixture.db
      .prepare("SELECT job_id FROM cloud_gateway_image_jobs WHERE job_id = ?")
      .bind(job.jobId)
      .first(),
    "failed D1 cleanup must leave metadata available for a retry"
  );

  assert.equal(await cleanupExpiredCloudImageJobs(fixture.db, fixture.bucket, cleanupAt), 1);
  assert.equal(
    await fixture.db
      .prepare("SELECT job_id FROM cloud_gateway_image_jobs WHERE job_id = ?")
      .bind(job.jobId)
      .first(),
    null
  );
});
