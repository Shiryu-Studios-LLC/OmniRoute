/**
 * Cloud-only provider credential envelope encryption.
 *
 * `CLOUD_CREDENTIAL_ENCRYPTION_KEY` is a base64-encoded 32-byte wrapping key.
 * Each value gets a random 32-byte DEK; AES-256-GCM encrypts the value and wraps
 * that DEK. Both operations authenticate tenant, connection, and field context.
 * The v2 format remains the default. A configured keyring can opt writes into
 * v3, which identifies the wrapping key without changing the tenant AAD model.
 */

const V2_ENVELOPE_PREFIX = "enc:v2:";
const V3_ENVELOPE_PREFIX = "enc:v3:";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class CloudCredentialEncryptionError extends Error {
  constructor() {
    super("Cloud credential encryption is unavailable");
    this.name = "CloudCredentialEncryptionError";
  }
}

export interface CloudCredentialContext {
  tenantId: string;
  connectionId: string;
  field: string;
}

/**
 * Keyring input for credential encryption. `legacyKey` reads existing v2
 * envelopes and remains the v2 writer key until `activeKeyId` is set. Entries
 * in `keys` decrypt v3 envelopes by their authenticated key ID.
 */
export interface CloudCredentialKeyring {
  legacyKey: string;
  keys: Readonly<Record<string, string>>;
  activeKeyId?: string;
}

export type CloudCredentialEncryptionKey = string | CloudCredentialKeyring;

export function isCloudCredentialKeyId(value: unknown): value is string {
  return typeof value === "string" && KEY_ID_PATTERN.test(value);
}

interface ParsedEnvelope {
  version: 2 | 3;
  keyId?: string;
  wrapIv: string;
  wrappedKey: string;
  dataIv: string;
  ciphertext: string;
}

function decodeWrappingKey(secret: string | undefined): Uint8Array {
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) {
    throw new CloudCredentialEncryptionError();
  }

  try {
    const decoded = atob(secret);
    if (decoded.length !== KEY_BYTES || btoa(decoded) !== secret) {
      throw new CloudCredentialEncryptionError();
    }
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new CloudCredentialEncryptionError();
  }
}

export function isCloudCredentialEncryptionKey(
  secret: CloudCredentialEncryptionKey | undefined
): boolean {
  if (typeof secret === "object" && secret !== null) {
    if (!isRawCloudCredentialKey(secret.legacyKey)) return false;
    if (secret.keys === null || typeof secret.keys !== "object" || Array.isArray(secret.keys)) {
      return false;
    }
    for (const [keyId, keyValue] of Object.entries(secret.keys)) {
      if (!isCloudCredentialKeyId(keyId) || !isRawCloudCredentialKey(keyValue)) return false;
    }
    return (
      secret.activeKeyId === undefined ||
      (isCloudCredentialKeyId(secret.activeKeyId) && Object.hasOwn(secret.keys, secret.activeKeyId))
    );
  }
  return isRawCloudCredentialKey(secret);
}

function isRawCloudCredentialKey(secret: string | undefined): boolean {
  try {
    decodeWrappingKey(secret);
    return true;
  } catch {
    return false;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) throw new CloudCredentialEncryptionError();
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function contextAad(
  context: CloudCredentialContext,
  purpose: "dek" | "value",
  version: 2 | 3,
  keyId?: string
): Uint8Array {
  return encoder.encode(
    JSON.stringify(
      version === 2
        ? [
            "omniroute-cloud-credential",
            2,
            context.tenantId,
            context.connectionId,
            context.field,
            purpose,
          ]
        : [
            "omniroute-cloud-credential",
            3,
            keyId,
            context.tenantId,
            context.connectionId,
            context.field,
            purpose,
          ]
    )
  );
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

/** Returns true only for this Worker's authenticated envelope format. */
export function isCloudCredentialEnvelope(value: unknown): value is string {
  return parseEnvelope(value) !== null;
}

function parseEnvelope(value: unknown): ParsedEnvelope | null {
  if (typeof value !== "string") return null;
  let version: 2 | 3;
  let keyId: string | undefined;
  let payload: string;
  if (value.startsWith(V2_ENVELOPE_PREFIX)) {
    version = 2;
    payload = value.slice(V2_ENVELOPE_PREFIX.length);
  } else if (value.startsWith(V3_ENVELOPE_PREFIX)) {
    version = 3;
    const separator = value.indexOf(":", V3_ENVELOPE_PREFIX.length);
    if (separator < 0) return null;
    keyId = value.slice(V3_ENVELOPE_PREFIX.length, separator);
    if (!isCloudCredentialKeyId(keyId)) return null;
    payload = value.slice(separator + 1);
  } else {
    return null;
  }

  const parts = payload.split(":");
  if (
    parts.length !== 4 ||
    !/^[a-f0-9]{24}$/i.test(parts[0]) ||
    !/^[a-f0-9]{96}$/i.test(parts[1]) ||
    !/^[a-f0-9]{24}$/i.test(parts[2]) ||
    !/^(?:[a-f0-9]{2})+$/i.test(parts[3]) ||
    parts[3].length < TAG_BYTES * 2
  ) {
    return null;
  }
  return {
    version,
    ...(keyId ? { keyId } : {}),
    wrapIv: parts[0],
    wrappedKey: parts[1],
    dataIv: parts[2],
    ciphertext: parts[3],
  };
}

function configuredKeyForWrite(key: CloudCredentialEncryptionKey | undefined): {
  version: 2 | 3;
  keyId?: string;
  secret: string;
} {
  if (typeof key === "string") return { version: 2, secret: key };
  if (!key || typeof key !== "object") throw new CloudCredentialEncryptionError();
  if (!isCloudCredentialEncryptionKey(key.legacyKey)) {
    throw new CloudCredentialEncryptionError();
  }
  if (key.activeKeyId === undefined) return { version: 2, secret: key.legacyKey };
  if (!isCloudCredentialKeyId(key.activeKeyId)) throw new CloudCredentialEncryptionError();
  const secret =
    key.keys && Object.hasOwn(key.keys, key.activeKeyId) ? key.keys[key.activeKeyId] : undefined;
  if (!isCloudCredentialEncryptionKey(secret)) throw new CloudCredentialEncryptionError();
  return { version: 3, keyId: key.activeKeyId, secret };
}

function configuredKeyForRead(
  key: CloudCredentialEncryptionKey | undefined,
  envelope: ParsedEnvelope
): string {
  if (typeof key === "string") {
    if (envelope.version === 3) throw new CloudCredentialEncryptionError();
    return key;
  }
  if (!key || typeof key !== "object" || !isCloudCredentialEncryptionKey(key.legacyKey)) {
    throw new CloudCredentialEncryptionError();
  }
  if (envelope.version === 2) return key.legacyKey;
  const secret =
    envelope.keyId && key.keys && Object.hasOwn(key.keys, envelope.keyId)
      ? key.keys[envelope.keyId]
      : undefined;
  if (!isCloudCredentialEncryptionKey(secret)) throw new CloudCredentialEncryptionError();
  return secret;
}

export async function encryptCloudCredential(
  plaintext: string,
  secret: CloudCredentialEncryptionKey | undefined,
  context: CloudCredentialContext
): Promise<string> {
  const writeKey = configuredKeyForWrite(secret);
  const wrappingKey = await importAesKey(decodeWrappingKey(writeKey.secret), ["encrypt"]);
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const dataKey = await importAesKey(dataKeyBytes, ["encrypt"]);
  const wrapIv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const dataIv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  try {
    const [wrappedKey, ciphertext] = await Promise.all([
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: wrapIv,
          additionalData: contextAad(context, "dek", writeKey.version, writeKey.keyId),
          tagLength: 128,
        },
        wrappingKey,
        dataKeyBytes
      ),
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: dataIv,
          additionalData: contextAad(context, "value", writeKey.version, writeKey.keyId),
          tagLength: 128,
        },
        dataKey,
        encoder.encode(plaintext)
      ),
    ]);
    const prefix =
      writeKey.version === 2 ? V2_ENVELOPE_PREFIX : `${V3_ENVELOPE_PREFIX}${writeKey.keyId}:`;
    return `${prefix}${toHex(wrapIv)}:${toHex(new Uint8Array(wrappedKey))}:${toHex(dataIv)}:${toHex(new Uint8Array(ciphertext))}`;
  } catch {
    throw new CloudCredentialEncryptionError();
  }
}

/** Decrypts only when the original tenant, connection, field, and key are supplied. */
export async function decryptCloudCredential(
  envelope: string,
  secret: CloudCredentialEncryptionKey | undefined,
  context: CloudCredentialContext
): Promise<string> {
  const parsed = parseEnvelope(envelope);
  if (!parsed) throw new CloudCredentialEncryptionError();
  const wrappingKey = await importAesKey(decodeWrappingKey(configuredKeyForRead(secret, parsed)), [
    "decrypt",
  ]);

  try {
    const dataKeyBytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromHex(parsed.wrapIv),
        additionalData: contextAad(context, "dek", parsed.version, parsed.keyId),
        tagLength: 128,
      },
      wrappingKey,
      fromHex(parsed.wrappedKey)
    );
    const dataKey = await importAesKey(new Uint8Array(dataKeyBytes), ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromHex(parsed.dataIv),
        additionalData: contextAad(context, "value", parsed.version, parsed.keyId),
        tagLength: 128,
      },
      dataKey,
      fromHex(parsed.ciphertext)
    );
    return decoder.decode(plaintext);
  } catch {
    throw new CloudCredentialEncryptionError();
  }
}

/**
 * Rewraps an authenticated credential envelope under the keyring's active key.
 * Plaintext remains in a byte buffer inside this function and is never returned
 * or logged. An envelope already using the active key is authenticated before
 * being returned unchanged.
 */
export async function rewrapCloudCredential(
  envelope: string,
  keyring: CloudCredentialKeyring | undefined,
  context: CloudCredentialContext
): Promise<string> {
  const parsed = parseEnvelope(envelope);
  if (!parsed || !keyring || typeof keyring !== "object") {
    throw new CloudCredentialEncryptionError();
  }

  const writeKey = configuredKeyForWrite(keyring);
  if (writeKey.version !== 3 || !writeKey.keyId) {
    throw new CloudCredentialEncryptionError();
  }

  let plaintext: Uint8Array | undefined;
  let sourceDataKey: Uint8Array | undefined;
  let targetDataKey: Uint8Array | undefined;
  try {
    const sourceWrappingKey = await importAesKey(
      decodeWrappingKey(configuredKeyForRead(keyring, parsed)),
      ["decrypt"]
    );
    const unwrapped = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromHex(parsed.wrapIv),
        additionalData: contextAad(context, "dek", parsed.version, parsed.keyId),
        tagLength: 128,
      },
      sourceWrappingKey,
      fromHex(parsed.wrappedKey)
    );
    sourceDataKey = new Uint8Array(unwrapped);
    const sourceKey = await importAesKey(sourceDataKey, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromHex(parsed.dataIv),
        additionalData: contextAad(context, "value", parsed.version, parsed.keyId),
        tagLength: 128,
      },
      sourceKey,
      fromHex(parsed.ciphertext)
    );
    plaintext = new Uint8Array(decrypted);

    if (parsed.version === 3 && parsed.keyId === writeKey.keyId) return envelope;

    const targetWrappingKey = await importAesKey(decodeWrappingKey(writeKey.secret), ["encrypt"]);
    targetDataKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    const targetKey = await importAesKey(targetDataKey, ["encrypt"]);
    const wrapIv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const dataIv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const [wrappedKey, ciphertext] = await Promise.all([
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: wrapIv,
          additionalData: contextAad(context, "dek", 3, writeKey.keyId),
          tagLength: 128,
        },
        targetWrappingKey,
        targetDataKey
      ),
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: dataIv,
          additionalData: contextAad(context, "value", 3, writeKey.keyId),
          tagLength: 128,
        },
        targetKey,
        plaintext
      ),
    ]);
    return `${V3_ENVELOPE_PREFIX}${writeKey.keyId}:${toHex(wrapIv)}:${toHex(new Uint8Array(wrappedKey))}:${toHex(dataIv)}:${toHex(new Uint8Array(ciphertext))}`;
  } catch {
    throw new CloudCredentialEncryptionError();
  } finally {
    plaintext?.fill(0);
    sourceDataKey?.fill(0);
    targetDataKey?.fill(0);
  }
}
