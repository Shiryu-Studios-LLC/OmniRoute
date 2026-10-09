import { normalizeCustomerHostname } from "./tenantHosts";

const DNS_OVER_HTTPS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_DOH_RESPONSE_BYTES = 8 * 1024;

export type CustomerHostTxtResolver = (recordName: string) => Promise<string[] | null>;

function isChallengeRecordName(value: string): boolean {
  const prefix = "_omniroute-challenge.";
  if (!value.toLowerCase().startsWith(prefix)) return false;
  return normalizeCustomerHostname(value.slice(prefix.length)) !== null;
}

function decodeHexTxtRecord(data: string): string | null {
  // Challenge tokens are lowercase hexadecimal. Cloudflare's JSON resolver
  // returns TXT character-strings with presentation quotes; DNS may split a
  // long TXT value into adjacent quoted character-strings, which are joined.
  if (!/^(?:\s*"[a-f0-9]+"\s*)+$/.test(data)) return null;
  const value = data.replace(/["\s]/g, "");
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be cancelled after an oversized response.
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function resolveCustomerHostTxtWithCloudflare(
  recordName: string,
  fetcher: typeof fetch = fetch
): Promise<string[] | null> {
  if (!isChallengeRecordName(recordName)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const url = new URL(DNS_OVER_HTTPS_ENDPOINT);
    url.searchParams.set("name", recordName);
    url.searchParams.set("type", "TXT");
    const response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/dns-json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (
      response.status !== 200 ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/dns-json")
    ) {
      return null;
    }
    const text = await readBoundedText(response, MAX_DOH_RESPONSE_BYTES);
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result = parsed as Record<string, unknown>;
    if (
      (result.Status !== 0 && result.Status !== 3) ||
      !Array.isArray(result.Question) ||
      result.Question.length !== 1 ||
      !Array.isArray(result.Answer) ||
      result.Answer.length > 64
    ) {
      return null;
    }
    if (result.Status === 3) return [];
    const expectedName = `${recordName.replace(/\.$/, "").toLowerCase()}.`;
    const question = result.Question[0];
    if (!question || typeof question !== "object" || Array.isArray(question)) return null;
    const questionRecord = question as Record<string, unknown>;
    if (
      questionRecord.type !== 16 ||
      typeof questionRecord.name !== "string" ||
      questionRecord.name.toLowerCase() !== expectedName
    ) {
      return null;
    }
    const values: string[] = [];
    for (const answer of result.Answer) {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) continue;
      const record = answer as Record<string, unknown>;
      if (
        record.type !== 16 ||
        typeof record.name !== "string" ||
        typeof record.data !== "string"
      ) {
        continue;
      }
      if (record.name.toLowerCase() !== expectedName) continue;
      const value = decodeHexTxtRecord(record.data);
      if (value) values.push(value);
    }
    return values;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
