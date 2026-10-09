import {
  createCloudProviderConnection,
  createCloudProviderNode,
  deleteCloudProviderConnection,
  deleteCloudProviderNode,
  getCloudProviderConnectionById,
  getCloudProviderConnections,
  getCloudProviderNodeById,
  getCloudProviderNodes,
  updateCloudProviderConnection,
  updateCloudProviderNode,
  type CloudProviderConnection,
  type CloudProviderConnectionInput,
  type CloudProviderNode,
  type CloudProviderNodeInput,
} from "./providers";
import type { CloudDb } from "./db";
import {
  CLOUD_PLATFORM_TENANT_ID,
  getCloudTenantById,
  setCloudCustomerTenantActive,
} from "./tenants";
import { appendCloudComplianceAudit } from "./complianceAudit";
import { provisionCloudCustomer, rollbackCloudCustomerProvisioning } from "./provisioning";
import { consumeCloudRateLimit } from "./rateLimit";
import { appendCloudUsageRecord, listCloudUsageRecords } from "./usage";
import {
  getCloudGatewayDevice,
  listCloudGatewayDeviceIds,
  listCloudGatewayDevices,
  registerCloudGatewayDevice,
  revokeCloudGatewayDeviceCredential,
  rotateCloudGatewayDeviceCredential,
} from "./gatewayDevices";
import {
  createCloudCustomerMembership,
  CloudLastActiveOwnerError,
  getCloudCustomerMembership,
  issueCloudCustomerApiKey,
  revokeCloudCustomerApiKey,
  updateCloudCustomerMembership,
  type CloudCustomerRole,
} from "./customerIdentity";
import type {
  GatewayCoordinatorStub,
  GatewayDurableObjectNamespace,
} from "./connectorGatewayDurableObject";
import { CloudCredentialEncryptionError, encryptCloudCredential } from "./credentialEncryption";
import {
  getCloudInferenceBudgetStatus,
  listCloudInferenceEntitlements,
  setCloudInferenceEntitlement,
  setCloudInferenceMonthlyBudget,
  type CloudInferenceEntitlement,
} from "./inferencePolicy";
import {
  addCloudTenantOidcIdentity,
  deleteCloudTenantOidcConfig,
  deleteCloudTenantOidcIdentity,
  getCloudTenantOidcConfig,
  listCloudTenantOidcIdentities,
  setCloudTenantOidcConfig,
} from "./tenantOidc";

const API_PREFIX = "/__cloud/v1/tenants";
const MAX_BODY_BYTES = 256 * 1024;
export interface CloudApiOptions {
  db?: CloudDb;
  /** Privileged server-to-server token. Never expose this value to browser clients. */
  adminToken?: string;
  /** Optional token limited to tenant provisioning and lifecycle operations. */
  maintenanceToken?: string;
  /** Base64-encoded 32-byte secret used only by the Worker credential envelope. */
  credentialEncryptionKey?: string;
  sessions?: GatewayDurableObjectNamespace<GatewayCoordinatorStub>;
  now?: () => Date;
  /** Test override; production defaults are intentionally conservative. */
  adminRateLimit?: { limit: number; windowMs: number };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function decodeSegments(pathname: string): string[] | null {
  try {
    return pathname
      .slice(API_PREFIX.length)
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function authorized(request: Request, token: string): boolean {
  const supplied = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${token}`;
  let difference = supplied.length ^ expected.length;
  const length = Math.max(supplied.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (supplied.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "Expected application/json");
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "Request body is too large");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "Request body is too large");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const CONNECTION_FIELDS = [
  "provider",
  "authType",
  "name",
  "email",
  "priority",
  "isActive",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "tokenExpiresAt",
  "scope",
  "projectId",
  "testStatus",
  "errorCode",
  "lastError",
  "lastErrorAt",
  "apiKey",
  "idToken",
  "providerSpecificData",
  "expiresIn",
  "displayName",
  "globalPriority",
  "defaultModel",
  "tokenType",
] as const;

const NODE_FIELDS = [
  "type",
  "name",
  "prefix",
  "apiType",
  "baseUrl",
  "chatPath",
  "modelsPath",
  "iconUrl",
  "customHeadersJson",
] as const;

const USAGE_FIELDS = [
  "id",
  "provider",
  "model",
  "connectionId",
  "apiKeyId",
  "apiKeyName",
  "tokensInput",
  "tokensOutput",
  "tokensCacheRead",
  "tokensCacheCreation",
  "tokensReasoning",
  "serviceTier",
  "status",
  "success",
  "latencyMs",
  "timeToFirstTokenMs",
  "errorCode",
  "comboStrategy",
  "endpoint",
  "timestamp",
] as const;

function validateFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = []
): Record<string, unknown> {
  if (!isRecord(value)) throw new ApiError(400, "Expected a JSON object");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ApiError(400, `Unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new ApiError(400, `Missing required field: ${key}`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new ApiError(400, `${field} must be a string or null`);
  return value;
}

async function connectionInput(
  value: unknown,
  tenantId: string,
  encryptionKey: string | undefined,
  connectionId?: string,
  isPatch = false
): Promise<
  CloudProviderConnectionInput | Partial<Omit<CloudProviderConnectionInput, "id" | "tenantId">>
> {
  const allowed = isPatch ? CONNECTION_FIELDS : ["id", ...CONNECTION_FIELDS];
  const body = validateFields(value, allowed, isPatch ? [] : ["id", "provider"]);
  const result: Record<string, unknown> = {};

  if (!isPatch) {
    if (typeof body.id !== "string" || !validId(body.id)) throw new ApiError(400, "Invalid id");
    result.id = body.id;
    result.tenantId = tenantId;
    connectionId = body.id;
  }

  for (const field of CONNECTION_FIELDS) {
    if (!(field in body)) continue;
    const current = body[field];
    if (["priority", "expiresIn", "globalPriority"].includes(field)) {
      const nullable = field !== "priority";
      if (
        (current === null && !nullable) ||
        (current !== null &&
          (typeof current !== "number" || !Number.isInteger(current) || !Number.isFinite(current)))
      ) {
        throw new ApiError(400, `${field} must be ${nullable ? "a number or null" : "a number"}`);
      }
      result[field] = current;
    } else if (field === "isActive") {
      if (typeof current !== "boolean") throw new ApiError(400, "isActive must be a boolean");
      result[field] = current;
    } else if (field === "providerSpecificData") {
      if (current !== null && typeof current !== "object" && typeof current !== "string") {
        throw new ApiError(400, "providerSpecificData must be an object, string, or null");
      }
      if (current === null) {
        result[field] = null;
      } else {
        if (typeof current === "string" && isSubmittedCiphertext(current)) {
          throw new ApiError(400, `${field} must be submitted as plaintext`);
        }
        const plaintext = typeof current === "string" ? current : JSON.stringify(current);
        result[field] = await encryptCredentialField(
          plaintext,
          encryptionKey,
          tenantId,
          connectionId,
          field
        );
      }
    } else {
      const normalized = nullableString(current, field);
      if (field === "provider" && (!normalized || !normalized.trim())) {
        throw new ApiError(400, "provider cannot be empty");
      }
      if (["accessToken", "refreshToken", "apiKey", "idToken"].includes(field)) {
        if (normalized !== null) {
          if (isSubmittedCiphertext(normalized)) {
            throw new ApiError(400, `${field} must be submitted as plaintext`);
          }
          result[field] = await encryptCredentialField(
            normalized,
            encryptionKey,
            tenantId,
            connectionId,
            field
          );
          continue;
        }
      }
      result[field] = normalized;
    }
  }

  if (isPatch && Object.keys(result).length === 0) throw new ApiError(400, "Patch is empty");
  return result as unknown as CloudProviderConnectionInput;
}

function isSubmittedCiphertext(value: string): boolean {
  return value.startsWith("enc:v1:") || value.startsWith("enc:v2:");
}

async function encryptCredentialField(
  plaintext: string,
  encryptionKey: string | undefined,
  tenantId: string,
  connectionId: string | undefined,
  field: string
): Promise<string> {
  if (!connectionId) throw new ApiError(400, "Invalid provider connection context");
  try {
    return await encryptCloudCredential(plaintext, encryptionKey, {
      tenantId,
      connectionId,
      field,
    });
  } catch (error) {
    if (error instanceof CloudCredentialEncryptionError) {
      throw new ApiError(503, "Cloud credential encryption is unavailable");
    }
    throw new ApiError(503, "Cloud credential encryption is unavailable");
  }
}

async function nodeInput(
  value: unknown,
  tenantId: string,
  encryptionKey: string | undefined,
  nodeId?: string,
  isPatch = false
): Promise<CloudProviderNodeInput | Partial<Omit<CloudProviderNodeInput, "id" | "tenantId">>> {
  const allowed = isPatch ? NODE_FIELDS : ["id", ...NODE_FIELDS];
  const body = validateFields(value, allowed, isPatch ? [] : ["id", "type", "name"]);
  const result: Record<string, unknown> = {};

  if (!isPatch) {
    if (typeof body.id !== "string" || !validId(body.id)) throw new ApiError(400, "Invalid id");
    result.id = body.id;
    result.tenantId = tenantId;
    nodeId = body.id;
  }

  for (const field of NODE_FIELDS) {
    if (!(field in body)) continue;
    const fieldValue = nullableString(body[field], field);
    if ((field === "type" || field === "name") && (!fieldValue || !fieldValue.trim())) {
      throw new ApiError(400, `${field} cannot be empty`);
    }
    if (field === "customHeadersJson" && fieldValue !== null) {
      if (isSubmittedCiphertext(fieldValue)) {
        throw new ApiError(400, `${field} must be submitted as plaintext`);
      }
      result[field] = await encryptCredentialField(
        fieldValue,
        encryptionKey,
        tenantId,
        nodeId,
        field
      );
    } else {
      result[field] = fieldValue;
    }
  }
  if (isPatch && Object.keys(result).length === 0) throw new ApiError(400, "Patch is empty");
  return result as unknown as CloudProviderNodeInput;
}

function safeConnection(
  connection: CloudProviderConnection
): Omit<
  CloudProviderConnection,
  "accessToken" | "refreshToken" | "apiKey" | "idToken" | "providerSpecificData"
> & { hasCredentials: boolean } {
  const {
    accessToken,
    refreshToken,
    apiKey,
    idToken,
    providerSpecificData: _providerSpecificData,
    ...safe
  } = connection;
  return {
    ...safe,
    hasCredentials: Boolean(accessToken || refreshToken || apiKey || idToken),
  };
}

function safeNode(node: CloudProviderNode): Omit<CloudProviderNode, "customHeadersJson"> & {
  hasCustomHeaders: boolean;
} {
  const { customHeadersJson, ...safe } = node;
  return { ...safe, hasCustomHeaders: Boolean(customHeadersJson) };
}

async function readBody(request: Request): Promise<unknown> {
  return readJson(request);
}

async function tenantExists(db: CloudDb, tenantId: string): Promise<boolean> {
  const tenant = await getCloudTenantById(db, tenantId);
  return tenant?.isActive === true;
}

async function invalidateDeviceSessions(
  sessions: GatewayDurableObjectNamespace<GatewayCoordinatorStub> | undefined,
  deviceIds: string[],
  revokedAt: string
): Promise<void> {
  if (deviceIds.length === 0) return;
  if (!sessions) throw new ApiError(503, "Gateway session storage is not configured");
  await Promise.all(
    deviceIds.map((deviceId) =>
      sessions.get(sessions.idFromName(deviceId)).revokeSession(deviceId, revokedAt)
    )
  );
}

function conflictOrError(error: unknown): Response {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("unique") || message.includes("constraint")) {
    return json({ error: "Resource conflicts with an existing record" }, 409);
  }
  return json({ error: "Cloud database operation failed" }, 500);
}

export async function handleCloudApiRequest(
  request: Request,
  options: CloudApiOptions
): Promise<Response> {
  if (
    options.adminToken &&
    options.maintenanceToken &&
    options.adminToken === options.maintenanceToken
  ) {
    return json({ error: "Cloud API is not configured" }, 503);
  }
  const segments = decodeSegments(new URL(request.url).pathname);
  if (!segments) return json({ error: "Malformed path" }, 400);
  const maintenanceRoute =
    (segments.length === 0 && request.method === "POST") ||
    (segments.length === 2 &&
      segments[1] === "status" &&
      (request.method === "GET" || request.method === "POST"));
  const isMaintenanceToken =
    maintenanceRoute && !!options.maintenanceToken && authorized(request, options.maintenanceToken);
  const isAdminToken = !!options.adminToken && authorized(request, options.adminToken);
  if (!options.adminToken && !(maintenanceRoute && options.maintenanceToken)) {
    return json({ error: "Cloud API is not configured" }, 503);
  }
  if (!isAdminToken && !isMaintenanceToken) return json({ error: "Unauthorized" }, 401);
  const auditActor = isMaintenanceToken && !isAdminToken ? "cloud-maintenance" : "cloud-admin";
  if (!options.db) return json({ error: "Cloud database is not configured" }, 503);
  if (request.method === "OPTIONS") return json({ error: "Method not allowed" }, 405);
  const db = options.db;
  const now = options.now ?? (() => new Date());

  try {
    // Customer identity provisioning is a platform-admin control-plane action.
    // The global admin token authorizes these management calls but is never
    // accepted or mapped as a customer API key identity.
    const isCustomerIdentityPath =
      (segments.length === 2 && segments[1] === "memberships" && request.method === "POST") ||
      (segments.length === 3 && segments[1] === "memberships" && request.method === "PATCH") ||
      (segments.length === 4 &&
        segments[1] === "memberships" &&
        segments[3] === "api-keys" &&
        request.method === "POST") ||
      (segments.length === 3 && segments[1] === "api-keys" && request.method === "DELETE") ||
      (segments.length === 2 &&
        segments[1] === "oidc" &&
        ["GET", "PUT", "DELETE"].includes(request.method)) ||
      (segments.length === 3 &&
        segments[1] === "oidc" &&
        segments[2] === "identities" &&
        ["GET", "POST"].includes(request.method)) ||
      (segments.length === 4 &&
        segments[1] === "oidc" &&
        segments[2] === "identities" &&
        request.method === "DELETE");
    if (isCustomerIdentityPath) {
      const [tenantId, collection, resourceId] = segments;
      if (!validId(tenantId) || (resourceId !== undefined && !validId(resourceId))) {
        return json({ error: "Not found" }, 404);
      }
      const platformTenant = await getCloudTenantById(db, CLOUD_PLATFORM_TENANT_ID);
      if (platformTenant?.kind !== "platform_admin" || !platformTenant.isActive) {
        return json({ error: "Cloud platform tenant is not configured" }, 503);
      }
      const rateLimit = await consumeCloudRateLimit(db, {
        tenantId: CLOUD_PLATFORM_TENANT_ID,
        bucketKey: "cloud-admin-api",
        limit: options.adminRateLimit?.limit ?? 300,
        windowMs: options.adminRateLimit?.windowMs ?? 60_000,
        nowMs: now().getTime(),
      });
      if (!rateLimit.allowed) return json({ error: "Cloud API rate limit exceeded" }, 429);

      if (collection === "oidc") {
        const target = await getCloudTenantById(db, tenantId);
        if (!target || target.kind !== "customer") return json({ error: "Tenant not found" }, 404);
        const timestamp = now().toISOString();
        const requestId = request.headers.get("cf-ray") ?? request.headers.get("x-request-id");
        const recordAudit = async (
          action: string,
          auditTarget: string,
          status: "attempted" | "success",
          metadata: Record<string, unknown> = {}
        ) =>
          appendCloudComplianceAudit(db, {
            id: crypto.randomUUID(),
            tenantId: CLOUD_PLATFORM_TENANT_ID,
            timestamp: now().toISOString(),
            action,
            actor: auditActor,
            target: auditTarget,
            resourceType: "customer-oidc",
            status,
            requestId,
            metadata: { tenantId, ...metadata },
          });

        if (segments.length === 2) {
          if (request.method === "GET") {
            return json(await getCloudTenantOidcConfig(db, tenantId));
          }
          if (request.method === "PUT") {
            const body = validateFields(
              await readBody(request),
              ["issuer", "clientId", "clientSecret", "scopes", "isEnabled"],
              ["issuer", "clientId"]
            );
            if (typeof body.issuer !== "string" || typeof body.clientId !== "string") {
              throw new ApiError(400, "Invalid OIDC issuer or clientId");
            }
            if (body.clientSecret !== undefined && typeof body.clientSecret !== "string") {
              throw new ApiError(400, "clientSecret must be a string");
            }
            if (
              body.scopes !== undefined &&
              (!Array.isArray(body.scopes) ||
                body.scopes.some((scope) => typeof scope !== "string"))
            ) {
              throw new ApiError(400, "scopes must be an array of strings");
            }
            if (body.isEnabled !== undefined && typeof body.isEnabled !== "boolean") {
              throw new ApiError(400, "isEnabled must be a boolean");
            }
            const current = await getCloudTenantOidcConfig(db, tenantId);
            const configAction = current
              ? "customer.oidc.config.update"
              : "customer.oidc.config.create";
            await recordAudit(configAction, tenantId, "attempted", {
              issuer: body.issuer,
            });
            let config;
            try {
              config = await setCloudTenantOidcConfig(db, options.credentialEncryptionKey, {
                tenantId,
                issuer: body.issuer,
                clientId: body.clientId,
                clientSecret: body.clientSecret as string | undefined,
                scopes: (body.scopes as string[] | undefined) ?? current?.scopes,
                isEnabled: body.isEnabled as boolean | undefined,
                now: timestamp,
              });
            } catch (error) {
              if (error instanceof TypeError || error instanceof RangeError) {
                throw new ApiError(400, error.message);
              }
              if (error instanceof CloudCredentialEncryptionError) {
                throw new ApiError(503, "OIDC credential encryption is unavailable");
              }
              throw error;
            }
            await recordAudit(configAction, tenantId, "success", {
              issuer: config.issuer,
              isEnabled: config.isEnabled,
            });
            return json(config, current ? 200 : 201);
          }
          if (request.method === "DELETE") {
            await recordAudit("customer.oidc.config.delete", tenantId, "attempted");
            if (!(await deleteCloudTenantOidcConfig(db, tenantId))) {
              return json({ error: "OIDC configuration not found" }, 404);
            }
            await recordAudit("customer.oidc.config.delete", tenantId, "success");
            return json({ deleted: true });
          }
        }

        if (segments.length === 3 && resourceId === "identities") {
          if (request.method === "GET") {
            return json(await listCloudTenantOidcIdentities(db, tenantId));
          }
          if (request.method === "POST") {
            const body = validateFields(
              await readBody(request),
              ["issuer", "subject", "membershipId"],
              ["issuer", "subject", "membershipId"]
            );
            if (
              typeof body.issuer !== "string" ||
              typeof body.subject !== "string" ||
              typeof body.membershipId !== "string"
            ) {
              throw new ApiError(400, "Invalid OIDC identity link");
            }
            await recordAudit("customer.oidc.identity.link", body.membershipId, "attempted", {
              issuer: body.issuer,
            });
            let identity;
            try {
              identity = await addCloudTenantOidcIdentity(db, {
                tenantId,
                issuer: body.issuer,
                subject: body.subject,
                membershipId: body.membershipId,
                now: timestamp,
              });
            } catch (error) {
              if (error instanceof TypeError || error instanceof RangeError) {
                const status = error.message.includes("not found") ? 404 : 400;
                throw new ApiError(status, error.message);
              }
              throw error;
            }
            await recordAudit("customer.oidc.identity.link", identity.id, "success", {
              membershipId: identity.membershipId,
              issuer: identity.issuer,
            });
            return json(identity, 201);
          }
        }

        if (segments.length === 4 && resourceId === "identities" && request.method === "DELETE") {
          const identityId = segments[3];
          if (!validId(identityId)) return json({ error: "Not found" }, 404);
          await recordAudit("customer.oidc.identity.unlink", identityId, "attempted");
          if (!(await deleteCloudTenantOidcIdentity(db, tenantId, identityId))) {
            return json({ error: "OIDC identity link not found" }, 404);
          }
          await recordAudit("customer.oidc.identity.unlink", identityId, "success");
          return json({ deleted: true });
        }
        return json({ error: "Method not allowed" }, 405);
      }

      if (collection === "memberships" && resourceId === undefined) {
        const target = await getCloudTenantById(db, tenantId);
        if (!target || target.kind !== "customer") return json({ error: "Tenant not found" }, 404);
        const body = validateFields(
          await readBody(request),
          ["principalId", "role"],
          ["principalId", "role"]
        );
        if (typeof body.principalId !== "string" || !validId(body.principalId)) {
          throw new ApiError(400, "Invalid principalId");
        }
        if (
          typeof body.role !== "string" ||
          !["owner", "admin", "member", "viewer"].includes(body.role)
        ) {
          throw new ApiError(400, "Invalid customer role");
        }
        const timestamp = now().toISOString();
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp,
          action: "customer.membership.create",
          actor: auditActor,
          target: tenantId,
          resourceType: "customer-membership",
          status: "attempted",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { role: body.role },
        });
        const membership = await createCloudCustomerMembership(db, {
          tenantId,
          principalId: body.principalId,
          role: body.role as CloudCustomerRole,
          now: timestamp,
        });
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp: now().toISOString(),
          action: "customer.membership.create",
          actor: auditActor,
          target: membership.id,
          resourceType: "customer-membership",
          status: "success",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { tenantId, role: membership.role },
        });
        return json(membership, 201);
      }

      if (collection === "memberships" && resourceId !== undefined && request.method === "PATCH") {
        const target = await getCloudTenantById(db, tenantId);
        if (!target || target.kind !== "customer") return json({ error: "Tenant not found" }, 404);
        const currentMembership = await getCloudCustomerMembership(db, tenantId, resourceId);
        if (!currentMembership) return json({ error: "Membership not found" }, 404);
        const body = validateFields(await readBody(request), ["role", "isActive"]);
        if (body.role === undefined && body.isActive === undefined) {
          throw new ApiError(400, "At least one of role or isActive is required");
        }
        if (
          body.role !== undefined &&
          (typeof body.role !== "string" ||
            !["owner", "admin", "member", "viewer"].includes(body.role))
        ) {
          throw new ApiError(400, "Invalid customer role");
        }
        if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
          throw new ApiError(400, "isActive must be a boolean");
        }
        const nextRole = (body.role as CloudCustomerRole | undefined) ?? currentMembership.role;
        const nextActive = (body.isActive as boolean | undefined) ?? currentMembership.isActive;
        const timestamp = now().toISOString();
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp,
          action: "customer.membership.update",
          actor: auditActor,
          target: resourceId,
          resourceType: "customer-membership",
          status: "attempted",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { tenantId, role: nextRole, isActive: nextActive },
        });
        let membership;
        try {
          membership = await updateCloudCustomerMembership(db, {
            tenantId,
            membershipId: resourceId,
            role: nextRole,
            isActive: nextActive,
            now: timestamp,
          });
        } catch (error) {
          if (error instanceof CloudLastActiveOwnerError) throw new ApiError(409, error.message);
          throw error;
        }
        if (!membership) return json({ error: "Membership not found" }, 404);
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp: now().toISOString(),
          action: "customer.membership.update",
          actor: auditActor,
          target: membership.id,
          resourceType: "customer-membership",
          status: "success",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { tenantId, role: membership.role, isActive: membership.isActive },
        });
        return json(membership);
      }

      if (collection === "memberships" && resourceId !== undefined) {
        const target = await getCloudTenantById(db, tenantId);
        if (!target || target.kind !== "customer") return json({ error: "Tenant not found" }, 404);
        const body = validateFields(await readBody(request), ["expiresAt"]);
        if (
          body.expiresAt !== undefined &&
          body.expiresAt !== null &&
          typeof body.expiresAt !== "string"
        ) {
          throw new ApiError(400, "expiresAt must be a timestamp or null");
        }
        const timestamp = now().toISOString();
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp,
          action: "customer.api-key.issue",
          actor: auditActor,
          target: tenantId,
          resourceType: "customer-api-key",
          status: "attempted",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { membershipId: resourceId },
        });
        const key = await issueCloudCustomerApiKey(db, {
          tenantId,
          membershipId: resourceId,
          expiresAt: (body.expiresAt as string | null | undefined) ?? null,
          now: timestamp,
        });
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp: now().toISOString(),
          action: "customer.api-key.issue",
          actor: auditActor,
          target: key.id,
          resourceType: "customer-api-key",
          status: "success",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { tenantId, membershipId: resourceId, expiresAt: key.expiresAt },
        });
        return json(key, 201);
      }

      if (collection === "api-keys" && resourceId !== undefined) {
        const target = await getCloudTenantById(db, tenantId);
        if (!target || target.kind !== "customer") return json({ error: "Tenant not found" }, 404);
        const timestamp = now().toISOString();
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp,
          action: "customer.api-key.revoke",
          actor: auditActor,
          target: resourceId,
          resourceType: "customer-api-key",
          status: "attempted",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { tenantId },
        });
        const revoked = await revokeCloudCustomerApiKey(db, {
          tenantId,
          apiKeyId: resourceId,
          now: timestamp,
        });
        if (!revoked) return json({ error: "Not found" }, 404);
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp: now().toISOString(),
          action: "customer.api-key.revoke",
          actor: auditActor,
          target: resourceId,
          resourceType: "customer-api-key",
          status: "success",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { tenantId },
        });
        return json({ revoked: true });
      }
    }

    // Tenant lifecycle is a control-plane operation. It is intentionally
    // reachable for suspended tenants, but only through the global platform
    // admin credential and only for customer rows.
    if (
      segments.length === 2 &&
      segments[1] === "status" &&
      (request.method === "POST" || request.method === "GET")
    ) {
      const platformTenant = await getCloudTenantById(db, CLOUD_PLATFORM_TENANT_ID);
      if (platformTenant?.kind !== "platform_admin" || !platformTenant.isActive) {
        return json({ error: "Cloud platform tenant is not configured" }, 503);
      }
      const target = await getCloudTenantById(db, segments[0]);
      if (!target || target.kind !== "customer") return json({ error: "Tenant not found" }, 404);
      const rateLimit = await consumeCloudRateLimit(db, {
        tenantId: CLOUD_PLATFORM_TENANT_ID,
        bucketKey: "cloud-admin-api",
        limit: options.adminRateLimit?.limit ?? 300,
        windowMs: options.adminRateLimit?.windowMs ?? 60_000,
        nowMs: now().getTime(),
      });
      if (!rateLimit.allowed) return json({ error: "Cloud API rate limit exceeded" }, 429);
      if (request.method === "GET") return json(target);

      const body = validateFields(await readBody(request), ["status"], ["status"]);
      if (body.status !== "active" && body.status !== "suspended") {
        throw new ApiError(400, "status must be active or suspended");
      }
      const isActive = body.status === "active";
      const timestamp = now().toISOString();
      try {
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp,
          action: "tenant.lifecycle.status",
          actor: auditActor,
          target: target.id,
          resourceType: "tenant",
          status: "attempted",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { status: body.status },
        });
      } catch {
        return json({ error: "Cloud API audit storage is unavailable" }, 503);
      }

      let updated = target;
      try {
        if (target.isActive !== isActive) {
          const deviceIds = await listCloudGatewayDeviceIds(db, target.id);
          if (isActive) {
            await invalidateDeviceSessions(options.sessions, deviceIds, timestamp);
            updated =
              (await setCloudCustomerTenantActive(db, target.id, true, timestamp)) ?? target;
          } else {
            updated =
              (await setCloudCustomerTenantActive(db, target.id, false, timestamp)) ?? target;
            await invalidateDeviceSessions(options.sessions, deviceIds, timestamp);
          }
        }
      } catch {
        return json({ error: "Tenant lifecycle operation could not be completed" }, 503);
      }
      try {
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp: now().toISOString(),
          action: "tenant.lifecycle.status",
          actor: auditActor,
          target: target.id,
          resourceType: "tenant",
          status: "success",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { status: body.status },
        });
      } catch {
        return json({ error: "Tenant status changed but audit confirmation failed" }, 503);
      }
      return json(updated);
    }

    if (segments.length === 0 && request.method === "POST") {
      const platformTenant = await getCloudTenantById(db, CLOUD_PLATFORM_TENANT_ID);
      if (platformTenant?.kind !== "platform_admin" || !platformTenant.isActive) {
        return json({ error: "Cloud platform tenant is not configured" }, 503);
      }

      const rateLimit = await consumeCloudRateLimit(db, {
        tenantId: CLOUD_PLATFORM_TENANT_ID,
        bucketKey: "cloud-admin-api",
        limit: options.adminRateLimit?.limit ?? 300,
        windowMs: options.adminRateLimit?.windowMs ?? 60_000,
        nowMs: now().getTime(),
      });
      if (!rateLimit.allowed) {
        return json({ error: "Cloud API rate limit exceeded" }, 429);
      }
      try {
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp: now().toISOString(),
          action: "cloud.api.post",
          actor: auditActor,
          target: "tenants",
          resourceType: "cloud-api",
          status: "attempted",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { method: request.method, collection: "tenants" },
        });
      } catch {
        return json({ error: "Cloud API audit storage is unavailable" }, 503);
      }

      const body = validateFields(
        await readBody(request),
        ["id", "name", "slug", "ownerPrincipalId"],
        ["id", "name", "slug"]
      );
      if (typeof body.id !== "string" || !validId(body.id)) throw new ApiError(400, "Invalid id");
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw new ApiError(400, "name cannot be empty");
      }
      if (typeof body.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.slug)) {
        throw new ApiError(400, "Invalid slug");
      }
      if (typeof body.ownerPrincipalId !== "string" || !validId(body.ownerPrincipalId)) {
        throw new ApiError(400, "An ownerPrincipalId from a trusted identity flow is required");
      }
      const provisioned = await provisionCloudCustomer(db, {
        id: body.id,
        name: body.name.trim(),
        slug: body.slug,
        ownerPrincipalId: body.ownerPrincipalId,
        now: now().toISOString(),
      });
      try {
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId: CLOUD_PLATFORM_TENANT_ID,
          timestamp: now().toISOString(),
          action: "customer.provision",
          actor: auditActor,
          target: provisioned.tenant.id,
          resourceType: "customer-tenant",
          status: "success",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: {
            slug: provisioned.tenant.slug,
            membershipId: provisioned.ownerMembership.id,
            apiKeyId: provisioned.ownerApiKey.id,
          },
        });
      } catch {
        try {
          await rollbackCloudCustomerProvisioning(db, provisioned.tenant.id);
        } catch {
          return json({ error: "Customer provisioning rollback could not be confirmed" }, 503);
        }
        return json({ error: "Customer provisioning audit could not be completed" }, 503);
      }
      return json(provisioned, 201);
    }

    if (segments.length === 0) return json({ error: "Not found" }, 404);
    if (segments.length < 1 || !validId(segments[0])) return json({ error: "Not found" }, 404);
    const tenantId = segments[0];
    if (!(await tenantExists(db, tenantId))) return json({ error: "Tenant not found" }, 404);
    const rateLimit = await consumeCloudRateLimit(db, {
      tenantId,
      bucketKey: "cloud-admin-api",
      limit: options.adminRateLimit?.limit ?? 300,
      windowMs: options.adminRateLimit?.windowMs ?? 60_000,
      nowMs: now().getTime(),
    });
    if (!rateLimit.allowed) {
      return json({ error: "Cloud API rate limit exceeded" }, 429);
    }

    if (segments.length === 1) {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const tenant = await getCloudTenantById(db, tenantId);
      return tenant ? json(tenant) : json({ error: "Tenant not found" }, 404);
    }

    const [collection, resourceId] = segments.slice(1);

    // The route's tenant is a requested resource, not an authenticated identity.
    // This API is currently only available to the configured server-side admin
    // token; resolve the target against D1 before using it as a tenant partition.
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      try {
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId,
          timestamp: now().toISOString(),
          action: `cloud.api.${request.method.toLowerCase()}`,
          actor: "cloud-admin",
          target: [collection, resourceId].filter(Boolean).join("/"),
          resourceType: "cloud-api",
          status: "attempted",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { method: request.method, collection },
        });
      } catch {
        return json({ error: "Cloud API audit storage is unavailable" }, 503);
      }
    }

    if (
      (collection === "inference-entitlements" || collection === "inference-budget") &&
      segments.length === 2
    ) {
      const targetTenant = await getCloudTenantById(db, tenantId);
      if (!targetTenant || targetTenant.kind !== "customer") {
        return json({ error: "Tenant not found" }, 404);
      }

      if (collection === "inference-entitlements") {
        if (request.method === "GET") {
          return json(await listCloudInferenceEntitlements(db, tenantId));
        }
        if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);

        const body = validateFields(
          await readBody(request),
          ["provider", "model", "enabled", "maxInputTokens", "maxOutputTokens"],
          ["provider", "model", "enabled", "maxInputTokens", "maxOutputTokens"]
        );
        if (typeof body.provider !== "string") throw new ApiError(400, "Invalid provider");
        if (typeof body.model !== "string") throw new ApiError(400, "Invalid model");
        if (typeof body.enabled !== "boolean") {
          throw new ApiError(400, "enabled must be a boolean");
        }
        if (
          typeof body.maxInputTokens !== "number" ||
          !Number.isSafeInteger(body.maxInputTokens) ||
          body.maxInputTokens < 0
        ) {
          throw new ApiError(400, "maxInputTokens must be a non-negative safe integer");
        }
        if (
          typeof body.maxOutputTokens !== "number" ||
          !Number.isSafeInteger(body.maxOutputTokens) ||
          body.maxOutputTokens < 0
        ) {
          throw new ApiError(400, "maxOutputTokens must be a non-negative safe integer");
        }

        let entitlement: CloudInferenceEntitlement;
        try {
          entitlement = await setCloudInferenceEntitlement(db, {
            tenantId,
            provider: body.provider,
            model: body.model,
            enabled: body.enabled,
            maxInputTokens: body.maxInputTokens,
            maxOutputTokens: body.maxOutputTokens,
            now: now(),
          });
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) {
            throw new ApiError(400, error.message);
          }
          throw error;
        }
        try {
          await appendCloudComplianceAudit(db, {
            id: crypto.randomUUID(),
            tenantId,
            timestamp: now().toISOString(),
            action: "cloud.inference.entitlement.configure",
            actor: auditActor,
            target: `${entitlement.provider}/${entitlement.model}`,
            resourceType: "cloud-inference-entitlement",
            status: "success",
            requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
            metadata: {
              enabled: entitlement.enabled,
              maxInputTokens: entitlement.maxInputTokens,
              maxOutputTokens: entitlement.maxOutputTokens,
            },
          });
        } catch {
          return json(
            { error: "Inference entitlement changed but audit confirmation failed" },
            503
          );
        }
        return json(entitlement);
      }

      if (request.method === "GET") {
        return json(await getCloudInferenceBudgetStatus(db, tenantId, now()));
      }
      if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
      const body = validateFields(
        await readBody(request),
        ["monthlyTokenLimit"],
        ["monthlyTokenLimit"]
      );
      if (
        typeof body.monthlyTokenLimit !== "number" ||
        !Number.isSafeInteger(body.monthlyTokenLimit) ||
        body.monthlyTokenLimit < 0
      ) {
        throw new ApiError(400, "monthlyTokenLimit must be a non-negative safe integer");
      }
      try {
        await setCloudInferenceMonthlyBudget(db, {
          tenantId,
          monthlyTokenLimit: body.monthlyTokenLimit,
          now: now(),
        });
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          throw new ApiError(400, error.message);
        }
        throw error;
      }
      try {
        await appendCloudComplianceAudit(db, {
          id: crypto.randomUUID(),
          tenantId,
          timestamp: now().toISOString(),
          action: "cloud.inference.budget.configure",
          actor: auditActor,
          target: "monthly-token-budget",
          resourceType: "cloud-inference-budget",
          status: "success",
          requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          metadata: { monthlyTokenLimit: body.monthlyTokenLimit },
        });
      } catch {
        return json({ error: "Inference budget changed but audit confirmation failed" }, 503);
      }
      return json(await getCloudInferenceBudgetStatus(db, tenantId, now()));
    }

    if (collection === "provider-connections") {
      if (!resourceId && request.method === "GET") {
        const url = new URL(request.url);
        const isActiveText = url.searchParams.get("isActive");
        if (isActiveText && isActiveText !== "true" && isActiveText !== "false") {
          throw new ApiError(400, "isActive must be true or false");
        }
        const connections = await getCloudProviderConnections(db, tenantId, {
          provider: url.searchParams.get("provider") ?? undefined,
          authType: url.searchParams.get("authType") ?? undefined,
          isActive: isActiveText ? isActiveText === "true" : undefined,
        });
        return json(connections.map(safeConnection));
      }
      if (!resourceId && request.method === "POST") {
        const input = (await connectionInput(
          await readBody(request),
          tenantId,
          options.credentialEncryptionKey
        )) as CloudProviderConnectionInput;
        const connection = await createCloudProviderConnection(db, {
          ...input,
          updatedAt: now().toISOString(),
        });
        return json(safeConnection(connection), 201);
      }
      if (resourceId && !validId(resourceId)) return json({ error: "Not found" }, 404);
      if (resourceId && request.method === "GET") {
        const connection = await getCloudProviderConnectionById(db, tenantId, resourceId);
        return connection ? json(safeConnection(connection)) : json({ error: "Not found" }, 404);
      }
      if (resourceId && request.method === "PATCH") {
        const patch = (await connectionInput(
          await readBody(request),
          tenantId,
          options.credentialEncryptionKey,
          resourceId,
          true
        )) as Partial<Omit<CloudProviderConnectionInput, "id" | "tenantId">>;
        const connection = await updateCloudProviderConnection(db, tenantId, resourceId, patch);
        return connection ? json(safeConnection(connection)) : json({ error: "Not found" }, 404);
      }
      if (resourceId && request.method === "DELETE") {
        const deleted = await deleteCloudProviderConnection(db, tenantId, resourceId);
        return deleted ? json({ deleted: true }) : json({ error: "Not found" }, 404);
      }
    }

    if (collection === "provider-nodes") {
      if (!resourceId && request.method === "GET")
        return json((await getCloudProviderNodes(db, tenantId)).map(safeNode));
      if (!resourceId && request.method === "POST") {
        const input = (await nodeInput(
          await readBody(request),
          tenantId,
          options.credentialEncryptionKey
        )) as CloudProviderNodeInput;
        const node = await createCloudProviderNode(db, {
          ...input,
          updatedAt: now().toISOString(),
        });
        return json(safeNode(node), 201);
      }
      if (resourceId && !validId(resourceId)) return json({ error: "Not found" }, 404);
      if (resourceId && request.method === "GET") {
        const node = await getCloudProviderNodeById(db, tenantId, resourceId);
        return node ? json(safeNode(node)) : json({ error: "Not found" }, 404);
      }
      if (resourceId && request.method === "PATCH") {
        const patch = (await nodeInput(
          await readBody(request),
          tenantId,
          options.credentialEncryptionKey,
          resourceId,
          true
        )) as Partial<Omit<CloudProviderNodeInput, "id" | "tenantId">>;
        const node = await updateCloudProviderNode(db, tenantId, resourceId, patch);
        return node ? json(safeNode(node)) : json({ error: "Not found" }, 404);
      }
      if (resourceId && request.method === "DELETE") {
        const deleted = await deleteCloudProviderNode(db, tenantId, resourceId);
        return deleted ? json({ deleted: true }) : json({ error: "Not found" }, 404);
      }
    }

    if (collection === "gateway-devices") {
      if (!resourceId && request.method === "GET") {
        return json(await listCloudGatewayDevices(db, tenantId));
      }
      if (!resourceId && request.method === "POST") {
        const body = validateFields(
          await readBody(request),
          ["id", "credentialHash", "capabilities"],
          ["id", "credentialHash", "capabilities"]
        );
        if (typeof body.id !== "string" || !validId(body.id)) {
          throw new ApiError(400, "Invalid device ID");
        }
        if (
          typeof body.credentialHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.credentialHash)
        ) {
          throw new ApiError(400, "Invalid device credential hash");
        }
        if (
          !Array.isArray(body.capabilities) ||
          body.capabilities.length > 64 ||
          body.capabilities.some(
            (capability) =>
              typeof capability !== "string" ||
              capability.trim() !== capability ||
              capability.length < 1 ||
              capability.length > 128 ||
              /[\u0000-\u001f\u007f]/.test(capability)
          )
        ) {
          throw new ApiError(400, "Invalid device capabilities");
        }
        try {
          const device = await registerCloudGatewayDevice(db, {
            tenantId,
            id: body.id,
            credentialHash: body.credentialHash,
            capabilities: body.capabilities,
            now: now().toISOString(),
          });
          return json(
            {
              id: device.id,
              tenantId: device.tenantId,
              capabilities: device.capabilities,
              revokedAt: device.revokedAt,
            },
            201
          );
        } catch (error) {
          if (error instanceof TypeError) throw new ApiError(400, error.message);
          throw error;
        }
      }
      if (resourceId && request.method === "GET") {
        if (!validId(resourceId)) return json({ error: "Not found" }, 404);
        const device = await getCloudGatewayDevice(db, resourceId);
        if (!device || device.tenantId !== tenantId) return json({ error: "Not found" }, 404);
        return json({
          id: device.id,
          capabilities: device.capabilities,
          serviceHealth: device.serviceHealth,
          revokedAt: device.revokedAt,
        });
      }
      if (
        resourceId &&
        segments.length === 4 &&
        segments[3] === "rotate-credential" &&
        request.method === "POST"
      ) {
        const body = validateFields(
          await readBody(request),
          ["credentialHash"],
          ["credentialHash"]
        );
        if (
          typeof body.credentialHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.credentialHash)
        ) {
          throw new ApiError(400, "Invalid device credential hash");
        }
        const deviceIds = await listCloudGatewayDeviceIds(db, tenantId);
        if (!deviceIds.includes(resourceId)) return json({ error: "Not found" }, 404);
        const existingDevice = await getCloudGatewayDevice(db, resourceId);
        if (!existingDevice || existingDevice.tenantId !== tenantId) {
          return json({ error: "Not found" }, 404);
        }
        if (existingDevice.credentialHash === body.credentialHash) {
          throw new ApiError(400, "New device credential must differ from the existing credential");
        }
        const timestamp = now().toISOString();
        const revoked = await revokeCloudGatewayDeviceCredential(
          db,
          tenantId,
          resourceId,
          timestamp
        );
        if (!revoked) return json({ error: "Not found" }, 404);
        await invalidateDeviceSessions(options.sessions, [resourceId], timestamp);
        const rotated = await rotateCloudGatewayDeviceCredential(db, {
          tenantId,
          deviceId: resourceId,
          credentialHash: body.credentialHash,
        });
        if (rotated) {
          await appendCloudComplianceAudit(db, {
            id: crypto.randomUUID(),
            tenantId,
            timestamp: now().toISOString(),
            action: "gateway.device.credential.rotate",
            actor: "cloud-admin",
            target: resourceId,
            resourceType: "gateway-device-credential",
            status: "success",
            requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          });
        }
        return rotated ? json({ rotated: true }) : json({ error: "Not found" }, 404);
      }
      if (resourceId && request.method === "DELETE") {
        if (!validId(resourceId)) return json({ error: "Not found" }, 404);
        const revoked = await revokeCloudGatewayDeviceCredential(
          db,
          tenantId,
          resourceId,
          now().toISOString()
        );
        if (revoked) {
          await invalidateDeviceSessions(options.sessions, [resourceId], now().toISOString());
          await appendCloudComplianceAudit(db, {
            id: crypto.randomUUID(),
            tenantId,
            timestamp: now().toISOString(),
            action: "gateway.device.credential.revoke",
            actor: "cloud-admin",
            target: resourceId,
            resourceType: "gateway-device-credential",
            status: "success",
            requestId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
          });
        }
        return revoked ? json({ revoked: true }) : json({ error: "Not found" }, 404);
      }
    }

    if (collection === "usage" && !resourceId) {
      if (request.method === "GET") {
        const url = new URL(request.url);
        const limitText = url.searchParams.get("limit");
        const limit = limitText === null ? undefined : Number(limitText);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
          throw new ApiError(400, "limit must be an integer between 1 and 500");
        }
        const provider = url.searchParams.get("provider") ?? undefined;
        const from = url.searchParams.get("from") ?? undefined;
        const to = url.searchParams.get("to") ?? undefined;
        const beforeTimestamp = url.searchParams.get("beforeTimestamp");
        const beforeId = url.searchParams.get("beforeId");
        if ((beforeTimestamp === null) !== (beforeId === null)) {
          throw new ApiError(400, "beforeTimestamp and beforeId must be provided together");
        }
        try {
          return json(
            await listCloudUsageRecords(db, tenantId, {
              provider,
              from,
              to,
              limit,
              before:
                beforeTimestamp !== null && beforeId !== null
                  ? { timestamp: beforeTimestamp, id: beforeId }
                  : undefined,
            })
          );
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) {
            throw new ApiError(400, error.message);
          }
          throw error;
        }
      }
      if (request.method === "POST") {
        const body = validateFields(await readBody(request), USAGE_FIELDS, ["id"]);
        if (typeof body.id !== "string" || !validId(body.id)) {
          throw new ApiError(400, "Invalid id");
        }
        try {
          const record = await appendCloudUsageRecord(db, {
            ...body,
            id: body.id,
            tenantId,
          });
          return json(record, 201);
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) {
            throw new ApiError(400, error.message);
          }
          throw error;
        }
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    return conflictOrError(error);
  }
}
