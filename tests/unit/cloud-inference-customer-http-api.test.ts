import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloudDb, CloudDbStatement } from "../../src/cloud/db";
import {
  createCloudCustomerMembership,
  issueCloudCustomerApiKey,
} from "../../src/cloud/customerIdentity";
import { encryptCloudCredential } from "../../src/cloud/credentialEncryption";
import { createCloudProviderConnection } from "../../src/cloud/providers";
import {
  setCloudInferenceEntitlement,
  setCloudInferenceMonthlyBudget,
} from "../../src/cloud/inferencePolicy";
import {
  CLOUD_INFERENCE_COUNT_URL,
  CLOUD_INFERENCE_RESPONSE_URL,
} from "../../src/cloud/inferenceCustomerHttpApi";
import { createCloudRuntime } from "../../src/cloud/runtime";

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
  async all<U = T>(): Promise<{ results: U[]; success: boolean }> {
    return {
      results: this.db.prepare(this.sql).all(...(this.values as never[])) as U[],
      success: true,
    };
  }
  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
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

const NOW = "2026-10-08T12:00:00.000Z";
const WRAP_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OPENAI_KEY = "sk-test-never-log-this-key";
const IDEMPOTENCY_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

async function fixture(
  options: {
    entitlement?: boolean;
    monthlyTokenLimit?: number;
    role?: "owner" | "admin" | "member" | "viewer";
  } = {}
) {
  const db = new SqliteCloudDb();
  for (const migration of [
    "0001_cloud_runtime.sql",
    "0002_cloud_usage_audit_rate_limits.sql",
    "0003_cloud_platform_tenant.sql",
    "0005_cloud_customer_identity.sql",
    "0010_cloud_inference_policy.sql",
    "0011_cloud_inference_idempotency.sql",
    "0012_cloud_inference_idempotency_capacity.sql",
    "0013_cloud_inference_idempotency_tombstone_retention.sql",
    "0014_cloud_inference_reservation_retention.sql",
  ])
    await db.exec(readFileSync(join(process.cwd(), "cloudflare/migrations", migration), "utf8"));
  for (const [id, name, slug] of [
    [TENANT_A, "Tenant A", TENANT_A],
    [TENANT_B, "Tenant B", TENANT_B],
  ]) {
    await db
      .prepare(
        `INSERT INTO tenants (id,name,slug,kind,is_active,created_at,updated_at)
      VALUES (?, ?, ?, 'customer', 1, ?, ?)`
      )
      .bind(id, name, slug, NOW, NOW)
      .run();
  }
  const membership = await createCloudCustomerMembership(db, {
    tenantId: TENANT_A,
    principalId: "member-a",
    role: options.role ?? "owner",
    now: NOW,
  });
  const issued = await issueCloudCustomerApiKey(db, {
    tenantId: TENANT_A,
    membershipId: membership.id,
    now: NOW,
  });
  if (options.entitlement !== false) {
    await setCloudInferenceMonthlyBudget(db, {
      tenantId: TENANT_A,
      monthlyTokenLimit: options.monthlyTokenLimit ?? 1000,
      now: NOW,
    });
    await setCloudInferenceEntitlement(db, {
      tenantId: TENANT_A,
      provider: "openai",
      model: "gpt-4o-mini-2024-07-18",
      enabled: true,
      maxInputTokens: 100,
      maxOutputTokens: 40,
      now: NOW,
    });
  }
  const connectionId = "connection-a";
  const apiKey = await encryptCloudCredential(OPENAI_KEY, WRAP_KEY, {
    tenantId: TENANT_A,
    connectionId,
    field: "apiKey",
  });
  await createCloudProviderConnection(db, {
    id: connectionId,
    tenantId: TENANT_A,
    provider: "openai",
    apiKey,
    createdAt: NOW,
    updatedAt: NOW,
  });
  let clock = Date.parse(NOW);
  const runtime = (fetcher: typeof fetch, extra: Record<string, unknown> = {}) =>
    createCloudRuntime({
      env: {
        DB: db,
        OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: WRAP_KEY,
        OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: IDEMPOTENCY_SECRET,
      },
      now: () => new Date(clock),
      fetcher,
      cloudInferenceRateLimit: { limit: 100, windowMs: 60_000 },
      cloudInferenceAuthFailureRateLimit: { limit: 100, windowMs: 60_000 },
      ...extra,
    });
  return {
    db,
    issued,
    runtime,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function request(token: string, key = "idempotency-key-0001", content = "hello", stream = false) {
  return new Request("https://cloud.test/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-2024-07-18",
      messages: [{ role: "user", content }],
      ...(stream ? { stream: true } : {}),
    }),
  });
}

function upstream(): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    assert.equal(new URL(url).origin, "https://api.openai.com");
    assert.equal(
      new URL(url).pathname,
      url.endsWith("input_tokens") ? "/v1/responses/input_tokens" : "/v1/responses"
    );
    assert.equal((init as RequestInit).redirect, "manual");
    assert.equal(
      new Headers((init as RequestInit).headers).get("authorization"),
      `Bearer ${OPENAI_KEY}`
    );
    if (url.endsWith("input_tokens"))
      return Response.json({ object: "response.input_tokens", input_tokens: 5 });
    return Response.json({
      id: "resp_123",
      object: "response",
      model: "gpt-4o-mini-2024-07-18",
      status: "completed",
      created_at: 10,
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "world" }] },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    });
  };
}

test("fixed Responses endpoints, decrypts tenant-bound credential, records usage/audit, and replays without dispatch", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const fetcher: typeof fetch = async (...args) => {
      calls += 1;
      return upstream()(...args);
    };
    const app = f.runtime(fetcher);
    const first = await app.fetch(request(f.issued.token));
    assert.equal(first.status, 200);
    const firstText = await first.text();
    assert.equal(JSON.parse(firstText).object, "chat.completion");
    assert.match(first.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(calls, 2);
    const replay = await app.fetch(request(f.issued.token));
    assert.equal(replay.status, 200);
    assert.match(replay.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(await replay.text(), firstText);
    assert.equal(calls, 2);
    const usage = await f.db
      .prepare<{ tokens_input: number; tokens_output: number }>(
        "SELECT tokens_input,tokens_output FROM cloud_usage_history WHERE tenant_id=?"
      )
      .bind(TENANT_A)
      .first();
    assert.equal(usage?.tokens_input, 5);
    assert.equal(usage?.tokens_output, 2);
    const audits = await f.db
      .prepare<{ metadata_json: string; status: string }>(
        "SELECT metadata_json,status FROM cloud_compliance_audit WHERE tenant_id=? ORDER BY timestamp"
      )
      .bind(TENANT_A)
      .all();
    assert.equal(audits.results.at(-1)?.status, "success");
    assert.ok(audits.results.every((entry) => !entry.metadata_json.includes("hello")));
    assert.ok(audits.results.every((entry) => !entry.metadata_json.includes(OPENAI_KEY)));
    assert.ok(!firstText.includes(OPENAI_KEY));
    const storedKey = await f.db
      .prepare<{ api_key: string }>(
        "SELECT api_key FROM provider_connections WHERE tenant_id=? AND id='connection-a'"
      )
      .bind(TENANT_A)
      .first();
    assert.ok(storedKey?.api_key.startsWith("enc:v2:"));
    assert.notEqual(storedKey?.api_key, OPENAI_KEY);
  } finally {
    f.db.db.close();
  }
});

test("streaming inference settles terminal usage before done and replays the exact SSE transcript", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    let upstreamStreamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const terminalEvent =
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","model":"gpt-4o-mini-2024-07-18","status":"completed","created_at":10,"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"world"}]}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n';
    const fetcher: typeof fetch = async (input, init) => {
      calls += 1;
      const url = String(input);
      if (url.endsWith("input_tokens"))
        return Response.json({ object: "response.input_tokens", input_tokens: 5 });
      const requestBody = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      assert.equal(requestBody.stream, true);
      assert.equal(new Headers((init as RequestInit).headers).get("accept"), "text/event-stream");
      const firstDelta =
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"world"}\n\n';
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstreamStreamController = controller;
            controller.enqueue(new TextEncoder().encode(firstDelta));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };
    const app = f.runtime(fetcher);
    const first = await app.fetch(
      request(f.issued.token, "idempotency-stream-success", "hello", true)
    );
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type") ?? "", /^text\/event-stream/);
    const streamReader = first.body!.getReader();
    const decoder = new TextDecoder();
    let transcript = "";
    const roleChunk = await streamReader.read();
    assert.equal(roleChunk.done, false);
    transcript += decoder.decode(roleChunk.value);
    const deltaChunk = await streamReader.read();
    assert.equal(deltaChunk.done, false);
    transcript += decoder.decode(deltaChunk.value);
    assert.match(transcript, /"content":"world"/);
    assert.ok(!transcript.includes("[DONE]"));
    const pendingReservation = await f.db
      .prepare<{ status: string }>(
        "SELECT status FROM cloud_inference_reservations WHERE tenant_id=?"
      )
      .bind(TENANT_A)
      .first();
    assert.equal(pendingReservation?.status, "reserved");
    assert.ok(upstreamStreamController);
    upstreamStreamController!.enqueue(new TextEncoder().encode(terminalEvent));
    upstreamStreamController!.close();
    while (true) {
      const next = await streamReader.read();
      if (next.done) break;
      transcript += decoder.decode(next.value);
    }
    transcript += decoder.decode();
    assert.ok(transcript.endsWith("data: [DONE]\n\n"));
    assert.equal(calls, 2);
    const settled = await f.db
      .prepare<{ actual_input_tokens: number; actual_output_tokens: number; status: string }>(
        "SELECT actual_input_tokens,actual_output_tokens,status FROM cloud_inference_reservations WHERE tenant_id=?"
      )
      .bind(TENANT_A)
      .first();
    assert.equal(settled?.actual_input_tokens, 5);
    assert.equal(settled?.actual_output_tokens, 2);
    assert.equal(settled?.status, "settled");
    const replay = await app.fetch(
      request(f.issued.token, "idempotency-stream-success", "hello", true)
    );
    assert.match(replay.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(await replay.text(), transcript);
    assert.equal(calls, 2, "a streaming replay does not call the provider again");
    assert.equal(
      (await app.fetch(request(f.issued.token, "idempotency-stream-success", "hello", false)))
        .status,
      409,
      "stream and non-stream operations have different fingerprints"
    );
    assert.equal(calls, 2);
  } finally {
    f.db.db.close();
  }
});

test("unary inference rejects a generation redirect without reading its body or following Location", async () => {
  const f = await fixture();
  try {
    const requestedUrls: string[] = [];
    let redirectBodyCancelled = false;
    const fetcher: typeof fetch = async (input, init) => {
      requestedUrls.push(String(input));
      assert.equal((init as RequestInit).redirect, "manual");
      if (String(input) === CLOUD_INFERENCE_COUNT_URL) {
        return Response.json({ object: "response.input_tokens", input_tokens: 5 });
      }
      assert.equal(String(input), CLOUD_INFERENCE_RESPONSE_URL);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("redirect body must not be read"));
          },
          cancel() {
            redirectBodyCancelled = true;
          },
        }),
        { status: 302, headers: { Location: "https://redirect.example/collect" } }
      );
    };
    const response = await f
      .runtime(fetcher)
      .fetch(request(f.issued.token, "idempotency-unary-redirect"));
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes("redirect body must not be read"), false);
    assert.equal(redirectBodyCancelled, true);
    assert.deepEqual(requestedUrls, [CLOUD_INFERENCE_COUNT_URL, CLOUD_INFERENCE_RESPONSE_URL]);
  } finally {
    f.db.db.close();
  }
});

test("streaming inference rejects a generation redirect without reading its body or following Location", async () => {
  const f = await fixture();
  try {
    const requestedUrls: string[] = [];
    let redirectBodyCancelled = false;
    const fetcher: typeof fetch = async (input, init) => {
      requestedUrls.push(String(input));
      assert.equal((init as RequestInit).redirect, "manual");
      if (String(input) === CLOUD_INFERENCE_COUNT_URL) {
        return Response.json({ object: "response.input_tokens", input_tokens: 5 });
      }
      assert.equal(String(input), CLOUD_INFERENCE_RESPONSE_URL);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("redirect body must not be read"));
          },
          cancel() {
            redirectBodyCancelled = true;
          },
        }),
        { status: 302, headers: { Location: "https://redirect.example/collect" } }
      );
    };
    const response = await f
      .runtime(fetcher)
      .fetch(request(f.issued.token, "idempotency-stream-redirect", "hello", true));
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes("redirect body must not be read"), false);
    assert.equal(redirectBodyCancelled, true);
    assert.deepEqual(requestedUrls, [CLOUD_INFERENCE_COUNT_URL, CLOUD_INFERENCE_RESPONSE_URL]);
  } finally {
    f.db.db.close();
  }
});

test("token-count preflight rejects a redirect without reading its body or following Location", async () => {
  const f = await fixture();
  try {
    const requestedUrls: string[] = [];
    let redirectBodyCancelled = false;
    const fetcher: typeof fetch = async (input, init) => {
      requestedUrls.push(String(input));
      assert.equal((init as RequestInit).redirect, "manual");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("redirect body must not be read"));
          },
          cancel() {
            redirectBodyCancelled = true;
          },
        }),
        { status: 302, headers: { Location: "https://redirect.example/collect" } }
      );
    };
    const response = await f
      .runtime(fetcher)
      .fetch(request(f.issued.token, "idempotency-count-redirect"));
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes("redirect body must not be read"), false);
    assert.equal(redirectBodyCancelled, true);
    assert.deepEqual(requestedUrls, [CLOUD_INFERENCE_COUNT_URL]);
  } finally {
    f.db.db.close();
  }
});

test("client cancellation aborts streaming generation and settles the reserved maximum", async () => {
  const f = await fixture();
  try {
    let upstreamAborted = false;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith("input_tokens"))
        return Response.json({ object: "response.input_tokens", input_tokens: 5 });
      (init as RequestInit).signal?.addEventListener("abort", () => {
        upstreamAborted = true;
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n'
              )
            );
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };
    const app = f.runtime(fetcher);
    const key = "idempotency-stream-cancel";
    const response = await app.fetch(request(f.issued.token, key, "hello", true));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("test client disconnect");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(upstreamAborted, true);
    const reservation = await f.db
      .prepare<{ actual_input_tokens: number; actual_output_tokens: number; status: string }>(
        "SELECT actual_input_tokens,actual_output_tokens,status FROM cloud_inference_reservations WHERE tenant_id=?"
      )
      .bind(TENANT_A)
      .first();
    assert.equal(reservation?.actual_input_tokens, 5);
    assert.equal(reservation?.actual_output_tokens, 40);
    assert.equal(reservation?.status, "settled");
    const idempotency = await f.db
      .prepare<{ state: string }>(
        "SELECT state FROM cloud_inference_idempotency WHERE request_id=(SELECT reservation_id FROM cloud_inference_reservations WHERE tenant_id=?)"
      )
      .bind(TENANT_A)
      .first();
    assert.equal(idempotency?.state, "outcome_unavailable");
    assert.equal((await app.fetch(request(f.issued.token, key, "hello", true))).status, 503);
  } finally {
    f.db.db.close();
  }
});

test("a failed idempotency tombstone write still closes the SSE response without reopening dispatch", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    let upstreamStreamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let failTombstoneWrites = false;
    const originalPrepare = f.db.prepare.bind(f.db);
    f.db.prepare = ((sql: string) => {
      if (
        failTombstoneWrites &&
        sql.includes("UPDATE cloud_inference_idempotency") &&
        sql.includes("state = 'outcome_unavailable'")
      ) {
        const statement: CloudDbStatement = {
          bind() {
            return this;
          },
          async first<U = unknown>(): Promise<U | null> {
            return null;
          },
          async all<U = unknown>(): Promise<{ results: U[]; success: boolean }> {
            return { results: [], success: false };
          },
          async run(): Promise<{ success: boolean }> {
            throw new Error("simulated D1 tombstone write failure");
          },
        };
        return statement;
      }
      return originalPrepare(sql);
    }) as typeof f.db.prepare;
    const fetcher: typeof fetch = async (input) => {
      calls += 1;
      if (String(input).endsWith("input_tokens"))
        return Response.json({ object: "response.input_tokens", input_tokens: 5 });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstreamStreamController = controller;
            controller.enqueue(
              new TextEncoder().encode(
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n'
              )
            );
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };
    const app = f.runtime(fetcher);
    const key = "idempotency-stream-tombstone-db-failure";
    const response = await app.fetch(request(f.issued.token, key, "hello", true));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();

    failTombstoneWrites = true;
    upstreamStreamController!.enqueue(new TextEncoder().encode("data: invalid-json\n\n"));
    upstreamStreamController!.close();
    let transcript = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      transcript += new TextDecoder().decode(next.value);
    }
    assert.match(transcript, /Inference result could not be safely confirmed/);
    assert.ok(!transcript.includes("[DONE]"));
    const reservation = await f.db
      .prepare<{ actual_output_tokens: number; status: string }>(
        "SELECT actual_output_tokens,status FROM cloud_inference_reservations WHERE tenant_id=?"
      )
      .bind(TENANT_A)
      .first();
    assert.equal(reservation?.actual_output_tokens, 40);
    assert.equal(reservation?.status, "settled");
    assert.equal(
      (await app.fetch(request(f.issued.token, key, "hello", true))).status,
      409,
      "the existing live claim blocks dispatch while tombstone writes are unavailable"
    );
    f.advance(2 * 60 * 1000 + 1);
    assert.equal(
      (await app.fetch(request(f.issued.token, key, "hello", true))).status,
      503,
      "an expired uncertain claim fails closed when D1 cannot tombstone it"
    );
    assert.equal(calls, 2, "an unavailable ledger prevents redispatch");
  } finally {
    f.db.db.close();
  }
});

test("cached stream-request policy errors replay as JSON without reserving tokens", async () => {
  const f = await fixture({ entitlement: false });
  try {
    let calls = 0;
    const app = f.runtime(async () => {
      calls += 1;
      throw new Error("disabled entitlement must not call upstream");
    });
    const key = "idempotency-stream-policy-denied";
    const first = await app.fetch(request(f.issued.token, key, "hello", true));
    assert.equal(first.status, 403);
    assert.match(first.headers.get("content-type") ?? "", /^application\/json/);
    const firstBody = await first.text();
    const replay = await app.fetch(request(f.issued.token, key, "hello", true));
    assert.equal(replay.status, 403);
    assert.match(replay.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(await replay.text(), firstBody);
    assert.equal(calls, 0);
    const reservation = await f.db
      .prepare("SELECT reservation_id FROM cloud_inference_reservations WHERE tenant_id=?")
      .bind(TENANT_A)
      .first();
    assert.equal(reservation, null);
  } finally {
    f.db.db.close();
  }
});

test("idempotency conflicts, revocation, and tenant isolation deny before provider dispatch", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const app = f.runtime(async (...args) => {
      calls += 1;
      return upstream()(...args);
    });
    const first = await app.fetch(request(f.issued.token));
    assert.equal(first.status, 200, await first.text());
    assert.equal(
      (await app.fetch(request(f.issued.token, "idempotency-key-0001", "different"))).status,
      409
    );
    const membership = await f.db
      .prepare<{ id: string }>("SELECT id FROM cloud_customer_memberships WHERE tenant_id=?")
      .bind(TENANT_A)
      .first();
    await f.db
      .prepare("UPDATE cloud_customer_memberships SET is_active=0 WHERE id=?")
      .bind(membership?.id)
      .run();
    assert.equal((await app.fetch(request(f.issued.token, "idempotency-key-0002"))).status, 401);
    assert.equal(calls, 2, "only the first operation's count and generation dispatch occurred");
    const tenantBMembership = await createCloudCustomerMembership(f.db, {
      tenantId: TENANT_B,
      principalId: "member-b",
      role: "owner",
      now: NOW,
    });
    const tenantBKey = await issueCloudCustomerApiKey(f.db, {
      tenantId: TENANT_B,
      membershipId: tenantBMembership.id,
      now: NOW,
    });
    await setCloudInferenceMonthlyBudget(f.db, {
      tenantId: TENANT_B,
      monthlyTokenLimit: 1000,
      now: NOW,
    });
    await setCloudInferenceEntitlement(f.db, {
      tenantId: TENANT_B,
      provider: "openai",
      model: "gpt-4o-mini-2024-07-18",
      enabled: true,
      maxInputTokens: 100,
      maxOutputTokens: 40,
      now: NOW,
    });
    assert.equal(
      (await app.fetch(request(tenantBKey.token, "idempotency-key-0003"))).status,
      503,
      "tenant B cannot reuse tenant A's provider credential"
    );
    assert.equal(calls, 2, "tenant B is rejected before an outbound request");
  } finally {
    f.db.db.close();
  }
});

test("stalled authenticated request bodies time out and cancel the reader", async () => {
  const f = await fixture();
  try {
    let cancelled = false;
    const stalledBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const stalledRequest = new Request("https://cloud.test/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.issued.token}`,
        "content-type": "application/json",
        "idempotency-key": "idempotency-stalled-body",
      },
      body: stalledBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await f
      .runtime(
        async () => {
          throw new Error("stalled body must not reach an upstream");
        },
        { cloudInferenceRequestBodyTimeoutMs: 5 }
      )
      .fetch(stalledRequest);
    assert.equal(response.status, 408);
    assert.equal(cancelled, true);
  } finally {
    f.db.db.close();
  }
});

test("tenant rate limit runs before request body parsing", async () => {
  const f = await fixture();
  try {
    const app = f.runtime(
      async () => {
        throw new Error("body parsing should be denied before dispatch");
      },
      { cloudInferenceRateLimit: { limit: 1, windowMs: 60_000 } }
    );
    const first = new Request("https://cloud.test/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.issued.token}`,
        "content-type": "application/json",
        "idempotency-key": "idempotency-first-invalid-body",
      },
      body: "{}",
    });
    assert.equal((await app.fetch(first)).status, 400);

    const second = new Request("https://cloud.test/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.issued.token}`,
        "content-type": "application/json",
        "idempotency-key": "idempotency-second-stalled",
      },
      body: new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("rate-limited body was read");
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    assert.equal((await app.fetch(second)).status, 429);
    assert.equal(second.bodyUsed, false);
  } finally {
    f.db.db.close();
  }
});

test("viewer membership and unsupported generation features are rejected before provider calls", async () => {
  const viewer = await fixture({ role: "viewer" });
  const owner = await fixture();
  try {
    let calls = 0;
    const viewerApp = viewer.runtime(async () => {
      calls += 1;
      throw new Error("viewer must not dispatch");
    });
    assert.equal((await viewerApp.fetch(request(viewer.issued.token))).status, 403);

    const ownerApp = owner.runtime(async () => {
      calls += 1;
      throw new Error("unsupported request must not dispatch");
    });
    const unsupported = request(owner.issued.token, "idempotency-key-unsupported");
    const requestWithUnsupportedFeature = new Request(unsupported.url, {
      method: "POST",
      headers: unsupported.headers,
      body: JSON.stringify({
        model: "gpt-4o-mini-2024-07-18",
        messages: [{ role: "user", content: "hello" }],
        stream_options: { include_usage: true },
      }),
    });
    assert.equal((await ownerApp.fetch(requestWithUnsupportedFeature)).status, 400);
    assert.equal(calls, 0);
  } finally {
    viewer.db.db.close();
    owner.db.db.close();
  }
});

test("missing or reused idempotency secret fails closed before provider access", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const fetcher: typeof fetch = async (...args) => {
      calls += 1;
      return upstream()(...args);
    };
    const noSecret = f.runtime(fetcher, {
      env: { DB: f.db, OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: WRAP_KEY },
    });
    assert.equal((await noSecret.fetch(request(f.issued.token))).status, 503);
    const reusedSecret = f.runtime(fetcher, {
      env: {
        DB: f.db,
        OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: WRAP_KEY,
        OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: WRAP_KEY,
      },
    });
    assert.equal(
      (await reusedSecret.fetch(request(f.issued.token, "idempotency-key-reused-secret"))).status,
      503
    );
    assert.equal(calls, 0);
  } finally {
    f.db.db.close();
  }
});

test("Cloudflare edge-IP authentication throttling counts missing and malformed bearer headers", async () => {
  const f = await fixture();
  try {
    const app = f.runtime(upstream(), {
      cloudInferenceAuthFailureRateLimit: { limit: 1, windowMs: 60_000 },
    });
    const malformed = new Request("https://cloud.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer malformed", "cf-connecting-ip": "192.0.2.44" },
    });
    Object.assign(malformed, { cf: { colo: "DFW" } });
    assert.equal((await app.fetch(malformed)).status, 401);
    const missing = new Request("https://cloud.test/v1/chat/completions", { method: "POST" });
    Object.assign(missing, { cf: { colo: "DFW" } });
    missing.headers.set("cf-connecting-ip", "192.0.2.44");
    assert.equal((await app.fetch(missing)).status, 429);
  } finally {
    f.db.db.close();
  }
});

test("edge-IP auth limiter also counts unsupported methods and query strings", async () => {
  const f = await fixture();
  try {
    const app = f.runtime(upstream(), {
      cloudInferenceAuthFailureRateLimit: { limit: 2, windowMs: 60_000 },
    });
    const makeEdgeRequest = (url: string, method: string) => {
      const req = new Request(url, {
        method,
        headers: { "cf-connecting-ip": "192.0.2.45" },
      });
      Object.assign(req, { cf: { colo: "DFW" } });
      return req;
    };
    assert.equal(
      (await app.fetch(makeEdgeRequest("https://cloud.test/v1/chat/completions", "GET"))).status,
      405
    );
    assert.equal(
      (
        await app.fetch(
          makeEdgeRequest("https://cloud.test/v1/chat/completions?unsupported=1", "POST")
        )
      ).status,
      400
    );
    assert.equal(
      (await app.fetch(makeEdgeRequest("https://cloud.test/v1/chat/completions", "POST"))).status,
      429
    );
  } finally {
    f.db.db.close();
  }
});

test("default deny and monthly budget denial do not invoke generation", async () => {
  const noPolicy = await fixture({ entitlement: false });
  const lowBudget = await fixture({ monthlyTokenLimit: 6 });
  try {
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      calls += 1;
      if (String(input).endsWith("input_tokens"))
        return Response.json({ object: "response.input_tokens", input_tokens: 5 });
      throw new Error("generation must be denied");
    };
    assert.equal(
      (await noPolicy.runtime(fetcher).fetch(request(noPolicy.issued.token))).status,
      403
    );
    assert.equal(calls, 0, "default deny does not call count endpoint");
    const defaultDeniedReservation = await noPolicy.db
      .prepare("SELECT reservation_id FROM cloud_inference_reservations WHERE tenant_id=?")
      .bind(TENANT_A)
      .first();
    assert.equal(defaultDeniedReservation, null, "pre-dispatch policy denial reserves no tokens");
    const denied = await lowBudget.runtime(fetcher).fetch(request(lowBudget.issued.token));
    assert.equal(denied.status, 429);
    assert.equal(calls, 1, "only exact-token preflight runs before budget reservation");
    const budgetDeniedReservation = await lowBudget.db
      .prepare("SELECT reservation_id FROM cloud_inference_reservations WHERE tenant_id=?")
      .bind(TENANT_A)
      .first();
    assert.equal(budgetDeniedReservation, null, "budget denial reserves no tokens");
  } finally {
    noPolicy.db.db.close();
    lowBudget.db.db.close();
  }
});

test("count timeout and ambiguous generation permanently prevent retries; reservations settle conservatively", async () => {
  const f = await fixture();
  try {
    let countCalls = 0;
    const countTimeout: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        countCalls += 1;
        (init as RequestInit).signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const timeoutApp = f.runtime(countTimeout, { cloudInferenceCountTimeoutMs: 1 });
    assert.equal(
      (await timeoutApp.fetch(request(f.issued.token, "idempotency-key-count-timeout"))).status,
      504
    );
    assert.equal(
      (await timeoutApp.fetch(request(f.issued.token, "idempotency-key-count-timeout"))).status,
      503
    );
    assert.equal(countCalls, 1);

    let generationCalls = 0;
    const generationTimeout: typeof fetch = async (input, init) => {
      if (String(input).endsWith("input_tokens"))
        return Response.json({ object: "response.input_tokens", input_tokens: 5 });
      generationCalls += 1;
      return new Promise((_resolve, reject) =>
        (init as RequestInit).signal?.addEventListener("abort", () => reject(new Error("aborted")))
      );
    };
    const genApp = f.runtime(generationTimeout, { cloudInferenceGenerationTimeoutMs: 1 });
    const key = "idempotency-key-generation-timeout";
    assert.equal((await genApp.fetch(request(f.issued.token, key))).status, 504);
    assert.equal((await genApp.fetch(request(f.issued.token, key))).status, 503);
    assert.equal(generationCalls, 1);
    const charged = await f.db
      .prepare<{ actual_input_tokens: number; actual_output_tokens: number; status: string }>(
        "SELECT actual_input_tokens,actual_output_tokens,status FROM cloud_inference_reservations WHERE tenant_id=? AND reservation_id IN (SELECT request_id FROM cloud_inference_idempotency WHERE state='outcome_unavailable')"
      )
      .bind(TENANT_A)
      .first();
    assert.equal(charged?.actual_input_tokens, 5);
    assert.equal(charged?.actual_output_tokens, 40);
    assert.equal(charged?.status, "settled");
  } finally {
    f.db.db.close();
  }
});

test("preflight response-body timeout and invalid provider usage are handled conservatively", async () => {
  const f = await fixture();
  try {
    const bodyStall: typeof fetch = async () =>
      new Response(new ReadableStream<Uint8Array>({ pull() {} }), { status: 200 });
    const timeoutResponse = await f
      .runtime(bodyStall, { cloudInferenceCountTimeoutMs: 1 })
      .fetch(request(f.issued.token, "idempotency-key-body-timeout"));
    assert.equal(timeoutResponse.status, 504);

    const invalidUsage: typeof fetch = async (input) => {
      if (String(input).endsWith("input_tokens"))
        return Response.json({ object: "response.input_tokens", input_tokens: 5 });
      return Response.json({
        id: "resp_invalid",
        model: "gpt-4o-mini-2024-07-18",
        status: "completed",
        created_at: 10,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "secret response" }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 41, total_tokens: 46 },
      });
    };
    const invalidResponse = await f
      .runtime(invalidUsage)
      .fetch(request(f.issued.token, "idempotency-key-invalid-usage"));
    assert.equal(invalidResponse.status, 502);
    assert.ok(!(await invalidResponse.text()).includes("secret response"));
    const settled = await f.db
      .prepare<{ actual_input_tokens: number; actual_output_tokens: number; status: string }>(
        "SELECT actual_input_tokens,actual_output_tokens,status FROM cloud_inference_reservations WHERE tenant_id=? AND reservation_id IN (SELECT request_id FROM cloud_inference_idempotency WHERE idempotency_key_hash != '') ORDER BY created_at DESC LIMIT 1"
      )
      .bind(TENANT_A)
      .first();
    assert.equal(settled?.status, "settled");
    assert.equal(settled?.actual_output_tokens, 40);
  } finally {
    f.db.db.close();
  }
});

test("usage or audit persistence failure returns unavailable and keeps idempotency closed", async () => {
  for (const table of ["cloud_usage_history", "cloud_compliance_audit"]) {
    const f = await fixture();
    try {
      let calls = 0;
      const app = f.runtime(async (...args) => {
        calls += 1;
        return upstream()(...args);
      });
      await f.db.exec(`DROP TABLE ${table}`);
      const key = `idempotency-key-${table.replaceAll("_", "-")}`;
      assert.equal((await app.fetch(request(f.issued.token, key))).status, 503);
      assert.equal((await app.fetch(request(f.issued.token, key))).status, 503);
      assert.equal(calls, 2, "retries never redispatch after persistence failure");
    } finally {
      f.db.db.close();
    }
  }
});
