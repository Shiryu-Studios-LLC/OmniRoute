export interface CloudOidcEgressBinding {
  fetch(request: Request): Promise<Response>;
}

export interface CloudOidcOutboundTransport {
  fetch(
    issuer: string,
    operation: "discovery" | "token" | "jwks",
    url: URL,
    init: RequestInit
  ): Promise<Response>;
}

const PROXY_URL = "http://omniroute-mcp-egress.internal:8080/v1/oidc/fetch";
const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 192 * 1024;
const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new TypeError("OIDC egress response exceeded its limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function safeUrl(issuer: string, url: URL): void {
  const issuerUrl = new URL(issuer);
  if (
    issuerUrl.protocol !== "https:" ||
    issuerUrl.port !== "" ||
    issuerUrl.username ||
    issuerUrl.password ||
    issuerUrl.search ||
    issuerUrl.hash ||
    url.protocol !== "https:" ||
    url.origin !== issuerUrl.origin ||
    url.port !== "" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%(?:2f|5c|2e)/i.test(url.pathname) ||
    url.pathname.includes("\\")
  ) {
    throw new TypeError("OIDC endpoint did not match the configured issuer origin");
  }
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/** Fixed private Service binding transport. It is inert unless both binding and secret exist. */
export function createCloudOidcEgressTransport(input: {
  binding?: CloudOidcEgressBinding;
  proxyToken?: string;
  timeoutMs?: number;
}): CloudOidcOutboundTransport | null {
  const { binding, proxyToken } = input;
  if (!binding || !proxyToken) return null;
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(proxyToken))
    throw new TypeError("OIDC proxy token is invalid");
  const timeoutMs = Math.max(100, Math.min(input.timeoutMs ?? 15_000, 30_000));
  return {
    async fetch(issuer, operation, url, init) {
      safeUrl(issuer, url);
      const expectedMethod = operation === "token" ? "POST" : "GET";
      if (init.method !== expectedMethod || init.redirect !== "manual") {
        throw new TypeError("OIDC egress method or redirect policy rejected");
      }
      const body = typeof init.body === "string" ? init.body : undefined;
      if ((operation === "token") !== (body !== undefined)) {
        throw new TypeError("OIDC egress body did not match operation");
      }
      const raw = JSON.stringify({
        issuer,
        operation,
        url: url.toString(),
        method: expectedMethod,
        ...(body === undefined ? {} : { body }),
      });
      if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
        throw new TypeError("OIDC egress request exceeded its limit");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const callerSignal = init.signal;
      const onAbort = () => controller.abort();
      if (callerSignal?.aborted) controller.abort();
      else callerSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = crypto.randomUUID();
        const signed = `${timestamp}\n${nonce}\n${raw}`;
        const signature = await hmac(proxyToken, signed);
        const proxyResponse = await binding.fetch(
          new Request(PROXY_URL, {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              "x-omniroute-timestamp": timestamp,
              "x-omniroute-nonce": nonce,
              "x-omniroute-signature": signature,
            },
            body: raw,
            signal: controller.signal,
          })
        );
        if (!proxyResponse.ok) throw new TypeError("OIDC egress proxy rejected the request");
        const envelope = JSON.parse(
          await readBounded(proxyResponse, MAX_PROXY_RESPONSE_BYTES)
        ) as unknown;
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
          throw new TypeError("OIDC egress proxy returned an invalid response");
        }
        const record = envelope as Record<string, unknown>;
        if (
          Object.keys(record).some((key) => !["status", "contentType", "body"].includes(key)) ||
          !Number.isInteger(record.status) ||
          (record.status as number) < 200 ||
          (record.status as number) > 599 ||
          typeof record.body !== "string" ||
          new TextEncoder().encode(record.body).byteLength > MAX_UPSTREAM_RESPONSE_BYTES ||
          (record.contentType !== null && typeof record.contentType !== "string")
        ) {
          throw new TypeError("OIDC egress proxy returned an invalid response");
        }
        return new Response(record.body, {
          status: record.status as number,
          headers:
            typeof record.contentType === "string"
              ? { "content-type": record.contentType }
              : undefined,
        });
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
