const MODEL_SYNC_INTERNAL_AUTH_HEADER = "x-model-sync-internal-auth";

const globalState = globalThis as typeof globalThis & {
  __omnirouteModelSyncInternalAuthToken?: string;
};

let internalAuthToken: string | null = null;

/** Return the process-shared model-sync token, adopting one set by another module instance. */
export function getModelSyncInternalAuthToken(): string | null {
  if (!internalAuthToken && globalState.__omnirouteModelSyncInternalAuthToken) {
    internalAuthToken = globalState.__omnirouteModelSyncInternalAuthToken;
  }
  return internalAuthToken;
}

/** Store a token for both this module instance and other bundles in the process. */
export function setModelSyncInternalAuthToken(token: string): void {
  internalAuthToken = token;
  globalState.__omnirouteModelSyncInternalAuthToken = token;
}

export function getModelSyncInternalAuthHeaderName(): string {
  return MODEL_SYNC_INTERNAL_AUTH_HEADER;
}

export function isModelSyncInternalRequest(request: { headers: Headers }): boolean {
  const token = getModelSyncInternalAuthToken();
  const headerToken = request.headers.get(MODEL_SYNC_INTERNAL_AUTH_HEADER);
  return Boolean(headerToken && token && headerToken === token);
}
