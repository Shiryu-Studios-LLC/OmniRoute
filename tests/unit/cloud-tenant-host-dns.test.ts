import assert from "node:assert/strict";
import test from "node:test";
import { resolveCustomerHostTxtWithCloudflare } from "../../src/cloud/tenantHostDns";

const RECORD_NAME = "_omniroute-challenge.example.com";
const TOKEN = "a".repeat(64);

function dnsResponse(payload: unknown, options: { status?: number; contentType?: string } = {}) {
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { Question: [{ name: `${RECORD_NAME}.`, type: 16 }], ...payload }
      : payload;
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "application/dns-json" },
  });
}

function answer(
  data: string,
  options: { name?: string; type?: number } = {}
): Record<string, unknown> {
  return {
    name: options.name ?? `${RECORD_NAME}.`,
    type: options.type ?? 16,
    data,
  };
}

test("Cloudflare TXT resolver uses its fixed DNS-over-HTTPS request policy", async () => {
  let requestUrl: URL | undefined;
  let requestInit: RequestInit | undefined;
  const values = await resolveCustomerHostTxtWithCloudflare(RECORD_NAME, (async (input, init) => {
    requestUrl = new URL(String(input));
    requestInit = init;
    return dnsResponse({ Status: 0, Answer: [answer(`"${TOKEN}"`)] });
  }) as typeof fetch);

  assert.deepEqual(values, [TOKEN]);
  assert.equal(requestUrl?.origin, "https://cloudflare-dns.com");
  assert.equal(requestUrl?.pathname, "/dns-query");
  assert.equal(requestUrl?.searchParams.get("name"), RECORD_NAME);
  assert.equal(requestUrl?.searchParams.get("type"), "TXT");
  assert.equal(requestInit?.method, "GET");
  assert.deepEqual(requestInit?.headers, { Accept: "application/dns-json" });
  assert.equal(requestInit?.redirect, "manual");
  assert.ok(requestInit?.signal instanceof AbortSignal);
});

test("resolver rejects names outside the challenge namespace without making a request", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return dnsResponse({ Status: 0, Answer: [] });
  }) as typeof fetch;

  for (const name of [
    "example.com",
    "_other-challenge.example.com",
    "_omniroute-challenge.bad host.example",
    `_omniroute-challenge.${"a".repeat(254)}`,
  ]) {
    assert.equal(await resolveCustomerHostTxtWithCloudflare(name, fetcher), null, name);
  }
  assert.equal(calls, 0);
});

test("resolver accepts only TXT answers for the exact challenge owner", async () => {
  const values = await resolveCustomerHostTxtWithCloudflare(RECORD_NAME, (async () =>
    dnsResponse({
      Status: 0,
      Answer: [
        answer(`"${"b".repeat(64)}"`, { name: `${RECORD_NAME}.attacker.example.` }),
        answer(`"${"c".repeat(64)}"`, { type: 5 }),
        answer(`"${TOKEN}"`, { name: `${RECORD_NAME}.` }),
        answer(`"${TOKEN.toUpperCase()}"`, { name: `${RECORD_NAME.toUpperCase()}.` }),
      ],
    })) as typeof fetch);

  assert.deepEqual(values, [TOKEN]);
});

test("resolver joins adjacent hexadecimal TXT character strings", async () => {
  const values = await resolveCustomerHostTxtWithCloudflare(RECORD_NAME, (async () =>
    dnsResponse({
      Status: 0,
      Answer: [answer(`"${TOKEN.slice(0, 31)}" "${TOKEN.slice(31)}"`)],
    })) as typeof fetch);

  assert.deepEqual(values, [TOKEN]);
});

test("resolver ignores invalid hexadecimal TXT encodings", async () => {
  const invalidData = [
    TOKEN,
    `"${"A".repeat(64)}"`,
    `"${"g".repeat(64)}"`,
    `"${"a".repeat(63)}"`,
    `"${TOKEN.slice(0, 32)}"; "${TOKEN.slice(32)}"`,
    `"${TOKEN.slice(0, 31)}" "${TOKEN.slice(31, 62)}" "zz"`,
  ];
  const values = await resolveCustomerHostTxtWithCloudflare(RECORD_NAME, (async () =>
    dnsResponse({ Status: 0, Answer: invalidData.map((data) => answer(data)) })) as typeof fetch);

  assert.deepEqual(values, []);
});

test("resolver rejects HTTP errors, wrong content types, and malformed DNS JSON", async () => {
  const responses = [
    new Response("upstream error", { status: 503, headers: { "content-type": "text/plain" } }),
    dnsResponse({ Status: 0, Answer: [answer(`"${TOKEN}"`)] }, { contentType: "application/json" }),
    new Response("{not json", {
      headers: { "content-type": "application/dns-json" },
    }),
    dnsResponse({ Status: 2, Answer: [answer(`"${TOKEN}"`)] }),
    dnsResponse({
      Status: 0,
      Question: [{ name: "_other-challenge.example.com.", type: 16 }],
      Answer: [answer(`"${TOKEN}"`)],
    }),
    dnsResponse({ Status: 0, Answer: "not-an-array" }),
    dnsResponse({ Status: 0, Answer: Array.from({ length: 65 }, () => answer(`"${TOKEN}"`)) }),
    new Response(null, { headers: { "content-type": "application/dns-json" } }),
  ];

  for (const response of responses) {
    assert.equal(
      await resolveCustomerHostTxtWithCloudflare(
        RECORD_NAME,
        (async () => response) as typeof fetch
      ),
      null
    );
  }
});

test("resolver reports an authoritative NXDOMAIN as a missing TXT value", async () => {
  const values = await resolveCustomerHostTxtWithCloudflare(RECORD_NAME, (async () =>
    dnsResponse({ Status: 3, Answer: [] })) as typeof fetch);

  assert.deepEqual(values, []);
});

test("resolver bounds oversized DNS responses and cancels their stream", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(8 * 1024 + 1)));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "application/dns-json" } }
  );

  assert.equal(
    await resolveCustomerHostTxtWithCloudflare(RECORD_NAME, (async () => response) as typeof fetch),
    null
  );
  assert.equal(cancelled, true);
});

test("resolver aborts a stalled DNS-over-HTTPS request at its timeout", async () => {
  let signal: AbortSignal | undefined;
  const result = await resolveCustomerHostTxtWithCloudflare(RECORD_NAME, ((_, init) => {
    signal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof fetch);

  assert.equal(result, null);
  assert.equal(signal?.aborted, true);
});
