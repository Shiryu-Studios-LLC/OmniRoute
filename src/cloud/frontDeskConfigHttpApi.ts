import { authenticateCloudCustomerApiKey } from "./customerIdentity";
import { prepareCloudComplianceAuditInsert, appendCloudComplianceAudit } from "./complianceAudit";
import type { CloudDb } from "./db";
import {
  decryptCloudCredential,
  encryptCloudCredential,
  isCloudCredentialEnvelope,
  isCloudCredentialEncryptionKey,
} from "./credentialEncryption";
import { getCloudGatewayDevice, listCloudGatewayDevices } from "./gatewayDevices";
import { consumeCloudRateLimit } from "./rateLimit";
import {
  getCloudFrontDeskConfig,
  listCloudFrontDeskConfigs,
  prepareDeleteCloudFrontDeskConfig,
  prepareUpsertCloudFrontDeskConfig,
  type CloudFrontDeskPortalAuthorization,
  type CloudFrontDeskConfig,
} from "./frontDeskConfigs";
import {
  getAdminVerifiedCustomerHost,
  listAdminVerifiedCustomerHosts,
  normalizeCustomerHostname,
} from "./tenantHosts";
import { getCloudTenantById, CLOUD_PLATFORM_TENANT_ID } from "./tenants";

export const CLOUD_FRONT_DESK_CONFIG_PATH = "/__cloud/v1/front-desk/config";
export const CLOUD_FRONT_DESK_CONFIGS_PATH = "/__cloud/v1/front-desk/configs";

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const CHECKPOINT = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/;
const DASHBOARD_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

export interface CloudFrontDeskConfigApiOptions {
  db?: CloudDb;
  adminToken?: string;
  serviceToken?: string;
  credentialEncryptionKey?: string;
  now?: () => Date;
  bodyReadTimeoutMs?: number;
}

export interface CloudFrontDeskConfigPortalIdentity {
  tenantId: string;
  principalId: string;
  membershipId: string;
  role: "owner" | "admin" | "member" | "viewer";
  sessionTokenHash: string;
}

interface GatewayConfigInput {
  baseUrl: string;
  deviceId: string;
  ollamaModel: string;
  imageGeneration: {
    checkpoint: string | null;
    width: number;
    height: number;
    steps: number;
    cfg: number;
  } | null;
}

interface ConfigInput {
  hostname: string;
  customerApiKey: string;
  dashboardToken: string;
  gateway: GatewayConfigInput;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function constantTimeBearerMatches(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const supplied = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${token}`;
  let difference = supplied.length ^ expected.length;
  for (let index = 0; index < Math.max(supplied.length, expected.length); index += 1) {
    difference |= (supplied.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function readJsonBody(
  request: Request,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  if (
    request.headers.get("content-type")?.toLowerCase().split(";", 1)[0].trim() !==
    "application/json"
  ) {
    return null;
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Request body timed out")), timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    cancel();
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!cancelled) reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" || localHost)
    );
  } catch {
    return false;
  }
}

function normalizeImageGeneration(
  value: unknown
): GatewayConfigInput["imageGeneration"] | null | false {
  if (value === null) return null;
  const image = object(value);
  if (
    !image ||
    Object.keys(image).some(
      (key) => !["checkpoint", "width", "height", "steps", "cfg"].includes(key)
    )
  ) {
    return false;
  }
  const checkpoint = image.checkpoint ?? null;
  const width = image.width ?? 1024;
  const height = image.height ?? 1024;
  const steps = image.steps ?? 25;
  const cfg = image.cfg ?? 7;
  if (
    (checkpoint !== null && (typeof checkpoint !== "string" || !CHECKPOINT.test(checkpoint))) ||
    !Number.isInteger(width) ||
    (width as number) < 256 ||
    (width as number) > 1024 ||
    (width as number) % 64 !== 0 ||
    !Number.isInteger(height) ||
    (height as number) < 256 ||
    (height as number) > 1024 ||
    (height as number) % 64 !== 0 ||
    !Number.isInteger(steps) ||
    (steps as number) < 1 ||
    (steps as number) > 30 ||
    typeof cfg !== "number" ||
    !Number.isFinite(cfg) ||
    cfg < 0 ||
    cfg > 20
  ) {
    return false;
  }
  return {
    checkpoint,
    width: width as number,
    height: height as number,
    steps: steps as number,
    cfg,
  };
}

function parseConfigInput(value: Record<string, unknown>): ConfigInput | null {
  if (
    Object.keys(value).sort().join(",") !== "customerApiKey,dashboardToken,gateway,hostname" ||
    typeof value.hostname !== "string" ||
    normalizeCustomerHostname(value.hostname) !== value.hostname ||
    typeof value.customerApiKey !== "string" ||
    value.customerApiKey.length < 40 ||
    value.customerApiKey.length > 128 ||
    typeof value.dashboardToken !== "string" ||
    !DASHBOARD_TOKEN.test(value.dashboardToken)
  ) {
    return null;
  }
  const gateway = object(value.gateway);
  if (
    !gateway ||
    Object.keys(gateway).some(
      (key) => !["baseUrl", "deviceId", "ollamaModel", "imageGeneration"].includes(key)
    ) ||
    !validBaseUrl(gateway.baseUrl) ||
    typeof gateway.deviceId !== "string" ||
    !DEVICE_ID.test(gateway.deviceId) ||
    typeof gateway.ollamaModel !== "string" ||
    !MODEL_NAME.test(gateway.ollamaModel)
  ) {
    return null;
  }
  const imageGeneration = normalizeImageGeneration(gateway.imageGeneration ?? null);
  if (imageGeneration === false) return null;
  return {
    hostname: value.hostname,
    customerApiKey: value.customerApiKey,
    dashboardToken: value.dashboardToken,
    gateway: {
      baseUrl: new URL(gateway.baseUrl as string).toString().replace(/\/$/, ""),
      deviceId: gateway.deviceId,
      ollamaModel: gateway.ollamaModel,
      imageGeneration,
    },
  };
}

function configContext(tenantId: string, hostname: string, field: string) {
  return { tenantId, connectionId: hostname, field };
}

function publicConfig(config: CloudFrontDeskConfig) {
  let imageGeneration: GatewayConfigInput["imageGeneration"] = null;
  if (config.imageGenerationJson) {
    const parsed: unknown = JSON.parse(config.imageGenerationJson);
    imageGeneration = normalizeImageGeneration(parsed);
    if (imageGeneration === false) throw new Error("Stored image generation config is invalid");
  }
  return {
    hostname: config.hostname,
    tenantId: config.tenantId,
    hasCustomerApiKey: isCloudCredentialEnvelope(config.customerApiKeyEncrypted),
    hasDashboardToken: isCloudCredentialEnvelope(config.dashboardTokenEncrypted),
    gateway: {
      baseUrl: config.gatewayBaseUrl,
      deviceId: config.deviceId,
      ollamaModel: config.ollamaModel,
      imageGeneration,
    },
    updatedAt: config.updatedAt,
  };
}

function queryHostname(request: Request): string | null {
  const url = new URL(request.url);
  if (
    [...url.searchParams.keys()].some((key) => key !== "hostname") ||
    url.searchParams.getAll("hostname").length !== 1
  ) {
    return null;
  }
  const hostname = url.searchParams.get("hostname") ?? "";
  if (hostname.length > 260) return null;
  return normalizeCustomerHostname(hostname);
}

/** Owner/admin OIDC portal surface; the OIDC wrapper must enforce session and same-origin checks. */
export async function handleCloudFrontDeskConfigPortalRequest(
  request: Request,
  options: CloudFrontDeskConfigApiOptions,
  identity: CloudFrontDeskConfigPortalIdentity
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== "/__cloud/auth/front-desk" &&
    !url.pathname.startsWith("/__cloud/auth/front-desk/")
  ) {
    return null;
  }
  if (url.search !== "") return json({ error: "Query parameters are not supported" }, 400);
  if (!options.db) return json({ error: "Front Desk setup is unavailable" }, 503);
  if (identity.role !== "owner" && identity.role !== "admin") {
    return json({ error: "Owner or admin membership is required" }, 403);
  }
  const allowed = url.pathname === "/__cloud/auth/front-desk" ? ["GET", "PUT"] : ["DELETE"];
  if (!allowed.includes(request.method)) return json({ error: "Method not allowed" }, 405);

  const db = options.db;
  const now = options.now ?? (() => new Date());
  const nowDate = now();
  const portalAuthorization: CloudFrontDeskPortalAuthorization = {
    tenantId: identity.tenantId,
    membershipId: identity.membershipId,
    sessionTokenHash: identity.sessionTokenHash,
    nowMs: nowDate.getTime(),
  };
  try {
    const limit = await consumeCloudRateLimit(db, {
      tenantId: identity.tenantId,
      bucketKey: `customer-frontdesk-portal:${identity.membershipId}`,
      limit: 30,
      windowMs: 60_000,
      nowMs: nowDate.getTime(),
    });
    if (!limit.allowed) return json({ error: "Front Desk setup rate limit exceeded" }, 429);

    if (request.method === "GET") {
      const [hosts, configs, devices] = await Promise.all([
        listAdminVerifiedCustomerHosts(db, identity.tenantId),
        listCloudFrontDeskConfigs(db, identity.tenantId),
        listCloudGatewayDevices(db, identity.tenantId),
      ]);
      const configByHostname = new Map(configs.map((config) => [config.hostname, config]));
      return json({
        devices: devices
          .filter((device) => device.revokedAt === null)
          .map(({ id, capabilities, serviceHealth }) => ({ id, capabilities, serviceHealth })),
        hosts: hosts.map((host) => {
          const config = configByHostname.get(host.hostname);
          return {
            hostname: host.hostname,
            configured: Boolean(config),
            ...(config ? publicConfig(config) : {}),
          };
        }),
      });
    }

    if (request.method === "DELETE") {
      let hostname: string;
      try {
        hostname = decodeURIComponent(url.pathname.slice("/__cloud/auth/front-desk/".length));
      } catch {
        return json({ error: "Invalid hostname" }, 400);
      }
      if (hostname.includes("/") || normalizeCustomerHostname(hostname) !== hostname) {
        return json({ error: "Invalid hostname" }, 400);
      }
      const timestamp = now().toISOString();
      const deletion = prepareDeleteCloudFrontDeskConfig(db, hostname, portalAuthorization);
      const audit = prepareCloudComplianceAuditInsert(
        db,
        {
          id: crypto.randomUUID(),
          tenantId: identity.tenantId,
          timestamp,
          action: "customer.frontdesk.config.delete",
          actor: `membership:${identity.membershipId}`,
          target: hostname,
          resourceType: "front-desk-config",
          status: "success",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { principalId: identity.principalId },
        },
        { requirePreviousStatementChange: true }
      ).statement;
      const results = await db.batch([deletion, audit]);
      const changes = Number(
        (results[0] as { meta?: { changes?: unknown } } | undefined)?.meta?.changes
      );
      if (changes !== 1 || results.some((result) => !result || !result.success)) {
        return json({ error: "Front Desk config could not be removed" }, changes === 0 ? 404 : 503);
      }
      return json({ removed: true });
    }

    if (!isCloudCredentialEncryptionKey(options.credentialEncryptionKey)) {
      return json({ error: "Cloud credential encryption is unavailable" }, 503);
    }
    const value = await readJsonBody(request, options.bodyReadTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS);
    const input = value ? parseConfigInput(value) : null;
    if (!input) return json({ error: "Invalid Front Desk tenant config" }, 400);
    const registration = await getAdminVerifiedCustomerHost(db, input.hostname);
    if (!registration || registration.tenantId !== identity.tenantId) {
      return json({ error: "Customer host is not available to this tenant" }, 404);
    }
    const apiKeyIdentity = await authenticateCloudCustomerApiKey(
      db,
      input.customerApiKey,
      now().toISOString()
    );
    if (
      !apiKeyIdentity ||
      apiKeyIdentity.tenantId !== identity.tenantId ||
      (apiKeyIdentity.role !== "owner" && apiKeyIdentity.role !== "admin")
    ) {
      return json({ error: "Customer API key is not authorized for this host" }, 403);
    }
    const device = await getCloudGatewayDevice(db, input.gateway.deviceId);
    if (
      !device ||
      device.tenantId !== identity.tenantId ||
      device.revokedAt !== null ||
      !device.capabilities.includes(`ollama:chat:${input.gateway.ollamaModel}`) ||
      (input.gateway.imageGeneration !== null && !device.capabilities.includes("comfyui:image"))
    ) {
      return json({ error: "Gateway device is not authorized for this tenant config" }, 403);
    }
    const timestamp = now().toISOString();
    const [customerApiKeyEncrypted, dashboardTokenEncrypted] = await Promise.all([
      encryptCloudCredential(
        input.customerApiKey,
        options.credentialEncryptionKey,
        configContext(identity.tenantId, input.hostname, "customer_api_key")
      ),
      encryptCloudCredential(
        input.dashboardToken,
        options.credentialEncryptionKey,
        configContext(identity.tenantId, input.hostname, "dashboard_token")
      ),
    ]);
    const upsert = prepareUpsertCloudFrontDeskConfig(
      db,
      {
        hostname: input.hostname,
        tenantId: identity.tenantId,
        customerApiKeyEncrypted,
        dashboardTokenEncrypted,
        gatewayBaseUrl: input.gateway.baseUrl,
        deviceId: input.gateway.deviceId,
        ollamaModel: input.gateway.ollamaModel,
        imageGenerationJson:
          input.gateway.imageGeneration === null
            ? null
            : JSON.stringify(input.gateway.imageGeneration),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      portalAuthorization
    );
    const audit = prepareCloudComplianceAuditInsert(
      db,
      {
        id: crypto.randomUUID(),
        tenantId: identity.tenantId,
        timestamp,
        action: "customer.frontdesk.config.write",
        actor: `membership:${identity.membershipId}`,
        target: input.hostname,
        resourceType: "front-desk-config",
        status: "success",
        requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
        metadata: {
          principalId: identity.principalId,
          deviceId: input.gateway.deviceId,
          capabilities: [
            `ollama:chat:${input.gateway.ollamaModel}`,
            ...(input.gateway.imageGeneration ? ["comfyui:image"] : []),
          ],
        },
      },
      { requirePreviousStatementChange: true }
    ).statement;
    const results = await db.batch([upsert, audit]);
    const changes = Number(
      (results[0] as { meta?: { changes?: unknown } } | undefined)?.meta?.changes
    );
    if (changes !== 1 || results.some((result) => !result || !result.success)) {
      return json({ error: "Front Desk config could not be saved" }, 503);
    }
    const saved = await getCloudFrontDeskConfig(db, input.hostname);
    return saved
      ? json({ config: publicConfig(saved) })
      : json({ error: "Save could not be confirmed" }, 503);
  } catch {
    return json({ error: "Front Desk setup could not be completed" }, 503);
  }
}

export async function handleCloudFrontDeskConfigRequest(
  request: Request,
  options: CloudFrontDeskConfigApiOptions
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== CLOUD_FRONT_DESK_CONFIG_PATH &&
    url.pathname !== CLOUD_FRONT_DESK_CONFIGS_PATH &&
    !url.pathname.startsWith(`${CLOUD_FRONT_DESK_CONFIGS_PATH}/`)
  ) {
    return null;
  }
  const db = options.db;
  if (!db) return json({ error: "Cloud database is not configured" }, 503);
  const now = options.now ?? (() => new Date());
  const route = url.pathname.slice(CLOUD_FRONT_DESK_CONFIGS_PATH.length);

  if (url.pathname === CLOUD_FRONT_DESK_CONFIG_PATH) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (!options.serviceToken || !isCloudCredentialEncryptionKey(options.credentialEncryptionKey)) {
      return json({ error: "Front Desk config service is unavailable" }, 503);
    }
    if (!constantTimeBearerMatches(request, options.serviceToken)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const hostname = queryHostname(request);
    if (!hostname) return json({ error: "Invalid hostname" }, 400);
    const registration = await getAdminVerifiedCustomerHost(db, hostname);
    if (!registration) return json({ error: "Front Desk tenant config not found" }, 404);
    const tenant = await getCloudTenantById(db, registration.tenantId);
    const config = await getCloudFrontDeskConfig(db, hostname);
    if (
      !tenant ||
      !tenant.isActive ||
      tenant.kind !== "customer" ||
      !config ||
      config.tenantId !== registration.tenantId ||
      !isCloudCredentialEnvelope(config.customerApiKeyEncrypted) ||
      !isCloudCredentialEnvelope(config.dashboardTokenEncrypted)
    ) {
      return json({ error: "Front Desk tenant config not found" }, 404);
    }
    const [customerApiKey, dashboardToken] = await Promise.all([
      decryptCloudCredential(
        config.customerApiKeyEncrypted,
        options.credentialEncryptionKey,
        configContext(config.tenantId, hostname, "customer_api_key")
      ),
      decryptCloudCredential(
        config.dashboardTokenEncrypted,
        options.credentialEncryptionKey,
        configContext(config.tenantId, hostname, "dashboard_token")
      ),
    ]);
    const [apiKeyIdentity, device] = await Promise.all([
      authenticateCloudCustomerApiKey(db, customerApiKey, now().toISOString()),
      getCloudGatewayDevice(db, config.deviceId),
    ]);
    let imageGeneration: GatewayConfigInput["imageGeneration"] | false;
    try {
      const parsed: unknown = config.imageGenerationJson
        ? JSON.parse(config.imageGenerationJson)
        : null;
      imageGeneration = normalizeImageGeneration(parsed);
    } catch {
      imageGeneration = false;
    }
    if (
      !DASHBOARD_TOKEN.test(dashboardToken) ||
      !apiKeyIdentity ||
      apiKeyIdentity.tenantId !== config.tenantId ||
      (apiKeyIdentity.role !== "owner" && apiKeyIdentity.role !== "admin") ||
      !device ||
      device.tenantId !== config.tenantId ||
      device.revokedAt !== null ||
      !device.capabilities.includes(`ollama:chat:${config.ollamaModel}`) ||
      (imageGeneration !== null &&
        (imageGeneration === false || !device.capabilities.includes("comfyui:image")))
    ) {
      return json({ error: "Front Desk tenant config is invalid" }, 503);
    }
    await appendCloudComplianceAudit(db, {
      id: crypto.randomUUID(),
      tenantId: CLOUD_PLATFORM_TENANT_ID,
      timestamp: now().toISOString(),
      action: "frontdesk.config.read",
      actor: "front-desk-service",
      target: hostname,
      resourceType: "front-desk-config",
      status: "success",
      requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
      metadata: { tenantId: registration.tenantId },
    });
    return json({
      hostname,
      tenantId: config.tenantId,
      customerApiKey,
      dashboardToken,
      gateway: {
        baseUrl: config.gatewayBaseUrl,
        deviceId: config.deviceId,
        ollamaModel: config.ollamaModel,
        imageGeneration,
      },
      updatedAt: config.updatedAt,
    });
  }

  if (!options.adminToken || !constantTimeBearerMatches(request, options.adminToken)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!isCloudCredentialEncryptionKey(options.credentialEncryptionKey)) {
    return json({ error: "Cloud credential encryption is unavailable" }, 503);
  }

  if (route === "" && request.method === "GET") {
    if (
      [...url.searchParams.keys()].some((key) => key !== "tenantId") ||
      url.searchParams.getAll("tenantId").length !== 1
    ) {
      return json({ error: "A single tenantId is required" }, 400);
    }
    const tenantId = url.searchParams.get("tenantId") ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) return json({ error: "Invalid tenantId" }, 400);
    const configs = await listCloudFrontDeskConfigs(db, tenantId);
    return json({ configs: configs.map(publicConfig) });
  }

  if (route === "" && request.method === "PUT") {
    const value = await readJsonBody(request, options.bodyReadTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS);
    const input = value ? parseConfigInput(value) : null;
    if (!input) return json({ error: "Invalid Front Desk tenant config" }, 400);
    const registration = await getAdminVerifiedCustomerHost(db, input.hostname);
    if (!registration) return json({ error: "Customer host is not registered" }, 404);
    const identity = await authenticateCloudCustomerApiKey(
      db,
      input.customerApiKey,
      now().toISOString()
    );
    if (
      !identity ||
      identity.tenantId !== registration.tenantId ||
      (identity.role !== "owner" && identity.role !== "admin")
    ) {
      return json({ error: "Customer API key is not authorized for this host" }, 403);
    }
    const device = await getCloudGatewayDevice(db, input.gateway.deviceId);
    if (
      !device ||
      device.tenantId !== registration.tenantId ||
      device.revokedAt !== null ||
      !device.capabilities.includes(`ollama:chat:${input.gateway.ollamaModel}`) ||
      (input.gateway.imageGeneration !== null && !device.capabilities.includes("comfyui:image"))
    ) {
      return json({ error: "Gateway device is not authorized for this tenant config" }, 403);
    }

    const timestamp = now().toISOString();
    const [customerApiKeyEncrypted, dashboardTokenEncrypted] = await Promise.all([
      encryptCloudCredential(
        input.customerApiKey,
        options.credentialEncryptionKey,
        configContext(registration.tenantId, input.hostname, "customer_api_key")
      ),
      encryptCloudCredential(
        input.dashboardToken,
        options.credentialEncryptionKey,
        configContext(registration.tenantId, input.hostname, "dashboard_token")
      ),
    ]);
    const upsert = prepareUpsertCloudFrontDeskConfig(db, {
      hostname: input.hostname,
      tenantId: registration.tenantId,
      customerApiKeyEncrypted,
      dashboardTokenEncrypted,
      gatewayBaseUrl: input.gateway.baseUrl,
      deviceId: input.gateway.deviceId,
      ollamaModel: input.gateway.ollamaModel,
      imageGenerationJson:
        input.gateway.imageGeneration === null
          ? null
          : JSON.stringify(input.gateway.imageGeneration),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const audit = prepareCloudComplianceAuditInsert(
      db,
      {
        id: crypto.randomUUID(),
        tenantId: CLOUD_PLATFORM_TENANT_ID,
        timestamp,
        action: "frontdesk.config.write",
        actor: "cloud-admin",
        target: input.hostname,
        resourceType: "front-desk-config",
        status: "success",
        requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
        metadata: {
          tenantId: registration.tenantId,
          deviceId: input.gateway.deviceId,
          gatewayCapabilities: [
            `ollama:chat:${input.gateway.ollamaModel}`,
            ...(input.gateway.imageGeneration ? ["comfyui:image"] : []),
          ],
        },
      },
      { requirePreviousStatementChange: true }
    ).statement;
    const results = await db.batch([upsert, audit]);
    const changes =
      typeof results[0] === "object" && results[0] !== null && "meta" in results[0]
        ? Number((results[0] as { meta?: { changes?: unknown } }).meta?.changes)
        : Number.NaN;
    if (
      changes !== 1 ||
      results.some(
        (result) =>
          !result ||
          typeof result !== "object" ||
          !("success" in result) ||
          result.success === false
      )
    ) {
      return json({ error: "Front Desk tenant config could not be saved" }, 503);
    }
    const saved = await getCloudFrontDeskConfig(db, input.hostname);
    if (!saved) return json({ error: "Front Desk tenant config could not be confirmed" }, 503);
    return json({ config: publicConfig(saved) });
  }

  const deleteMatch = /^\/([^/]+)$/.exec(route);
  if (deleteMatch && request.method === "DELETE") {
    let hostname: string;
    try {
      hostname = decodeURIComponent(deleteMatch[1]);
    } catch {
      return json({ error: "Invalid hostname" }, 400);
    }
    if (normalizeCustomerHostname(hostname) !== hostname) {
      return json({ error: "Invalid hostname" }, 400);
    }
    const config = await getCloudFrontDeskConfig(db, hostname);
    if (!config) return json({ error: "Front Desk tenant config not found" }, 404);
    const timestamp = now().toISOString();
    const results = await db.batch([
      prepareDeleteCloudFrontDeskConfig(db, hostname),
      prepareCloudComplianceAuditInsert(
        db,
        {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp,
          action: "frontdesk.config.delete",
          actor: "cloud-admin",
          target: hostname,
          resourceType: "front-desk-config",
          status: "success",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { tenantId: config.tenantId },
        },
        { requirePreviousStatementChange: true }
      ).statement,
    ]);
    const changes =
      typeof results[0] === "object" && results[0] !== null && "meta" in results[0]
        ? Number((results[0] as { meta?: { changes?: unknown } }).meta?.changes)
        : Number.NaN;
    return changes === 1
      ? json({ removed: true })
      : json({ error: "Front Desk tenant config could not be removed" }, 503);
  }

  return json({ error: "Not found" }, 404);
}
