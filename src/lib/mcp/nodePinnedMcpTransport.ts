import { lookup as systemLookup } from "node:dns";
import { isIP, type TcpNetConnectOpts } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { McpOutboundEgressError, type McpOutboundTransport } from "./mcpOutboundTransport.ts";

export type McpPinnedAddress = { address: string; family: number };
type LookupRecord = McpPinnedAddress;
type LookupAll = (hostname: string) => Promise<LookupRecord[]>;

const IPV4_DENY_RANGES: Array<[number, number]> = [
  [0x00000000, 8], // this network
  [0x0a000000, 8], // private
  [0x64400000, 10], // shared address space
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link local
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0586300, 24], // 6to4 relay anycast
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved / broadcast
];

function ipv4Number(address: string): number {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv4InRange(address: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const numeric = ipv4Number(address);
    return (
      numeric >= 0 &&
      !IPV4_DENY_RANGES.some(([network, prefix]) => ipv4InRange(numeric, network, prefix))
    );
  }
  if (family === 6) {
    const value = address.toLowerCase().replace(/^\[|\]$/g, "");
    // Conservative global-unicast only. Reject transition, mapped, local,
    // multicast, documentation, and special-purpose ranges.
    if (!/^2[0-9a-f]{3}:/.test(value)) return false;
    if (/^(2001:(?:0{0,3}[0-9a-f]{1,3}|0:|db8:)|2002:|3fff:)/.test(value)) return false;
    return true;
  }
  return false;
}

function normalizeEndpoint(input: string, allowLoopback = false): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new McpOutboundEgressError("MCP_OUTBOUND_DNS_REJECTED", "MCP endpoint URL was rejected");
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const localLiteral = host === "127.0.0.1" || host === "::1";
  const localHost = localLiteral || host === "localhost";
  if (
    allowLoopback &&
    localHost &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !url.search
  ) {
    return url;
  }
  if (
    url.protocol !== "https:" ||
    !host ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash ||
    (isIP(host) !== 0 && !isPublicAddress(host))
  ) {
    throw new McpOutboundEgressError("MCP_OUTBOUND_DNS_REJECTED", "MCP endpoint URL was rejected");
  }
  return url;
}

async function lookupAllPublic(hostname: string, lookupAll: LookupAll): Promise<LookupRecord[]> {
  let records: LookupRecord[];
  try {
    records = await lookupAll(hostname);
  } catch {
    throw new McpOutboundEgressError("MCP_OUTBOUND_DNS_REJECTED");
  }
  if (
    records.length === 0 ||
    records.some(
      (record) => !isPublicAddress(record.address) || record.family !== isIP(record.address)
    )
  ) {
    throw new McpOutboundEgressError("MCP_OUTBOUND_DNS_REJECTED");
  }
  return records;
}

function systemLookupAll(hostname: string): Promise<LookupRecord[]> {
  return new Promise((resolve, reject) => {
    systemLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

export function createPinnedMcpLookup(
  records: readonly McpPinnedAddress[],
  allowLoopback = false
): NonNullable<TcpNetConnectOpts["lookup"]> {
  if (
    records.length === 0 ||
    records.some(
      (record) =>
        record.family !== isIP(record.address) ||
        !(allowLoopback
          ? (record.family === 4 && record.address === "127.0.0.1") ||
            (record.family === 6 && record.address === "::1")
          : isPublicAddress(record.address))
    )
  ) {
    throw new McpOutboundEgressError("MCP_OUTBOUND_DNS_REJECTED");
  }
  let cursor = 0;
  return ((hostname, options, callback) => {
    // The Agent only connects to this request's resolved address set. A DNS
    // change after this point cannot redirect the socket to a private target.
    if (!hostname) {
      callback(Object.assign(new Error("Missing hostname"), { code: "EINVAL" }), "", 0);
      return;
    }
    const familyConstraint =
      typeof options === "number"
        ? options
        : typeof options === "object" && "family" in options
          ? options.family
          : 0;
    const candidates = familyConstraint
      ? records.filter((record) => record.family === familyConstraint)
      : records;
    if (candidates.length === 0) {
      callback(
        Object.assign(new Error("No validated address for requested family"), {
          code: "ENOTFOUND",
        }),
        "",
        0
      );
      return;
    }
    const wantsAll = typeof options === "object" && "all" in options && Boolean(options.all);
    if (wantsAll) {
      callback(null, [...candidates]);
      return;
    }
    const record = candidates[cursor++ % candidates.length];
    callback(null, record.address, record.family);
  }) as NonNullable<TcpNetConnectOpts["lookup"]>;
}

function closeAgent(agent: Agent): void {
  void agent.close().catch(() => undefined);
}

function copyHeaders(headers: {
  forEach(callback: (value: string, name: string) => void): void;
}): globalThis.Headers {
  const copied = new globalThis.Headers();
  headers.forEach((value, name) => copied.append(name, value));
  return copied;
}

/**
 * Node.js implementation of controlled MCP egress. It resolves all A/AAAA
 * answers, rejects mixed/private answer sets, then uses an isolated undici
 * Agent whose lookup callback can only return those validated addresses. TLS
 * still uses the URL hostname for SNI and certificate validation.
 *
 * Do not use this in Cloudflare Workers: Workers fetch does not expose a socket
 * lookup hook. Worker deployments must use an equivalent controlled egress
 * proxy or leave outbound MCP discovery disabled.
 */
export function createNodePinnedMcpTransport(
  options: { lookupAll?: LookupAll; allowLoopback?: boolean } = {}
): McpOutboundTransport {
  const lookupAll = options.lookupAll ?? systemLookupAll;
  return {
    async fetch(input, init) {
      const url = normalizeEndpoint(input, options.allowLoopback === true);
      const literal = isIP(url.hostname.replace(/^\[|\]$/g, ""));
      const loopbackMode =
        options.allowLoopback === true &&
        (url.hostname.toLowerCase() === "localhost" ||
          url.hostname === "127.0.0.1" ||
          url.hostname === "[::1]");
      let records = literal
        ? [{ address: url.hostname.replace(/^\[|\]$/g, ""), family: literal }]
        : loopbackMode
          ? []
          : await lookupAllPublic(url.hostname.replace(/\.$/, ""), lookupAll);
      if (loopbackMode && url.hostname.toLowerCase() === "localhost") {
        records = await lookupAll(url.hostname);
        if (
          records.length === 0 ||
          records.some(
            (record) =>
              !(
                (record.family === 4 && record.address === "127.0.0.1") ||
                (record.family === 6 && record.address === "::1")
              )
          )
        ) {
          throw new McpOutboundEgressError("MCP_OUTBOUND_DNS_REJECTED");
        }
      }
      if (
        records.some((record) =>
          loopbackMode
            ? !(
                (record.family === 4 && record.address === "127.0.0.1") ||
                (record.family === 6 && record.address === "::1")
              )
            : !isPublicAddress(record.address)
        )
      ) {
        throw new McpOutboundEgressError("MCP_OUTBOUND_DNS_REJECTED");
      }

      const agent = new Agent({
        connect: {
          lookup: createPinnedMcpLookup(records, loopbackMode),
        },
        connections: 1,
        pipelining: 0,
      });
      try {
        const upstream = await undiciFetch(url, {
          ...init,
          dispatcher: agent,
          redirect: "manual",
        } as Parameters<typeof undiciFetch>[1]);
        if (!upstream.body) {
          closeAgent(agent);
          return new Response(null, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: copyHeaders(upstream.headers),
          });
        }
        const reader = upstream.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                closeAgent(agent);
              } else controller.enqueue(chunk.value);
            } catch (error) {
              controller.error(error);
              closeAgent(agent);
            }
          },
          async cancel(reason) {
            await reader.cancel(reason);
            closeAgent(agent);
          },
        });
        return new Response(body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: copyHeaders(upstream.headers),
        });
      } catch (error) {
        closeAgent(agent);
        throw error;
      }
    },
  };
}
