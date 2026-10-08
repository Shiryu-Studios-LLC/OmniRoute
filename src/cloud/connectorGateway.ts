/**
 * Worker-compatible device session and capability authorization primitives.
 *
 * This module intentionally owns no process-local session state. A production
 * adapter should implement GatewayCoordinator with Durable Object storage (or
 * another atomic, durable store) and GatewayDeviceDirectory with the registered
 * device catalog. Requests are authorized against both stores on every call so
 * a stale coordination record cannot bypass device revocation or tenant checks.
 */

export interface GatewayDeviceRecord {
  id: string;
  tenantId: string;
  credentialHash: string;
  capabilities: string[];
  serviceHealth?: { ollama: boolean; comfyui: boolean } | null;
  revokedAt: string | null;
}

export interface GatewaySessionRecord {
  sessionId: string;
  deviceId: string;
  tenantId: string;
  tokenHash: string;
  connectedAt: string;
  lastSeenAt: string;
  leaseExpiresAt: string;
  revokedAt: string | null;
}

export interface GatewayDeviceRequest {
  requestId: string;
  tenantId: string;
  sessionId: string;
  capability: string;
  payload: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "delivered" | "complete";
  result?: string;
}

export interface GatewayDeviceDirectory {
  /** Resolve by device ID only. Tenant ownership comes from this trusted record. */
  getDevice(deviceId: string): Promise<GatewayDeviceRecord | null>;
  revokeDevice(tenantId: string, deviceId: string, revokedAt: string): Promise<boolean>;
  /** Persist the latest capabilities only after the device session is authenticated. */
  updateCapabilities?(
    deviceId: string,
    capabilities: string[],
    lastSeenAt?: string,
    serviceHealth?: { ollama: boolean; comfyui: boolean }
  ): Promise<boolean>;
}

/**
 * Implementations must make putSession, touchSession, and revokeSession atomic
 * per device. A Durable Object keyed by device ID is the expected adapter.
 */
export interface GatewayCoordinator {
  putSession(session: GatewaySessionRecord): Promise<void>;
  getSession(deviceId: string): Promise<GatewaySessionRecord | null>;
  touchSession(
    deviceId: string,
    sessionId: string,
    lastSeenAt: string,
    leaseExpiresAt: string
  ): Promise<boolean>;
  revokeSession(deviceId: string, revokedAt: string): Promise<void>;
  enqueueRequest(deviceId: string, request: GatewayDeviceRequest): Promise<boolean>;
  takeRequests(
    deviceId: string,
    sessionId: string,
    now: string,
    limit?: number
  ): Promise<GatewayDeviceRequest[]>;
  submitRequestResult(
    deviceId: string,
    sessionId: string,
    requestId: string,
    result: string,
    now: string
  ): Promise<boolean>;
  getRequest(
    deviceId: string,
    requestId: string,
    now: string
  ): Promise<GatewayDeviceRequest | null>;
  deleteRequest(deviceId: string, requestId: string): Promise<void>;
}

export interface ConnectorGatewayOptions {
  directory: GatewayDeviceDirectory;
  coordinator: GatewayCoordinator;
  now?: () => number;
  leaseMs?: number;
  createId?: () => string;
  createToken?: () => string;
  createRequestId?: () => string;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface GatewayRequestInput {
  /** Must come from the authenticated caller context, never request JSON. */
  tenantId: string;
  deviceId: string;
  capability: string;
  payload: unknown;
  timeoutMs?: number;
  /** Stable server-generated request identity used by an authorized retry. */
  requestId?: string;
  requestCreatedAt?: string;
  /** Retain a retryable request/result until this bounded idempotency expiry. */
  requestExpiresAt?: string;
}

export interface GatewayDeviceRequestEnvelope {
  requestId: string;
  capability: string;
  payload: unknown;
  expiresAt: string;
}

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

function serializeBounded(value: unknown, label: string): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES
  ) {
    throw new Error(`${label} exceeds the size limit`);
  }
  return serialized;
}

export interface AuthenticatedDeviceSession {
  sessionId: string;
  deviceId: string;
  tenantId: string;
  /** Returned once; store securely on the customer machine. */
  sessionToken: string;
  connectedAt: string;
  leaseExpiresAt: string;
}

export interface AuthorizedCapabilityTarget {
  deviceId: string;
  tenantId: string;
  sessionId: string;
  capability: string;
  leaseExpiresAt: string;
}

export type GatewayAuthorizationResult =
  | { ok: true; target: AuthorizedCapabilityTarget }
  | { ok: false; reason: "tenant_mismatch" | "revoked" | "offline" | "capability_unavailable" };

export type GatewayDeviceHealthResult =
  | {
      ok: true;
      health: "online" | "offline" | "revoked";
      deviceId: string;
      tenantId: string;
      lastSeenAt: string | null;
      leaseExpiresAt: string | null;
    }
  | { ok: false; reason: "tenant_mismatch" | "not_found" };

export type GatewayRequestResult =
  | { ok: true; requestId: string; result: unknown }
  | {
      ok: false;
      reason:
        | "tenant_mismatch"
        | "revoked"
        | "offline"
        | "capability_unavailable"
        | "timeout"
        | "queue_full";
    };

const DEFAULT_LEASE_MS = 45_000;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 5 * 60_000;
const REQUEST_RESULT_POLL_INTERVAL_MS = 250;

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function secureToken(byteCount = 32): string {
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

/** Constant-time comparison for fixed-size, normalized SHA-256 hex digests. */
function digestEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function validLeaseMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_LEASE_MS && value <= MAX_LEASE_MS;
}

export function createConnectorGateway(options: ConnectorGatewayOptions) {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!validLeaseMs(leaseMs))
    throw new Error("Gateway lease must be between 5 seconds and 5 minutes");
  const createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  const createToken = options.createToken ?? (() => secureToken());
  const createRequestId = options.createRequestId ?? (() => globalThis.crypto.randomUUID());
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  async function getActiveDevice(deviceId: string): Promise<GatewayDeviceRecord | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) return null;
    return options.directory.getDevice(deviceId);
  }

  async function authenticateDeviceSession(
    deviceId: string,
    sessionToken: string
  ): Promise<{ device: GatewayDeviceRecord; session: GatewaySessionRecord } | null> {
    const device = await getActiveDevice(deviceId);
    if (!device || device.revokedAt || !sessionToken) return null;
    const session = await options.coordinator.getSession(deviceId);
    if (
      !session ||
      session.revokedAt ||
      session.tenantId !== device.tenantId ||
      Date.parse(session.leaseExpiresAt) <= now() ||
      !digestEqual(session.tokenHash, await sha256Hex(sessionToken))
    )
      return null;
    return { device, session };
  }

  return {
    /** Validates a session without touching its lease or changing any device state. */
    async authenticateSession(
      deviceId: string,
      sessionToken: string
    ): Promise<{ tenantId: string; sessionId: string } | null> {
      const authenticated = await authenticateDeviceSession(deviceId, sessionToken);
      return authenticated
        ? { tenantId: authenticated.device.tenantId, sessionId: authenticated.session.sessionId }
        : null;
    },

    /**
     * Establishes a new outbound device session. Tenant identity is read from
     * the registration directory; callers cannot choose or override it.
     */
    async connect(
      deviceId: string,
      deviceCredential: string
    ): Promise<AuthenticatedDeviceSession | null> {
      const device = await getActiveDevice(deviceId);
      if (!device || device.revokedAt || !deviceCredential) return null;
      const suppliedHash = await sha256Hex(deviceCredential);
      if (!digestEqual(device.credentialHash, suppliedHash)) return null;

      const timestamp = now();
      const connectedAt = new Date(timestamp).toISOString();
      const leaseExpiresAt = new Date(timestamp + leaseMs).toISOString();
      const sessionToken = createToken();
      const session: GatewaySessionRecord = {
        sessionId: createId(),
        deviceId: device.id,
        tenantId: device.tenantId,
        tokenHash: await sha256Hex(sessionToken),
        connectedAt,
        lastSeenAt: connectedAt,
        leaseExpiresAt,
        revokedAt: null,
      };
      await options.coordinator.putSession(session);
      return {
        sessionId: session.sessionId,
        deviceId: device.id,
        tenantId: device.tenantId,
        sessionToken,
        connectedAt,
        leaseExpiresAt,
      };
    },

    /** Extends a device lease only when the current session token is valid. */
    async heartbeat(
      deviceId: string,
      sessionToken: string,
      capabilities?: string[],
      serviceHealth?: { ollama: boolean; comfyui: boolean }
    ): Promise<boolean> {
      const device = await getActiveDevice(deviceId);
      if (!device || device.revokedAt || !sessionToken) return false;
      if (
        capabilities !== undefined &&
        (!Array.isArray(capabilities) ||
          capabilities.length > 64 ||
          capabilities.some(
            (capability) =>
              typeof capability !== "string" ||
              capability.trim() !== capability ||
              capability.length < 1 ||
              capability.length > 128 ||
              /[\u0000-\u001f\u007f]/.test(capability)
          ))
      ) {
        return false;
      }
      if (
        serviceHealth !== undefined &&
        (!serviceHealth ||
          typeof serviceHealth.ollama !== "boolean" ||
          typeof serviceHealth.comfyui !== "boolean" ||
          Object.keys(serviceHealth).some((key) => key !== "ollama" && key !== "comfyui"))
      )
        return false;
      const session = await options.coordinator.getSession(deviceId);
      if (!session || session.revokedAt || session.tenantId !== device.tenantId) return false;
      if (Date.parse(session.leaseExpiresAt) <= now()) return false;
      const suppliedHash = await sha256Hex(sessionToken);
      if (!digestEqual(session.tokenHash, suppliedHash)) return false;
      const timestamp = now();
      const touched = await options.coordinator.touchSession(
        deviceId,
        session.sessionId,
        new Date(timestamp).toISOString(),
        new Date(timestamp + leaseMs).toISOString()
      );
      if (!touched) return false;
      if (capabilities !== undefined && options.directory.updateCapabilities) {
        return options.directory.updateCapabilities(
          deviceId,
          [...new Set(capabilities)],
          new Date(timestamp).toISOString(),
          serviceHealth
        );
      }
      if (serviceHealth !== undefined && options.directory.updateCapabilities) {
        return options.directory.updateCapabilities(
          deviceId,
          device.capabilities,
          new Date(timestamp).toISOString(),
          serviceHealth
        );
      }
      return true;
    },

    /** Returns tenant-authorized health without exposing another tenant's device. */
    async getDeviceHealth(input: {
      /** Must come from the authenticated caller context, never request JSON. */
      tenantId: string;
      deviceId: string;
    }): Promise<GatewayDeviceHealthResult> {
      const device = await getActiveDevice(input.deviceId);
      if (!device) return { ok: false, reason: "not_found" };
      if (device.tenantId !== input.tenantId) return { ok: false, reason: "tenant_mismatch" };
      const session = await options.coordinator.getSession(device.id);
      const leaseExpiresAt = session?.leaseExpiresAt ?? null;
      const isOnline =
        !device.revokedAt &&
        Boolean(session) &&
        !session?.revokedAt &&
        session?.tenantId === device.tenantId &&
        Date.parse(session.leaseExpiresAt) > now();
      return {
        ok: true,
        health: device.revokedAt ? "revoked" : isOnline ? "online" : "offline",
        deviceId: device.id,
        tenantId: device.tenantId,
        lastSeenAt: session?.lastSeenAt ?? null,
        leaseExpiresAt,
      };
    },

    /**
     * Authorizes a cloud-to-device capability call. This only returns an
     * authorized target; it does not forward or stream a request.
     */
    async authorizeCapability(input: {
      /** Must come from the authenticated caller context, never request JSON. */
      tenantId: string;
      deviceId: string;
      capability: string;
    }): Promise<GatewayAuthorizationResult> {
      const device = await getActiveDevice(input.deviceId);
      if (!device) return { ok: false, reason: "offline" };
      if (device.revokedAt) return { ok: false, reason: "revoked" };
      if (device.tenantId !== input.tenantId) return { ok: false, reason: "tenant_mismatch" };
      if (!input.capability || !device.capabilities.includes(input.capability)) {
        return { ok: false, reason: "capability_unavailable" };
      }
      const session = await options.coordinator.getSession(device.id);
      if (!session || session.revokedAt || session.tenantId !== device.tenantId) {
        return { ok: false, reason: "offline" };
      }
      if (Date.parse(session.leaseExpiresAt) <= now()) return { ok: false, reason: "offline" };
      return {
        ok: true,
        target: {
          deviceId: device.id,
          tenantId: device.tenantId,
          sessionId: session.sessionId,
          capability: input.capability,
          leaseExpiresAt: session.leaseExpiresAt,
        },
      };
    },

    /** Queue a bounded JSON request for an online device and wait for its result. */
    async requestCapability(input: GatewayRequestInput): Promise<GatewayRequestResult> {
      const timeoutMs = input.timeoutMs ?? 15_000;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 100 ||
        timeoutMs > MAX_REQUEST_TIMEOUT_MS
      ) {
        throw new Error("Gateway request timeout must be between 100 ms and 30 seconds");
      }
      const payload = serializeBounded(input.payload, "Gateway request");
      const requestId = input.requestId ?? createRequestId();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
        throw new Error("Gateway request identity is invalid");
      }
      const authorization = await this.authorizeCapability(input);
      if (!authorization.ok) return authorization;
      const target = authorization.target;
      const timestamp = now();
      const deadline = timestamp + timeoutMs;
      const createdAt = input.requestCreatedAt ?? new Date(timestamp).toISOString();
      const expiresAt = input.requestExpiresAt ?? new Date(timestamp + timeoutMs).toISOString();
      if (
        !Number.isFinite(Date.parse(createdAt)) ||
        Date.parse(createdAt) > timestamp ||
        !Number.isFinite(Date.parse(expiresAt)) ||
        Date.parse(expiresAt) <= timestamp ||
        Date.parse(expiresAt) - timestamp > 15 * 60_000
      ) {
        throw new Error("Gateway request expiry must be within 15 minutes");
      }
      const request: GatewayDeviceRequest = {
        requestId,
        tenantId: input.tenantId,
        sessionId: target.sessionId,
        capability: target.capability,
        payload,
        createdAt,
        expiresAt,
        status: "pending",
      };
      let storedRequest: GatewayDeviceRequest | null = null;
      if (input.requestId) {
        storedRequest = await options.coordinator.getRequest(
          input.deviceId,
          request.requestId,
          new Date(timestamp).toISOString()
        );
        if (
          storedRequest &&
          (storedRequest.tenantId !== request.tenantId ||
            storedRequest.sessionId !== request.sessionId ||
            storedRequest.capability !== request.capability ||
            storedRequest.payload !== request.payload)
        ) {
          return { ok: false, reason: "queue_full" };
        }
        if (storedRequest?.status === "complete" && storedRequest.result !== undefined) {
          if (now() >= deadline) return { ok: false, reason: "timeout" };
          const active = await this.authorizeCapability(input);
          if (!active.ok || active.target.sessionId !== target.sessionId) {
            return active.ok ? { ok: false, reason: "offline" } : active;
          }
          if (now() >= deadline) return { ok: false, reason: "timeout" };
          try {
            return {
              ok: true,
              requestId: storedRequest.requestId,
              result: JSON.parse(storedRequest.result) as unknown,
            };
          } catch {
            return { ok: false, reason: "offline" };
          }
        }
      }
      if (now() >= deadline) return { ok: false, reason: "timeout" };
      if (!storedRequest && !(await options.coordinator.enqueueRequest(input.deviceId, request))) {
        return { ok: false, reason: "queue_full" };
      }

      while (now() < deadline) {
        const active = await this.authorizeCapability(input);
        if (!active.ok || active.target.sessionId !== target.sessionId) {
          if (!input.requestId) {
            await options.coordinator.deleteRequest(input.deviceId, request.requestId);
          }
          return active.ok ? { ok: false, reason: "offline" } : active;
        }
        const stored = await options.coordinator.getRequest(
          input.deviceId,
          request.requestId,
          new Date(now()).toISOString()
        );
        if (now() >= deadline) {
          if (!input.requestId) {
            await options.coordinator.deleteRequest(input.deviceId, request.requestId);
          }
          return { ok: false, reason: "timeout" };
        }
        if (stored?.status === "complete" && stored.result !== undefined) {
          const completedFor = await this.authorizeCapability(input);
          if (!completedFor.ok || completedFor.target.sessionId !== target.sessionId) {
            if (!input.requestId) {
              await options.coordinator.deleteRequest(input.deviceId, request.requestId);
            }
            return completedFor.ok ? { ok: false, reason: "offline" } : completedFor;
          }
          if (now() >= deadline) {
            if (!input.requestId) {
              await options.coordinator.deleteRequest(input.deviceId, request.requestId);
            }
            return { ok: false, reason: "timeout" };
          }
          if (!input.requestId) {
            await options.coordinator.deleteRequest(input.deviceId, request.requestId);
            if (now() >= deadline) return { ok: false, reason: "timeout" };
          }
          try {
            return {
              ok: true,
              requestId: request.requestId,
              result: JSON.parse(stored.result) as unknown,
            };
          } catch {
            return { ok: false, reason: "offline" };
          }
        }
        await wait(Math.min(REQUEST_RESULT_POLL_INTERVAL_MS, Math.max(1, deadline - now())));
      }
      if (!input.requestId) {
        await options.coordinator.deleteRequest(input.deviceId, request.requestId);
      }
      return { ok: false, reason: "timeout" };
    },

    /** Device-side long-poll primitive; only the active session can receive work. */
    async pollDeviceRequests(input: {
      deviceId: string;
      sessionToken: string;
      limit?: number;
    }): Promise<GatewayDeviceRequestEnvelope[] | null> {
      const authenticated = await authenticateDeviceSession(input.deviceId, input.sessionToken);
      if (!authenticated) return null;
      const requests = await options.coordinator.takeRequests(
        input.deviceId,
        authenticated.session.sessionId,
        new Date(now()).toISOString(),
        input.limit
      );
      return requests.map((request) => ({
        requestId: request.requestId,
        capability: request.capability,
        payload: JSON.parse(request.payload) as unknown,
        expiresAt: request.expiresAt,
      }));
    },

    /** Device-side response primitive; results are tied to the delivering session. */
    async submitDeviceResult(input: {
      deviceId: string;
      sessionToken: string;
      requestId: string;
      result: unknown;
    }): Promise<boolean> {
      const authenticated = await authenticateDeviceSession(input.deviceId, input.sessionToken);
      if (!authenticated || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) return false;
      const result = serializeBounded(input.result, "Gateway result");
      return options.coordinator.submitRequestResult(
        input.deviceId,
        authenticated.session.sessionId,
        input.requestId,
        result,
        new Date(now()).toISOString()
      );
    },

    /** Revokes directory identity first, then invalidates the active session. */
    async revokeDevice(tenantId: string, deviceId: string): Promise<boolean> {
      const revokedAt = new Date(now()).toISOString();
      const revoked = await options.directory.revokeDevice(tenantId, deviceId, revokedAt);
      if (revoked) await options.coordinator.revokeSession(deviceId, revokedAt);
      return revoked;
    },
  };
}
