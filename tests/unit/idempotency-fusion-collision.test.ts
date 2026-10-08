/**
 * Regression: fusion judge must not replay a panel member's cached response.
 *
 * The idempotency layer keys on the client's `Idempotency-Key` / `x-request-id`
 * header with a 5s replay window. Fusion's internal panel + judge sub-requests
 * re-enter chatCore SHARING the client's headers, so they all derived the SAME
 * key: a panel answer saved under the key, and ~1ms later the judge's check hit
 * it — the client received a panel member's answer (labeled with the judge's
 * meta headers) instead of the judge synthesis. Observed live on
 * "nexa/conversation-fusion" (body = Gemini panel answer verbatim,
 * X-OmniRoute-Idempotent: true, judge "latency" ~0ms).
 *
 * Fix: namespace the composed key by target provider/model AND a digest of the
 * request messages. Panel members differ by model; the judge differs by model
 * AND by messages (it appends the judge directive turn), so sub-requests can
 * never collide — while a genuine client retry (same key, same model, same
 * body) still replays.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkIdempotencyCache,
  composeIdempotencyKey,
} from "../../open-sse/handlers/chatCore/idempotency.ts";
import { clearIdempotency, saveIdempotency } from "../../src/lib/idempotencyLayer.ts";
import { runWithTenantContext } from "../../src/lib/tenantContext.ts";

const MSGS = [{ role: "user", content: "Client asks about our PST coverage" }];
const JUDGE_MSGS = [...MSGS, { role: "user", content: "You are the judge. Synthesize: ..." }];

test("no raw header -> null (idempotency disabled for the request)", () => {
  assert.equal(
    composeIdempotencyKey({
      rawKey: null,
      tenantId: "tenant-test",
      principalId: "key-test",
      provider: "cc",
      model: "claude-opus-4-8",
      messages: MSGS,
    }),
    null
  );
});

test("panel members (same raw key, same body, different models) get DIFFERENT keys", () => {
  const base = {
    rawKey: "req-1",
    tenantId: "tenant-test",
    principalId: "key-test",
    messages: MSGS,
  };
  const opus = composeIdempotencyKey({ ...base, provider: "cc", model: "claude-opus-4-6" });
  const gemini = composeIdempotencyKey({
    ...base,
    provider: "antigravity",
    model: "gemini-3.1-pro-high",
  });
  const gpt = composeIdempotencyKey({ ...base, provider: "cx", model: "gpt-5.5-high" });
  assert.ok(opus && gemini && gpt);
  assert.notEqual(opus, gemini);
  assert.notEqual(gemini, gpt);
  assert.notEqual(opus, gpt);
});

test("judge (same raw key, different model AND extra judge turn) never collides with a panel member", () => {
  const panel = composeIdempotencyKey({
    rawKey: "req-1",
    tenantId: "tenant-test",
    principalId: "key-test",
    provider: "antigravity",
    model: "gemini-3.1-pro-high",
    messages: MSGS,
  });
  const judge = composeIdempotencyKey({
    rawKey: "req-1",
    tenantId: "tenant-test",
    principalId: "key-test",
    provider: "cc",
    model: "claude-opus-4-8",
    messages: JUDGE_MSGS,
  });
  assert.notEqual(judge, panel);
});

test("judge that reuses a panel member's model still differs (messages digest separates them)", () => {
  const panel = composeIdempotencyKey({
    rawKey: "req-1",
    tenantId: "tenant-test",
    principalId: "key-test",
    provider: "cc",
    model: "claude-opus-4-8",
    messages: MSGS,
  });
  const judge = composeIdempotencyKey({
    rawKey: "req-1",
    tenantId: "tenant-test",
    principalId: "key-test",
    provider: "cc",
    model: "claude-opus-4-8",
    messages: JUDGE_MSGS,
  });
  assert.notEqual(judge, panel);
});

test("genuine client retry (same key + model + body) -> SAME key (replay semantics preserved)", () => {
  const a = composeIdempotencyKey({
    rawKey: "retry-9",
    tenantId: "tenant-test",
    principalId: "key-test",
    provider: "cc",
    model: "claude-opus-4-8",
    messages: MSGS,
  });
  const b = composeIdempotencyKey({
    rawKey: "retry-9",
    tenantId: "tenant-test",
    principalId: "key-test",
    provider: "cc",
    model: "claude-opus-4-8",
    messages: MSGS,
  });
  assert.equal(a, b);
});

test("same client key cannot replay responses across tenants or API keys", () => {
  const base = {
    rawKey: "shared-client-key",
    provider: "cc",
    model: "claude-opus-4-8",
    messages: MSGS,
  };
  const tenantA = composeIdempotencyKey({
    ...base,
    tenantId: "tenant-a",
    principalId: "api-key-a",
  });
  const tenantB = composeIdempotencyKey({
    ...base,
    tenantId: "tenant-b",
    principalId: "api-key-b",
  });
  const sameTenantDifferentKey = composeIdempotencyKey({
    ...base,
    tenantId: "tenant-a",
    principalId: "api-key-c",
  });

  assert.notEqual(tenantA, tenantB);
  assert.notEqual(tenantA, sameTenantDifferentKey);
});

test("chat idempotency cache replay stays within the authenticated tenant and API key", async () => {
  clearIdempotency();
  const body = { messages: MSGS };
  const clientRawRequest = {
    headers: new Headers({ "Idempotency-Key": "shared-request-key" }),
  };
  const check = () =>
    checkIdempotencyCache({
      clientRawRequest,
      provider: "cc",
      model: "claude-opus-4-8",
      body,
      effectiveServiceTier: null,
      startTime: Date.now(),
      log: null,
    });

  const tenantA = await runWithTenantContext(
    { tenantId: "tenant-a", principalId: "api-key-a" },
    async () => {
      const initial = await check();
      assert.equal(initial.hit, null);
      saveIdempotency(
        initial.idempotencyKey,
        { choices: [{ message: { content: "private" } }] },
        200
      );
      return check();
    }
  );
  assert.equal(tenantA.hit?.success, true);

  const tenantB = await runWithTenantContext(
    { tenantId: "tenant-b", principalId: "api-key-b" },
    check
  );
  assert.equal(tenantB.hit, null);
  assert.notEqual(tenantA.idempotencyKey, tenantB.idempotencyKey);

  const sameTenantOtherKey = await runWithTenantContext(
    { tenantId: "tenant-a", principalId: "api-key-c" },
    check
  );
  assert.equal(sameTenantOtherKey.hit, null);
});
