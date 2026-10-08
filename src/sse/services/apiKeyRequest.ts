import { extractGoogApiKeyHeader } from "./googApiKeyAuth.ts";
import { readHeaderValue, type AuthRequestHeaders } from "./headerReader.ts";

type AuthRequestLike = {
  headers?: AuthRequestHeaders | null;
  url?: string | null;
};

function readNonEmptyUrlToken(request: AuthRequestLike): string | null {
  if (typeof request?.url !== "string" || request.url.trim().length === 0) return null;

  try {
    const url = new URL(request.url, "http://localhost");
    const segments = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments[0] === "vscode" && segments[1]) {
      const decodedSegment = decodeURIComponent(segments[1]).trim();
      if (decodedSegment.length > 0) return decodedSegment;
    }

    if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "vscode") {
      if (segments[3] && segments[3] !== "raw" && segments[3] !== "combos") {
        const decodedSegment = decodeURIComponent(segments[3]).trim();
        if (decodedSegment.length > 0) return decodedSegment;
      }

      if ((segments[3] === "raw" || segments[3] === "combos") && segments[4]) {
        const decodedSegment = decodeURIComponent(segments[4]).trim();
        if (decodedSegment.length > 0) return decodedSegment;
      }
    }

    // Query-string tokens are intentionally unsupported: credentials in URLs leak
    // into access logs, Referer headers, and proxy logs.
  } catch {
    return null;
  }

  return null;
}

/** Extract a client API key without loading provider/account authentication code. */
export function extractApiKey(
  request: AuthRequestLike,
  opts?: { allowUrl?: boolean }
): string | null {
  const authHeader =
    readHeaderValue(request?.headers, "Authorization") ||
    readHeaderValue(request?.headers, "authorization");
  if (typeof authHeader === "string") {
    const trimmedHeader = authHeader.trim();
    if (trimmedHeader.toLowerCase().startsWith("bearer ")) {
      return trimmedHeader.slice(7).trim() || null;
    }
  }

  const anthropicVersion =
    readHeaderValue(request?.headers, "anthropic-version") ||
    readHeaderValue(request?.headers, "Anthropic-Version");
  const userAgent =
    readHeaderValue(request?.headers, "user-agent") ||
    readHeaderValue(request?.headers, "User-Agent");
  if (anthropicVersion || (userAgent && /claude-code|claude-cli|anthropic/i.test(userAgent))) {
    const xApiKey =
      readHeaderValue(request?.headers, "x-api-key") ||
      readHeaderValue(request?.headers, "X-Api-Key");
    if (typeof xApiKey === "string") {
      const trimmed = xApiKey.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }

  const xGoogApiKey = extractGoogApiKeyHeader(request?.headers);
  if (xGoogApiKey) return xGoogApiKey;
  if (opts?.allowUrl === false) return null;
  return readNonEmptyUrlToken(request);
}
