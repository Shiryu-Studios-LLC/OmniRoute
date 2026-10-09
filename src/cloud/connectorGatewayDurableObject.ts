import type {
  GatewayCoordinator,
  GatewayCapabilityStreamEnvelope,
  GatewayDeviceRequest,
  GatewaySessionRecord,
} from "./connectorGateway.ts";

/** Minimal subset of Durable Object storage used by the adapter. */
export interface GatewayDurableStorageTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface GatewayDurableStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  transaction<T>(
    callback: (transaction: GatewayDurableStorageTransaction) => Promise<T>
  ): Promise<T>;
}

export interface GatewayDurableObjectState {
  id: { name?: string };
  storage: GatewayDurableStorage;
}

export interface GatewayDurableObjectNamespace<Stub> {
  idFromName(name: string): unknown;
  get(id: unknown): Stub;
}

export interface GatewayCoordinatorStub {
  checkReadiness(): Promise<void>;
  putSession(deviceId: string, session: GatewaySessionRecord): Promise<void>;
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
  submitStreamEvent(
    deviceId: string,
    sessionId: string,
    requestId: string,
    sequence: number,
    event: string,
    now: string
  ): Promise<boolean>;
  peekStreamEvent(
    deviceId: string,
    sessionId: string,
    requestId: string,
    sequence: number,
    now: string
  ): Promise<GatewayCapabilityStreamEnvelope | null>;
  acknowledgeStreamEvent(
    deviceId: string,
    sessionId: string,
    requestId: string,
    sequence: number,
    now: string
  ): Promise<boolean>;
  cancelStream(
    deviceId: string,
    sessionId: string,
    requestId: string,
    now: string
  ): Promise<boolean>;
}

const IDENTITY_KEY = "gateway:device-id";
const SESSION_KEY = "gateway:session";
const REQUESTS_KEY = "gateway:requests";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS = 16;
// Keep the single serialized queue value below the SQLite-backed Durable
// Object value limit, including JSON keys and per-row metadata.
const MAX_STORED_REQUESTS = 64;
const MAX_REQUEST_QUEUE_BYTES = 1_500_000;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_STREAM_EVENT_BYTES = 8 * 1024;
const MAX_STREAM_EVENTS = 256;
const MAX_STREAM_OUTPUT_BYTES = 128 * 1024;

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSessionRecord(value: unknown): value is GatewaySessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Partial<GatewaySessionRecord>;
  return (
    typeof session.sessionId === "string" &&
    SESSION_ID_PATTERN.test(session.sessionId) &&
    typeof session.deviceId === "string" &&
    DEVICE_ID_PATTERN.test(session.deviceId) &&
    typeof session.tenantId === "string" &&
    session.tenantId.length > 0 &&
    typeof session.tokenHash === "string" &&
    HASH_PATTERN.test(session.tokenHash) &&
    isTimestamp(session.connectedAt) &&
    isTimestamp(session.lastSeenAt) &&
    isTimestamp(session.leaseExpiresAt) &&
    (session.revokedAt === null || isTimestamp(session.revokedAt))
  );
}

function isRequestRecord(value: unknown): value is GatewayDeviceRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<GatewayDeviceRequest>;
  const payloadBytes =
    typeof request.payload === "string"
      ? new TextEncoder().encode(request.payload).byteLength
      : Infinity;
  const resultBytes =
    typeof request.result === "string" ? new TextEncoder().encode(request.result).byteLength : 0;
  return (
    typeof request.requestId === "string" &&
    SESSION_ID_PATTERN.test(request.requestId) &&
    typeof request.tenantId === "string" &&
    request.tenantId.length > 0 &&
    typeof request.sessionId === "string" &&
    SESSION_ID_PATTERN.test(request.sessionId) &&
    typeof request.capability === "string" &&
    request.capability.length > 0 &&
    request.capability.length <= 128 &&
    payloadBytes <= MAX_REQUEST_BYTES &&
    Number.isFinite(Date.parse(request.createdAt ?? "")) &&
    Number.isFinite(Date.parse(request.expiresAt ?? "")) &&
    Date.parse(request.expiresAt ?? "") > Date.parse(request.createdAt ?? "") &&
    (request.status === "pending" ||
      request.status === "delivered" ||
      request.status === "complete") &&
    (request.result === undefined || resultBytes <= MAX_REQUEST_BYTES) &&
    (request.stream === undefined || request.stream === true) &&
    (request.streamNextSequence === undefined ||
      (Number.isSafeInteger(request.streamNextSequence) && request.streamNextSequence >= 0)) &&
    (request.streamAcknowledgedSequence === undefined ||
      (Number.isSafeInteger(request.streamAcknowledgedSequence) &&
        request.streamAcknowledgedSequence >= -1)) &&
    (request.streamPendingEvent === undefined ||
      new TextEncoder().encode(request.streamPendingEvent).byteLength <= MAX_STREAM_EVENT_BYTES) &&
    (request.streamCancelled === undefined || request.streamCancelled === true) &&
    (request.streamTerminal === undefined || request.streamTerminal === true) &&
    (request.streamEventCount === undefined ||
      (Number.isSafeInteger(request.streamEventCount) &&
        request.streamEventCount >= 0 &&
        request.streamEventCount <= MAX_STREAM_EVENTS)) &&
    (request.streamTotalEventBytes === undefined ||
      (Number.isSafeInteger(request.streamTotalEventBytes) &&
        request.streamTotalEventBytes >= 0 &&
        request.streamTotalEventBytes <= MAX_STREAM_OUTPUT_BYTES)) &&
    (request.streamUsageSequence === undefined ||
      (Number.isSafeInteger(request.streamUsageSequence) && request.streamUsageSequence >= 0)) &&
    (request.stream !== true ||
      (request.streamNextSequence !== undefined &&
        request.streamAcknowledgedSequence !== undefined &&
        request.streamEventCount !== undefined &&
        request.streamTotalEventBytes !== undefined))
  );
}

function isTerminalStreamEvent(event: unknown): boolean {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const type = (event as { type?: unknown }).type;
  return type === "done" || type === "error";
}

function requestQueueFits(requests: GatewayDeviceRequest[]): boolean {
  if (requests.length > MAX_STORED_REQUESTS) return false;
  return new TextEncoder().encode(JSON.stringify(requests)).byteLength <= MAX_REQUEST_QUEUE_BYTES;
}

function assertDeviceId(deviceId: string): void {
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("Invalid gateway device identity");
}

/**
 * One instance is addressed by one device name. The first successful operation
 * binds that opaque Durable Object ID to the supplied device ID. Every later
 * transaction verifies the binding before reading or mutating session state.
 */
export class GatewaySessionDurableObject implements GatewayCoordinatorStub {
  constructor(private readonly state: GatewayDurableObjectState) {}

  async checkReadiness(): Promise<void> {
    // A read-only storage operation confirms that the binding can reach this
    // Durable Object without creating or changing gateway session state.
    await this.state.storage.get(IDENTITY_KEY);
  }

  async putSession(deviceId: string, session: GatewaySessionRecord): Promise<void> {
    assertDeviceId(deviceId);
    if (!isSessionRecord(session) || session.deviceId !== deviceId) {
      throw new Error("Gateway session identity does not match its Durable Object");
    }
    await this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const current = await transaction.get<unknown>(SESSION_KEY);
      if (!isSessionRecord(current) || current.sessionId !== session.sessionId) {
        // Requests are bound to the session that authorized them. Replacing a
        // session makes its pending work undeliverable, so release those
        // queue slots when the device reconnects.
        await transaction.delete(REQUESTS_KEY);
      }
      await transaction.put(SESSION_KEY, session);
    });
  }

  async getSession(deviceId: string): Promise<GatewaySessionRecord | null> {
    assertDeviceId(deviceId);
    return this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const value = await transaction.get<unknown>(SESSION_KEY);
      if (value === undefined) return null;
      if (!isSessionRecord(value) || value.deviceId !== deviceId) {
        throw new Error("Stored gateway session identity is invalid");
      }
      return value;
    });
  }

  async touchSession(
    deviceId: string,
    sessionId: string,
    lastSeenAt: string,
    leaseExpiresAt: string
  ): Promise<boolean> {
    assertDeviceId(deviceId);
    if (
      !SESSION_ID_PATTERN.test(sessionId) ||
      !isTimestamp(lastSeenAt) ||
      !isTimestamp(leaseExpiresAt)
    ) {
      return false;
    }
    return this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const value = await transaction.get<unknown>(SESSION_KEY);
      if (!isSessionRecord(value) || value.deviceId !== deviceId || value.sessionId !== sessionId) {
        return false;
      }
      if (value.revokedAt !== null) return false;
      await transaction.put(SESSION_KEY, { ...value, lastSeenAt, leaseExpiresAt });
      return true;
    });
  }

  async revokeSession(deviceId: string, revokedAt: string): Promise<void> {
    assertDeviceId(deviceId);
    if (!isTimestamp(revokedAt)) throw new Error("Invalid gateway revocation timestamp");
    await this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const value = await transaction.get<unknown>(SESSION_KEY);
      if (isSessionRecord(value) && value.deviceId === deviceId && value.revokedAt === null) {
        await transaction.put(SESSION_KEY, { ...value, revokedAt });
      }
      // Revoked session requests and their retained idempotency results must
      // not occupy queue capacity or be observable after revocation.
      await transaction.delete(REQUESTS_KEY);
    });
  }

  async enqueueRequest(deviceId: string, request: GatewayDeviceRequest): Promise<boolean> {
    assertDeviceId(deviceId);
    if (!isRequestRecord(request) || request.status !== "pending") return false;
    return this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const sessionValue = await transaction.get<unknown>(SESSION_KEY);
      if (
        !isSessionRecord(sessionValue) ||
        sessionValue.deviceId !== deviceId ||
        sessionValue.sessionId !== request.sessionId ||
        sessionValue.tenantId !== request.tenantId ||
        sessionValue.revokedAt !== null ||
        Date.parse(sessionValue.leaseExpiresAt) <= Date.parse(request.createdAt)
      ) {
        return false;
      }
      const rows = await this.readRequests(transaction);
      const now = Date.parse(request.createdAt);
      const active = rows.filter((row) => Date.parse(row.expiresAt) > now);
      const pending = active.filter((row) => row.status !== "complete");
      if (
        pending.length >= MAX_PENDING_REQUESTS ||
        active.some((row) => row.requestId === request.requestId) ||
        !requestQueueFits([...active, request])
      ) {
        return false;
      }
      await transaction.put(REQUESTS_KEY, [...active, request]);
      return true;
    });
  }

  async takeRequests(
    deviceId: string,
    sessionId: string,
    now: string,
    limit = MAX_PENDING_REQUESTS
  ): Promise<GatewayDeviceRequest[]> {
    assertDeviceId(deviceId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING_REQUESTS) return [];
    return this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const sessionValue = await transaction.get<unknown>(SESSION_KEY);
      if (
        !isSessionRecord(sessionValue) ||
        sessionValue.deviceId !== deviceId ||
        sessionValue.sessionId !== sessionId ||
        sessionValue.revokedAt !== null ||
        Date.parse(sessionValue.leaseExpiresAt) <= Date.parse(now)
      )
        return [];
      const rows = await this.readRequests(transaction);
      const valid = rows.filter(
        (row) =>
          isRequestRecord(row) &&
          row.sessionId === sessionId &&
          Date.parse(row.expiresAt) > Date.parse(now)
      );
      const delivered: GatewayDeviceRequest[] = [];
      const updated = valid.map((row) => {
        if (row.status !== "pending") return row;
        if (delivered.length >= limit) return row;
        const request = { ...row, status: "delivered" as const };
        delivered.push(request);
        return request;
      });
      await transaction.put(REQUESTS_KEY, updated);
      return delivered;
    });
  }

  async submitRequestResult(
    deviceId: string,
    sessionId: string,
    requestId: string,
    result: string,
    now: string
  ): Promise<boolean> {
    assertDeviceId(deviceId);
    if (
      !SESSION_ID_PATTERN.test(requestId) ||
      new TextEncoder().encode(result).byteLength > MAX_REQUEST_BYTES
    ) {
      return false;
    }
    return this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const sessionValue = await transaction.get<unknown>(SESSION_KEY);
      if (
        !isSessionRecord(sessionValue) ||
        sessionValue.deviceId !== deviceId ||
        sessionValue.sessionId !== sessionId ||
        sessionValue.revokedAt !== null ||
        Date.parse(sessionValue.leaseExpiresAt) <= Date.parse(now)
      )
        return false;
      const rows = await this.readRequests(transaction);
      const index = rows.findIndex(
        (row) => row.requestId === requestId && row.sessionId === sessionId
      );
      if (
        index < 0 ||
        rows[index].status !== "delivered" ||
        Date.parse(rows[index].expiresAt) <= Date.parse(now)
      ) {
        return false;
      }
      const updated = [...rows];
      updated[index] = { ...updated[index], status: "complete", result };
      if (!requestQueueFits(updated)) return false;
      await transaction.put(REQUESTS_KEY, updated);
      return true;
    });
  }

  async submitStreamEvent(
    deviceId: string,
    sessionId: string,
    requestId: string,
    sequence: number,
    event: string,
    now: string
  ): Promise<boolean> {
    assertDeviceId(deviceId);
    if (
      !SESSION_ID_PATTERN.test(requestId) ||
      !SESSION_ID_PATTERN.test(sessionId) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence > 100_000 ||
      new TextEncoder().encode(event).byteLength > MAX_STREAM_EVENT_BYTES
    )
      return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event) as unknown;
    } catch {
      return false;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const session = await transaction.get<unknown>(SESSION_KEY);
      if (
        !isSessionRecord(session) ||
        session.deviceId !== deviceId ||
        session.sessionId !== sessionId ||
        session.revokedAt !== null ||
        Date.parse(session.leaseExpiresAt) <= Date.parse(now)
      )
        return false;
      const rows = await this.readRequests(transaction);
      const index = rows.findIndex(
        (row) => row.requestId === requestId && row.sessionId === sessionId
      );
      if (index < 0) return false;
      const request = rows[index]!;
      if (
        !request.stream ||
        request.streamCancelled ||
        Date.parse(request.expiresAt) <= Date.parse(now)
      )
        return false;
      const acknowledged = request.streamAcknowledgedSequence ?? -1;
      if (sequence <= acknowledged) return true;
      if (
        request.status !== "delivered" ||
        request.streamTerminal ||
        sequence !== request.streamNextSequence ||
        request.streamPendingEvent !== undefined
      )
        return false;
      const eventBytes = new TextEncoder().encode(event).byteLength;
      const eventCount = request.streamEventCount ?? 0;
      const totalBytes = request.streamTotalEventBytes ?? 0;
      const isUsage = (parsed as { type?: unknown }).type === "usage";
      if (
        eventCount >= MAX_STREAM_EVENTS ||
        totalBytes + eventBytes > MAX_STREAM_OUTPUT_BYTES ||
        (isUsage && request.streamUsageSequence !== undefined)
      ) {
        const updated = [...rows];
        updated[index] = {
          ...request,
          streamCancelled: true,
          streamPendingEvent: undefined,
        };
        await transaction.put(REQUESTS_KEY, updated);
        return false;
      }
      const updated = [...rows];
      updated[index] = {
        ...request,
        streamPendingEvent: event,
        streamEventCount: eventCount + 1,
        streamTotalEventBytes: totalBytes + eventBytes,
        ...(isUsage ? { streamUsageSequence: sequence } : {}),
        ...(isTerminalStreamEvent(parsed) ? { streamTerminal: true as const } : {}),
      };
      if (!requestQueueFits(updated)) return false;
      await transaction.put(REQUESTS_KEY, updated);
      return true;
    });
  }

  async peekStreamEvent(
    deviceId: string,
    sessionId: string,
    requestId: string,
    sequence: number,
    now: string
  ): Promise<GatewayCapabilityStreamEnvelope | null> {
    assertDeviceId(deviceId);
    if (
      !SESSION_ID_PATTERN.test(requestId) ||
      !SESSION_ID_PATTERN.test(sessionId) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      return null;
    return this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const session = await transaction.get<unknown>(SESSION_KEY);
      if (
        !isSessionRecord(session) ||
        session.deviceId !== deviceId ||
        session.sessionId !== sessionId ||
        session.revokedAt !== null ||
        Date.parse(session.leaseExpiresAt) <= Date.parse(now)
      )
        return null;
      const rows = await this.readRequests(transaction);
      const index = rows.findIndex(
        (row) => row.requestId === requestId && row.sessionId === sessionId
      );
      if (index < 0) return null;
      const request = rows[index]!;
      if (
        !request.stream ||
        request.streamCancelled ||
        Date.parse(request.expiresAt) <= Date.parse(now) ||
        request.streamNextSequence !== sequence ||
        !request.streamPendingEvent
      )
        return null;
      let event: unknown;
      try {
        event = JSON.parse(request.streamPendingEvent) as unknown;
      } catch {
        return null;
      }
      if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
      return { sequence, ...(event as object) } as GatewayCapabilityStreamEnvelope;
    });
  }

  async acknowledgeStreamEvent(
    deviceId: string,
    sessionId: string,
    requestId: string,
    sequence: number,
    now: string
  ): Promise<boolean> {
    assertDeviceId(deviceId);
    if (
      !SESSION_ID_PATTERN.test(requestId) ||
      !SESSION_ID_PATTERN.test(sessionId) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      return false;
    return this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const session = await transaction.get<unknown>(SESSION_KEY);
      if (
        !isSessionRecord(session) ||
        session.deviceId !== deviceId ||
        session.sessionId !== sessionId ||
        session.revokedAt !== null ||
        Date.parse(session.leaseExpiresAt) <= Date.parse(now)
      )
        return false;
      const rows = await this.readRequests(transaction);
      const index = rows.findIndex(
        (row) => row.requestId === requestId && row.sessionId === sessionId
      );
      if (index < 0) return false;
      const request = rows[index]!;
      if (
        !request.stream ||
        request.streamCancelled ||
        Date.parse(request.expiresAt) <= Date.parse(now)
      )
        return false;
      if ((request.streamAcknowledgedSequence ?? -1) >= sequence) return true;
      if (request.streamNextSequence !== sequence || !request.streamPendingEvent) return false;
      let event: unknown;
      try {
        event = JSON.parse(request.streamPendingEvent) as unknown;
      } catch {
        return false;
      }
      const updated = [...rows];
      updated[index] = {
        ...request,
        ...(isTerminalStreamEvent(event) ? { status: "complete" as const } : {}),
        streamPendingEvent: undefined,
        streamAcknowledgedSequence: sequence,
        streamNextSequence: sequence + 1,
      };
      await transaction.put(REQUESTS_KEY, updated);
      return true;
    });
  }

  async cancelStream(
    deviceId: string,
    sessionId: string,
    requestId: string,
    now: string
  ): Promise<boolean> {
    assertDeviceId(deviceId);
    if (!SESSION_ID_PATTERN.test(requestId) || !SESSION_ID_PATTERN.test(sessionId)) return false;
    return this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const session = await transaction.get<unknown>(SESSION_KEY);
      if (
        !isSessionRecord(session) ||
        session.deviceId !== deviceId ||
        session.sessionId !== sessionId ||
        session.revokedAt !== null ||
        Date.parse(session.leaseExpiresAt) <= Date.parse(now)
      )
        return false;
      const rows = await this.readRequests(transaction);
      const index = rows.findIndex(
        (row) =>
          row.requestId === requestId &&
          row.sessionId === sessionId &&
          row.stream === true &&
          Date.parse(row.expiresAt) > Date.parse(now)
      );
      if (index < 0) return false;
      const updated = [...rows];
      updated[index] = { ...updated[index]!, streamCancelled: true, streamPendingEvent: undefined };
      await transaction.put(REQUESTS_KEY, updated);
      return true;
    });
  }

  async getRequest(
    deviceId: string,
    requestId: string,
    now: string
  ): Promise<GatewayDeviceRequest | null> {
    assertDeviceId(deviceId);
    return this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const rows = await this.readRequests(transaction);
      const valid = rows.filter((row) => Date.parse(row.expiresAt) > Date.parse(now));
      await transaction.put(REQUESTS_KEY, valid);
      return valid.find((row) => row.requestId === requestId) ?? null;
    });
  }

  async deleteRequest(deviceId: string, requestId: string): Promise<void> {
    assertDeviceId(deviceId);
    await this.state.storage.transaction(async (transaction) => {
      await this.assertBound(transaction, deviceId);
      const rows = await this.readRequests(transaction);
      await transaction.put(
        REQUESTS_KEY,
        rows.filter((row) => row.requestId !== requestId)
      );
    });
  }

  private async readRequests(
    transaction: GatewayDurableStorageTransaction
  ): Promise<GatewayDeviceRequest[]> {
    const value = await transaction.get<unknown>(REQUESTS_KEY);
    if (!Array.isArray(value)) return [];
    const valid = value.filter(isRequestRecord);
    if (requestQueueFits(valid)) return valid;

    // Compact state written by earlier versions that did not bound completed
    // idempotency records. Keep in-flight work first, then the newest completed
    // results that fit the current storage budget.
    const inFlight = valid
      .filter((request) => request.status !== "complete")
      .slice(0, MAX_PENDING_REQUESTS);
    const completed = valid
      .filter((request) => request.status === "complete")
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const retained = [...inFlight];
    for (const request of completed) {
      if (requestQueueFits([...retained, request])) retained.push(request);
    }
    const retainedSet = new Set(retained);
    return valid.filter((request) => retainedSet.has(request));
  }

  private async assertBound(
    transaction: GatewayDurableStorageTransaction,
    deviceId: string
  ): Promise<void> {
    if (this.state.id.name !== deviceId) {
      throw new Error("Gateway device identity does not match its Durable Object name");
    }
    const identity = await transaction.get<string>(IDENTITY_KEY);
    if (identity !== undefined && identity !== deviceId) {
      throw new Error("Durable Object is already bound to another gateway device");
    }
    if (identity === undefined) await transaction.put(IDENTITY_KEY, deviceId);
  }
}

/** Routes each coordinator call to the deterministic per-device object. */
export class DurableObjectGatewayCoordinator implements GatewayCoordinator {
  constructor(private readonly namespace: GatewayDurableObjectNamespace<GatewayCoordinatorStub>) {}

  putSession(session: GatewaySessionRecord): Promise<void> {
    return this.forDevice(session.deviceId).putSession(session.deviceId, session);
  }

  getSession(deviceId: string): Promise<GatewaySessionRecord | null> {
    return this.forDevice(deviceId).getSession(deviceId);
  }

  touchSession(
    deviceId: string,
    sessionId: string,
    lastSeenAt: string,
    leaseExpiresAt: string
  ): Promise<boolean> {
    return this.forDevice(deviceId).touchSession(deviceId, sessionId, lastSeenAt, leaseExpiresAt);
  }

  revokeSession(deviceId: string, revokedAt: string): Promise<void> {
    return this.forDevice(deviceId).revokeSession(deviceId, revokedAt);
  }

  enqueueRequest(deviceId: string, request: GatewayDeviceRequest): Promise<boolean> {
    return this.forDevice(deviceId).enqueueRequest(deviceId, request);
  }

  takeRequests(deviceId: string, sessionId: string, now: string): Promise<GatewayDeviceRequest[]> {
    return this.forDevice(deviceId).takeRequests(deviceId, sessionId, now);
  }

  submitRequestResult(
    deviceId: string,
    sessionId: string,
    requestId: string,
    result: string,
    now: string
  ): Promise<boolean> {
    return this.forDevice(deviceId).submitRequestResult(
      deviceId,
      sessionId,
      requestId,
      result,
      now
    );
  }

  getRequest(
    deviceId: string,
    requestId: string,
    now: string
  ): Promise<GatewayDeviceRequest | null> {
    return this.forDevice(deviceId).getRequest(deviceId, requestId, now);
  }

  deleteRequest(deviceId: string, requestId: string): Promise<void> {
    return this.forDevice(deviceId).deleteRequest(deviceId, requestId);
  }

  submitStreamEvent(
    ...args: Parameters<GatewayCoordinatorStub["submitStreamEvent"]>
  ): Promise<boolean> {
    return this.forDevice(args[0]).submitStreamEvent(...args);
  }

  peekStreamEvent(
    ...args: Parameters<GatewayCoordinatorStub["peekStreamEvent"]>
  ): Promise<GatewayCapabilityStreamEnvelope | null> {
    return this.forDevice(args[0]).peekStreamEvent(...args);
  }

  acknowledgeStreamEvent(
    ...args: Parameters<GatewayCoordinatorStub["acknowledgeStreamEvent"]>
  ): Promise<boolean> {
    return this.forDevice(args[0]).acknowledgeStreamEvent(...args);
  }

  cancelStream(...args: Parameters<GatewayCoordinatorStub["cancelStream"]>): Promise<boolean> {
    return this.forDevice(args[0]).cancelStream(...args);
  }

  private forDevice(deviceId: string): GatewayCoordinatorStub {
    assertDeviceId(deviceId);
    return this.namespace.get(this.namespace.idFromName(deviceId));
  }
}
