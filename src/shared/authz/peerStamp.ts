import { classifyHostLocality } from "./peerLocality";

/**
 * Compare equal-length token strings without exiting early on a byte mismatch.
 * This deliberately uses Web-compatible TextEncoder and no Node crypto APIs so
 * the trusted peer-stamp policy can be shared by Node and Worker runtimes.
 */
function tokensMatch(provided: string, expected: string | undefined): boolean {
  if (!expected || provided.length !== expected.length) return false;

  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  if (providedBytes.length !== expectedBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < providedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

/**
 * Resolve the real peer IP from the trusted `<token>|<ip>` stamp that the
 * custom Node server writes into PEER_IP_HEADER. Untrusted or incomplete
 * stamps fail closed to null.
 */
export function resolveStampedPeer(
  headerValue: string | null,
  token: string | undefined
): string | null {
  if (!headerValue || !token) return null;
  const separator = headerValue.indexOf("|");
  if (separator <= 0) return null;

  const provided = headerValue.slice(0, separator);
  const ip = headerValue.slice(separator + 1);
  if (!ip || !tokensMatch(provided, token)) return null;
  return ip;
}

/**
 * Resolve the trusted `<token>|1` reverse-proxy marker. Missing, forged, or
 * malformed values default to false, which does not create a locality bypass.
 */
export function resolveStampedViaProxy(
  headerValue: string | null,
  token: string | undefined
): boolean {
  if (!headerValue || !token) return false;
  const separator = headerValue.indexOf("|");
  if (separator <= 0) return false;

  const provided = headerValue.slice(0, separator);
  const payload = headerValue.slice(separator + 1);
  return payload === "1" && tokensMatch(provided, token);
}

/**
 * Resolve the trusted peer locality used by the LOCAL_ONLY route guard.
 * Unknown or invalid stamps classify as remote. A verified proxy hop makes a
 * loopback/private socket remote because it does not identify the end-user.
 */
export function classifyStampedPeerLocality(
  peerHeader: string | null,
  viaProxyHeader: string | null,
  token: string | undefined
): "loopback" | "lan" | "remote" {
  const ip = resolveStampedPeer(peerHeader, token);
  const viaProxy = resolveStampedViaProxy(viaProxyHeader, token);
  const locality = classifyHostLocality(ip);
  if (viaProxy && locality !== "remote") return "remote";
  return locality;
}
