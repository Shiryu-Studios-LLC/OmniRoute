import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import {
  claimCloudInferenceIdempotency as claimWithSecret,
  cleanupExpiredCloudInferenceResponses,
  CLOUD_INFERENCE_IDEMPOTENCY_GLOBAL_CAP,
  CLOUD_INFERENCE_IDEMPOTENCY_RESPONSE_TTL_MS,
  CLOUD_INFERENCE_IDEMPOTENCY_TOMBSTONE_TTL_MS,
  completeCloudInferenceIdempotency,
  hashCanonicalCloudInferenceRequest,
  markCloudInferenceOutcomeUnavailable,
  type CloudInferenceIdempotencyClaim,
} from "../../src/cloud/inferenceIdempotency";

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

const NOW_MS = Date.parse("2026-10-08T12:00:00.000Z");
const SCOPE = { tenantId: "tenant-a", principalId: "principal-a", apiKeyId: "key-a" };
const KEY = "inference-request-0001";
const REQUEST = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] };
const REQUEST_HASH_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(19)));

type ClaimInput = Parameters<typeof claimWithSecret>[1];

async function claimCloudInferenceIdempotency(
  db: CloudDb,
  input: Omit<ClaimInput, "requestHashSecret">
) {
  return claimWithSecret(db, { ...input, requestHashSecret: REQUEST_HASH_SECRET });
}

function failCleanupRun(
  db: CloudDb,
  sqlPrefix: string,
  onPrepare?: (sql: string) => void
): CloudDb {
  return {
    prepare<T = unknown>(sql: string): CloudDbStatement<T> {
      onPrepare?.(sql);
      const statement = db.prepare<T>(sql);
      if (!sql.trimStart().startsWith(sqlPrefix)) return statement;
      return {
        bind(...values: unknown[]) {
          statement.bind(...values);
          return this as unknown as CloudDbStatement<T>;
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
    },
    batch(statements) {
      return db.batch(statements);
    },
    exec(sql) {
      return db.exec(sql);
    },
  };
}

async function makeDb(options: { withCapacityMigration?: boolean } = {}): Promise<SqliteCloudDb> {
  const db = new SqliteCloudDb();
  const migrations = ["0001_cloud_runtime.sql", "0011_cloud_inference_idempotency.sql"];
  if (options.withCapacityMigration !== false) {
    migrations.push(
      "0012_cloud_inference_idempotency_capacity.sql",
      "0013_cloud_inference_idempotency_tombstone_retention.sql"
    );
  }
  for (const migration of migrations) {
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  }
  await db
    .prepare(
      `INSERT INTO tenants (id, name, slug, kind, is_active, created_at, updated_at)
       VALUES ('tenant-a', 'Tenant A', 'tenant-a', 'customer', 1, '2026-10-08', '2026-10-08'),
              ('tenant-b', 'Tenant B', 'tenant-b', 'customer', 1, '2026-10-08', '2026-10-08')`
    )
    .run();
  return db;
}

function storedRow(db: SqliteCloudDb, tenantId = SCOPE.tenantId) {
  return db.db
    .prepare(
      `SELECT tenant_id, principal_id, api_key_id, request_hash, request_id, state,
              response_status, response_body, response_expires_at_ms
         FROM cloud_inference_idempotency WHERE tenant_id = ?`
    )
    .get(tenantId) as Record<string, unknown> | undefined;
}

test("claim is atomic, canonical request fields bind the payload, and response replays", async () => {
  const db = await makeDb();
  const [first, concurrent] = await Promise.all([
    claimCloudInferenceIdempotency(db, { key: KEY, scope: SCOPE, request: REQUEST, nowMs: NOW_MS }),
    claimCloudInferenceIdempotency(db, {
      key: KEY,
      scope: SCOPE,
      request: { messages: [{ content: "hello", role: "user" }], model: "gpt-4o-mini" },
      nowMs: NOW_MS,
    }),
  ]);
  assert.deepEqual([first.kind, concurrent.kind].sort(), ["claimed", "in_progress"]);
  const claimed = first.kind === "claimed" ? first : concurrent;
  assert.equal(claimed.kind, "claimed");
  if (claimed.kind !== "claimed") throw new Error("claim expected");

  const changedRequest = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: { ...REQUEST, temperature: 0.1 },
    nowMs: NOW_MS + 1,
  });
  assert.deepEqual(changedRequest, { kind: "conflict" });

  assert.deepEqual(
    await completeCloudInferenceIdempotency(
      db,
      claimed.claim,
      { status: 200, body: '{"id":"response-1","choices":[]}' },
      NOW_MS + 10
    ),
    { kind: "completed" }
  );
  const replay = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS + 20,
  });
  assert.deepEqual(replay, {
    kind: "replay",
    requestId: claimed.claim.requestId,
    status: 200,
    body: '{"id":"response-1","choices":[]}',
  });
  const afterClaimWindow = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS + CLOUD_INFERENCE_IDEMPOTENCY_RESPONSE_TTL_MS + 5,
  });
  assert.equal(afterClaimWindow.kind, "replay", "the 24h replay window begins at completion");
  const afterResponseWindow = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS + CLOUD_INFERENCE_IDEMPOTENCY_RESPONSE_TTL_MS + 11,
  });
  assert.equal(afterResponseWindow.kind, "outcome_unavailable");
});

test("idempotency key is isolated by tenant, principal, and API key", async () => {
  const db = await makeDb();
  const first = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS,
  });
  const otherTenant = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: { ...SCOPE, tenantId: "tenant-b" },
    request: REQUEST,
    nowMs: NOW_MS,
  });
  const otherPrincipal = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: { ...SCOPE, principalId: "principal-b" },
    request: REQUEST,
    nowMs: NOW_MS,
  });
  const otherApiKey = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: { ...SCOPE, apiKeyId: "key-b" },
    request: REQUEST,
    nowMs: NOW_MS,
  });
  assert.equal(first.kind, "claimed");
  assert.equal(otherTenant.kind, "claimed");
  assert.equal(otherPrincipal.kind, "claimed");
  assert.equal(otherApiKey.kind, "claimed");
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM cloud_inference_idempotency").get().count,
    4
  );
  const fingerprints = db.db
    .prepare(
      "SELECT request_hash FROM cloud_inference_idempotency ORDER BY tenant_id, principal_id, api_key_id"
    )
    .all() as Array<{ request_hash: string }>;
  assert.equal(new Set(fingerprints.map((row) => row.request_hash)).size, 4);
  assert.ok(fingerprints.every((row) => /^[a-f0-9]{64}$/.test(row.request_hash)));
});

test("request fingerprint is secret keyed, rotation cannot create a second claim, and secrets are required", async () => {
  const db = await makeDb();
  const first = await claimWithSecret(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    requestHashSecret: REQUEST_HASH_SECRET,
    nowMs: NOW_MS,
  });
  assert.equal(first.kind, "claimed");
  const rotatedSecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(20)));
  const rotated = await claimWithSecret(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    requestHashSecret: rotatedSecret,
    nowMs: NOW_MS + 1,
  });
  assert.deepEqual(rotated, { kind: "conflict" });
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM cloud_inference_idempotency").get().count,
    1
  );
  const stored = storedRow(db);
  assert.notEqual(stored?.request_hash, REQUEST.messages[0].content);
  assert.notEqual(stored?.request_hash, KEY);

  await assert.rejects(
    () =>
      claimWithSecret(db, {
        key: "inference-request-0002",
        scope: SCOPE,
        request: REQUEST,
        requestHashSecret: "not-a-32-byte-secret",
      }),
    /request hash secret/i
  );
  await assert.rejects(
    () =>
      claimWithSecret(db, {
        key: "inference-request-0002",
        scope: SCOPE,
        request: REQUEST,
        requestHashSecret: undefined,
      } as unknown as ClaimInput),
    /request hash secret/i
  );
});

test("global tombstone capacity counter changes once per new key and duplicates bypass the cap", async () => {
  const db = await makeDb();
  const first = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS,
  });
  assert.equal(first.kind, "claimed");
  assert.equal(
    db.db
      .prepare("SELECT row_count FROM cloud_inference_idempotency_capacity WHERE singleton_id = 1")
      .get().row_count,
    1
  );

  const duplicate = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS + 1,
  });
  assert.equal(duplicate.kind, "in_progress");
  assert.equal(
    db.db
      .prepare("SELECT row_count FROM cloud_inference_idempotency_capacity WHERE singleton_id = 1")
      .get().row_count,
    1,
    "an ignored duplicate must not increment the capacity counter"
  );

  const second = await claimCloudInferenceIdempotency(db, {
    key: "inference-request-0002",
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS + 2,
  });
  assert.equal(second.kind, "claimed");
  assert.equal(
    db.db
      .prepare("SELECT row_count FROM cloud_inference_idempotency_capacity WHERE singleton_id = 1")
      .get().row_count,
    2
  );

  db.db
    .prepare("UPDATE cloud_inference_idempotency_capacity SET row_count = ? WHERE singleton_id = 1")
    .run(CLOUD_INFERENCE_IDEMPOTENCY_GLOBAL_CAP);
  assert.equal(
    (
      await claimCloudInferenceIdempotency(db, {
        key: KEY,
        scope: SCOPE,
        request: REQUEST,
        nowMs: NOW_MS + 3,
      })
    ).kind,
    "in_progress",
    "an existing key remains usable at capacity"
  );
  assert.equal(
    (
      await claimCloudInferenceIdempotency(db, {
        key: "inference-request-0003",
        scope: SCOPE,
        request: REQUEST,
        nowMs: NOW_MS + 4,
      })
    ).kind,
    "capacity"
  );
  assert.equal(
    db.db
      .prepare("SELECT row_count FROM cloud_inference_idempotency_capacity WHERE singleton_id = 1")
      .get().row_count,
    CLOUD_INFERENCE_IDEMPOTENCY_GLOBAL_CAP
  );
});

test("capacity migration backfills tombstones written by the previous migration", async () => {
  const db = await makeDb({ withCapacityMigration: false });
  const requestHash = await hashCanonicalCloudInferenceRequest(REQUEST, SCOPE, REQUEST_HASH_SECRET);
  db.db
    .prepare(
      `INSERT INTO cloud_inference_idempotency (
         tenant_id, principal_id, api_key_id, idempotency_key_hash, request_hash,
         request_id, claim_token, state, claimed_at_ms, claim_expires_at_ms,
         response_expires_at_ms, response_status, response_body, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, NULL, NULL, ?, ?)`
    )
    .run(
      SCOPE.tenantId,
      SCOPE.principalId,
      SCOPE.apiKeyId,
      createHash("sha256").update(KEY).digest("hex"),
      requestHash,
      "legacy-request-id",
      "legacy-claim-token",
      NOW_MS,
      NOW_MS + 120_000,
      NOW_MS + CLOUD_INFERENCE_IDEMPOTENCY_RESPONSE_TTL_MS,
      NOW_MS,
      NOW_MS
    );

  await db.exec(
    readFileSync(
      join(process.cwd(), "cloudflare/migrations", "0012_cloud_inference_idempotency_capacity.sql"),
      "utf8"
    )
  );
  assert.equal(
    db.db
      .prepare("SELECT row_count FROM cloud_inference_idempotency_capacity WHERE singleton_id = 1")
      .get().row_count,
    1
  );
  await db.exec(
    readFileSync(
      join(
        process.cwd(),
        "cloudflare/migrations",
        "0013_cloud_inference_idempotency_tombstone_retention.sql"
      ),
      "utf8"
    )
  );
  assert.equal(
    (
      await claimCloudInferenceIdempotency(db, {
        key: KEY,
        scope: SCOPE,
        request: REQUEST,
        nowMs: NOW_MS + 1,
      })
    ).kind,
    "in_progress"
  );
  assert.equal(
    db.db
      .prepare("SELECT row_count FROM cloud_inference_idempotency_capacity WHERE singleton_id = 1")
      .get().row_count,
    1,
    "the backfilled duplicate must not increment the counter"
  );
});

test("expired response cleanup clears bounded payloads and permanently preserves tombstones", async () => {
  const db = await makeDb();
  const claims: CloudInferenceIdempotencyClaim[] = [];
  for (const suffix of ["0001", "0002", "0003"]) {
    const result = await claimCloudInferenceIdempotency(db, {
      key: `inference-request-${suffix}`,
      scope: SCOPE,
      request: REQUEST,
      nowMs: NOW_MS,
    });
    assert.equal(result.kind, "claimed");
    if (result.kind === "claimed") claims.push(result.claim);
    await completeCloudInferenceIdempotency(
      db,
      result.kind === "claimed" ? result.claim : claims[claims.length - 1],
      { status: 200, body: `{"id":"${suffix}"}` },
      NOW_MS
    );
  }

  const cleanupNow = NOW_MS + CLOUD_INFERENCE_IDEMPOTENCY_RESPONSE_TTL_MS + 1;
  assert.equal(
    await cleanupExpiredCloudInferenceResponses(db, { nowMs: cleanupNow, batchSize: 2 }),
    2
  );
  assert.equal(
    db.db
      .prepare(
        "SELECT COUNT(*) AS count FROM cloud_inference_idempotency WHERE state = 'completed'"
      )
      .get().count,
    1
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM cloud_inference_idempotency").get().count,
    3
  );

  const keyResult = await claimCloudInferenceIdempotency(db, {
    key: "inference-request-0001",
    scope: SCOPE,
    request: REQUEST,
    nowMs: cleanupNow,
  });
  assert.equal(keyResult.kind, "outcome_unavailable");
  const cleanedRows = db.db
    .prepare(
      "SELECT state, response_body FROM cloud_inference_idempotency ORDER BY idempotency_key_hash"
    )
    .all() as Array<{ state: string; response_body: string | null }>;
  assert.equal(cleanedRows.filter((row) => row.state === "outcome_unavailable").length, 2);
  assert.equal(cleanedRows.filter((row) => row.response_body !== null).length, 1);
});

test("30-day tombstone cleanup is bounded and frees the global cap counter", async () => {
  const db = await makeDb();
  const first = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS,
  });
  const later = await claimCloudInferenceIdempotency(db, {
    key: "inference-request-0002",
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS + 10 * 24 * 60 * 60 * 1000,
  });
  assert.equal(first.kind, "claimed");
  assert.equal(later.kind, "claimed");
  const cleanupAt = NOW_MS + CLOUD_INFERENCE_IDEMPOTENCY_TOMBSTONE_TTL_MS + 1;
  assert.equal(
    await cleanupExpiredCloudInferenceResponses(db, { nowMs: cleanupAt, batchSize: 1 }),
    1
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM cloud_inference_idempotency").get().count,
    1
  );
  assert.equal(
    db.db
      .prepare("SELECT row_count FROM cloud_inference_idempotency_capacity WHERE singleton_id = 1")
      .get().row_count,
    1,
    "deleting a tombstone decrements the global capacity counter"
  );
  assert.equal(
    (
      await claimCloudInferenceIdempotency(db, {
        key: KEY,
        scope: SCOPE,
        request: REQUEST,
        nowMs: cleanupAt,
      })
    ).kind,
    "claimed",
    "a key can be reused after its documented tombstone retention period"
  );

  db.db
    .prepare("UPDATE cloud_inference_idempotency_capacity SET row_count = ? WHERE singleton_id = 1")
    .run(CLOUD_INFERENCE_IDEMPOTENCY_GLOBAL_CAP);
  const beforeDelete = CLOUD_INFERENCE_IDEMPOTENCY_GLOBAL_CAP;
  const nextExpiry =
    NOW_MS + CLOUD_INFERENCE_IDEMPOTENCY_TOMBSTONE_TTL_MS + 10 * 24 * 60 * 60 * 1000;
  assert.equal(
    await cleanupExpiredCloudInferenceResponses(db, { nowMs: nextExpiry, batchSize: 1 }),
    1
  );
  assert.equal(
    db.db
      .prepare("SELECT row_count FROM cloud_inference_idempotency_capacity WHERE singleton_id = 1")
      .get().row_count,
    beforeDelete - 1
  );
  assert.equal(
    (
      await claimCloudInferenceIdempotency(db, {
        key: "inference-request-0003",
        scope: SCOPE,
        request: REQUEST,
        nowMs: nextExpiry,
      })
    ).kind,
    "claimed",
    "capacity released by cleanup can be used for a new tombstone"
  );
});

test("expired inference cleanup rejects failed D1 operations without continuing", async () => {
  const db = await makeDb();
  let responseUpdatePrepared = false;
  const failingDb = failCleanupRun(db, "DELETE FROM cloud_inference_idempotency", (sql) => {
    if (sql.trimStart().startsWith("UPDATE cloud_inference_idempotency")) {
      responseUpdatePrepared = true;
    }
  });

  await assert.rejects(cleanupExpiredCloudInferenceResponses(failingDb, { nowMs: NOW_MS + 1 }), {
    message: "Cloud inference idempotency cleanup failed",
  });
  assert.equal(responseUpdatePrepared, false, "a failed tombstone delete must stop the cleanup");
});

test("expired inference cleanup reports a failed response update", async () => {
  const db = await makeDb();
  const claim = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS,
  });
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") assert.fail("expected an idempotency claim");
  await completeCloudInferenceIdempotency(
    db,
    claim.claim,
    { status: 200, body: '{"id":"expired-response"}' },
    NOW_MS
  );
  const failingDb = failCleanupRun(db, "UPDATE cloud_inference_idempotency");

  await assert.rejects(
    cleanupExpiredCloudInferenceResponses(failingDb, {
      nowMs: NOW_MS + CLOUD_INFERENCE_IDEMPOTENCY_RESPONSE_TTL_MS + 1,
      batchSize: 1,
    }),
    { message: "Cloud inference idempotency cleanup failed" }
  );
});

test("an abandoned claim becomes outcome unavailable instead of dispatching again", async () => {
  const db = await makeDb();
  const claim = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS,
  });
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;

  const expired = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS + 2 * 60_000 + 1,
  });
  assert.deepEqual(expired, { kind: "outcome_unavailable", requestId: claim.claim.requestId });
  assert.deepEqual(
    await claimCloudInferenceIdempotency(db, {
      key: KEY,
      scope: SCOPE,
      request: REQUEST,
      nowMs: NOW_MS + 3 * 60_000,
    }),
    { kind: "outcome_unavailable", requestId: claim.claim.requestId }
  );
  assert.equal(storedRow(db)?.state, "outcome_unavailable");
});

test("explicit uncertain outcomes and oversized responses retain compact tombstones", async () => {
  const db = await makeDb();
  const first = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS,
  });
  assert.equal(first.kind, "claimed");
  if (first.kind !== "claimed") return;
  assert.equal(await markCloudInferenceOutcomeUnavailable(db, first.claim, NOW_MS + 1), true);
  const retry = await claimCloudInferenceIdempotency(db, {
    key: KEY,
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS + 2,
  });
  assert.equal(retry.kind, "outcome_unavailable");

  const second = await claimCloudInferenceIdempotency(db, {
    key: "inference-request-0002",
    scope: SCOPE,
    request: REQUEST,
    nowMs: NOW_MS,
  });
  assert.equal(second.kind, "claimed");
  if (second.kind !== "claimed") return;
  const tooLarge = await completeCloudInferenceIdempotency(
    db,
    second.claim,
    { status: 200, body: "é".repeat(70_000) },
    NOW_MS + 1
  );
  assert.deepEqual(tooLarge, { kind: "outcome_unavailable" });
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM cloud_inference_idempotency").get().count,
    2
  );
});

test("invalid keys and non-JSON requests fail closed", async () => {
  const db = await makeDb();
  assert.deepEqual(
    await claimCloudInferenceIdempotency(db, { key: "bad", scope: SCOPE, request: REQUEST }),
    { kind: "conflict" }
  );
  await assert.rejects(
    () =>
      claimCloudInferenceIdempotency(db, { key: KEY, scope: SCOPE, request: { value: undefined } }),
    /not JSON-safe/i
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM cloud_inference_idempotency").get().count,
    0
  );
});
