import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import type { CloudDb } from "./db";
import { cloudflareClientIpBucket, consumeCloudRateLimit } from "./rateLimit";
import {
  getCloudCustomerBusinessProfile,
  updateCloudCustomerBusinessProfile,
} from "./customerBusinessProfile";

export const CLOUD_CUSTOMER_BUSINESS_PROFILE_PATH = "/__cloud/v1/customer/business-profile";
const MAX_BODY_BYTES = 24 * 1024;
const AUTH_LIMIT = { limit: 600, windowMs: 60_000 };
const AUTH_FALLBACK_LIMIT = { limit: 100, windowMs: 60_000 };
const TENANT_LIMIT = { limit: 60, windowMs: 60_000 };

export interface CloudCustomerBusinessProfileApiOptions {
  db?: CloudDb;
  now?: () => Date;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function validText(value: unknown, max: number, required = false): value is string {
  return typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
}

export function validateCloudCustomerBusinessProfile(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "assistant,description,hours,name,services")
    return null;
  if (
    !validText(body.name, 120, true) ||
    !validText(body.description, 1000) ||
    !validText(body.hours, 250)
  )
    return null;
  if (!Array.isArray(body.services) || body.services.length > 30) return null;
  const services: Array<{ name: string; price: string }> = [];
  for (const entry of body.services) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const service = entry as Record<string, unknown>;
    if (
      Object.keys(service).sort().join(",") !== "name,price" ||
      !validText(service.name, 100, true) ||
      !validText(service.price, 60)
    )
      return null;
    services.push({ name: service.name.trim(), price: service.price.trim() });
  }
  if (!body.assistant || typeof body.assistant !== "object" || Array.isArray(body.assistant))
    return null;
  const assistant = body.assistant as Record<string, unknown>;
  if (
    Object.keys(assistant).sort().join(",") !== "handoff,name,tone" ||
    !validText(assistant.name, 100, true) ||
    !validText(assistant.tone, 250, true) ||
    !validText(assistant.handoff, 1000, true)
  )
    return null;
  const profile = {
    name: body.name.trim(),
    description: body.description.trim(),
    hours: body.hours.trim(),
    services,
    assistant: {
      name: assistant.name.trim(),
      tone: assistant.tone.trim(),
      handoff: assistant.handoff.trim(),
    },
  };
  return new TextEncoder().encode(JSON.stringify(profile)).byteLength <= MAX_BODY_BYTES
    ? profile
    : null;
}

async function readProfile(request: Request): Promise<unknown | Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase().split(";", 1)[0].trim();
  if (contentType !== "application/json") return json({ error: "Expected application/json" }, 415);
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
    return json({ error: "Request body is too large" }, 413);
  }
  if (!request.body) return json({ error: "Invalid JSON body" }, 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Request body timed out")), 5_000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        cancel();
        return json({ error: "Request body is too large" }, 413);
      }
      chunks.push(value);
    }
  } catch {
    cancel();
    return json({ error: "Request body could not be read" }, 408);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!cancelled) reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
}

export async function handleCloudCustomerBusinessProfileRequest(
  request: Request,
  options: CloudCustomerBusinessProfileApiOptions
): Promise<Response | null> {
  if (new URL(request.url).pathname !== CLOUD_CUSTOMER_BUSINESS_PROFILE_PATH) return null;
  if (request.method !== "GET" && request.method !== "PUT")
    return json({ error: "Method not allowed" }, 405);
  if (!options.db) return json({ error: "Cloud database is not configured" }, 503);
  const now = options.now ?? (() => new Date());
  const ip = cloudflareClientIpBucket(request);
  try {
    const limit = await consumeCloudRateLimit(options.db, {
      tenantId: "tenant_shiryu_admin",
      bucketKey: `customer-business-profile-auth:${ip ?? "fallback"}`,
      ...(ip ? AUTH_LIMIT : AUTH_FALLBACK_LIMIT),
      nowMs: now().getTime(),
    });
    if (!limit.allowed) return json({ error: "Authentication rate limit exceeded" }, 429);
  } catch {
    return json({ error: "Authentication rate limit is unavailable" }, 503);
  }
  const match = /^Bearer (orc_live_[A-Za-z0-9_-]{1,96})$/.exec(
    request.headers.get("Authorization") ?? ""
  );
  if (!match) return json({ error: "Unauthorized" }, 401);
  const timestamp = now().toISOString();
  let identity;
  try {
    identity = await authenticateCloudCustomerApiKey(options.db, match[1], timestamp);
  } catch {
    return json({ error: "Customer authentication is unavailable" }, 503);
  }
  if (!identity) return json({ error: "Unauthorized" }, 401);
  if (identity.role !== "owner" && identity.role !== "admin")
    return json({ error: "Owner or admin membership is required" }, 403);
  try {
    const limit = await consumeCloudRateLimit(options.db, {
      tenantId: identity.tenantId,
      bucketKey: "customer-business-profile",
      ...TENANT_LIMIT,
      nowMs: now().getTime(),
    });
    if (!limit.allowed)
      return json({ error: "Customer business profile rate limit exceeded" }, 429);
    if (request.method === "GET") {
      const profile = await getCloudCustomerBusinessProfile(options.db, identity.tenantId);
      return profile
        ? json(profile)
        : json({ error: "Customer business profile is unavailable" }, 503);
    }
    const body = await readProfile(request);
    if (body instanceof Response) return body;
    const profile = validateCloudCustomerBusinessProfile(body);
    if (!profile) return json({ error: "Invalid business profile" }, 400);
    const updatedAt = now().toISOString();
    const result = await updateCloudCustomerBusinessProfile(options.db, {
      tenantId: identity.tenantId,
      membershipId: identity.membershipId,
      authorization: { type: "api_key", apiKeyId: identity.apiKeyId },
      profile,
      updatedAt,
      audit: {
        id: crypto.randomUUID(),
        tenantId: identity.tenantId,
        timestamp: updatedAt,
        action: "customer.business_profile.update",
        actor: `api-key:${identity.apiKeyId}`,
        target: "tenant-business-profile",
        resourceType: "customer-business-profile",
        status: "success",
        requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
        metadata: { serviceCount: profile.services.length },
      },
    });
    return result ? json(result) : json({ error: "Owner or admin membership is required" }, 403);
  } catch {
    return json({ error: "Customer business profile could not be updated" }, 503);
  }
}
