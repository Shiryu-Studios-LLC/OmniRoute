/**
 * Cloud-only provider credential envelope encryption.
 *
 * `CLOUD_CREDENTIAL_ENCRYPTION_KEY` is a base64-encoded 32-byte wrapping key.
 * Each value gets a random 32-byte DEK; AES-256-GCM encrypts the value and wraps
 * that DEK. Both operations authenticate tenant, connection, and field context.
 */

const ENVELOPE_PREFIX = "enc:v2:";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
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

export function isCloudCredentialEncryptionKey(secret: string | undefined): boolean {
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

function contextAad(context: CloudCredentialContext, purpose: "dek" | "value"): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "omniroute-cloud-credential",
      2,
      context.tenantId,
      context.connectionId,
      context.field,
      purpose,
    ])
  );
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
}

/** Returns true only for this Worker's authenticated envelope format. */
export function isCloudCredentialEnvelope(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(ENVELOPE_PREFIX)) return false;
  const parts = value.slice(ENVELOPE_PREFIX.length).split(":");
  return (
    parts.length === 4 &&
    /^[a-f0-9]{24}$/i.test(parts[0]) &&
    /^[a-f0-9]{96}$/i.test(parts[1]) &&
    /^[a-f0-9]{24}$/i.test(parts[2]) &&
    /^(?:[a-f0-9]{2})+$/i.test(parts[3]) &&
    parts[3].length >= TAG_BYTES * 2
  );
}

export async function encryptCloudCredential(
  plaintext: string,
  secret: string | undefined,
  context: CloudCredentialContext
): Promise<string> {
  const wrappingKey = await importAesKey(decodeWrappingKey(secret), ["encrypt"]);
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const dataKey = await importAesKey(dataKeyBytes, ["encrypt"]);
  const wrapIv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const dataIv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  try {
    const [wrappedKey, ciphertext] = await Promise.all([
      crypto.subtle.encrypt(
        { name: "AES-GCM", iv: wrapIv, additionalData: contextAad(context, "dek"), tagLength: 128 },
        wrappingKey,
        dataKeyBytes
      ),
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: dataIv,
          additionalData: contextAad(context, "value"),
          tagLength: 128,
        },
        dataKey,
        encoder.encode(plaintext)
      ),
    ]);
    return `${ENVELOPE_PREFIX}${toHex(wrapIv)}:${toHex(new Uint8Array(wrappedKey))}:${toHex(dataIv)}:${toHex(new Uint8Array(ciphertext))}`;
  } catch {
    throw new CloudCredentialEncryptionError();
  }
}

/** Decrypts only when the original tenant, connection, field, and key are supplied. */
export async function decryptCloudCredential(
  envelope: string,
  secret: string | undefined,
  context: CloudCredentialContext
): Promise<string> {
  if (!isCloudCredentialEnvelope(envelope)) throw new CloudCredentialEncryptionError();
  const wrappingKey = await importAesKey(decodeWrappingKey(secret), ["decrypt"]);
  const [wrapIvHex, wrappedKeyHex, dataIvHex, ciphertextHex] = envelope
    .slice(ENVELOPE_PREFIX.length)
    .split(":");

  try {
    const dataKeyBytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromHex(wrapIvHex),
        additionalData: contextAad(context, "dek"),
        tagLength: 128,
      },
      wrappingKey,
      fromHex(wrappedKeyHex)
    );
    const dataKey = await importAesKey(new Uint8Array(dataKeyBytes), ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromHex(dataIvHex),
        additionalData: contextAad(context, "value"),
        tagLength: 128,
      },
      dataKey,
      fromHex(ciphertextHex)
    );
    return decoder.decode(plaintext);
  } catch {
    throw new CloudCredentialEncryptionError();
  }
}
