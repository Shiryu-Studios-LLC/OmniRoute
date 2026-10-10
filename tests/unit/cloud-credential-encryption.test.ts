import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudCredentialEncryptionError,
  decryptCloudCredential,
  encryptCloudCredential,
  isCloudCredentialEnvelope,
  rewrapCloudCredential,
} from "@/cloud/credentialEncryption";

const key = Buffer.alloc(32, 23).toString("base64");
const nextKey = Buffer.alloc(32, 24).toString("base64");
const context = { tenantId: "tenant-a", connectionId: "connection-a", field: "apiKey" };

function keyring(activeKeyId?: string) {
  return {
    legacyKey: key,
    keys: { "rotation-2026-10": nextKey },
    ...(activeKeyId ? { activeKeyId } : {}),
  };
}

test("Cloud credential envelope decrypts only with its original key and AAD context", async () => {
  const envelope = await encryptCloudCredential("provider-secret", key, context);
  assert.equal(isCloudCredentialEnvelope(envelope), true);
  assert.equal(await decryptCloudCredential(envelope, key, context), "provider-secret");
  const parts = envelope.split(":");
  const ciphertext = parts.at(-1) ?? "";
  parts[parts.length - 1] = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("0") ? "1" : "0"}`;
  await assert.rejects(
    decryptCloudCredential(parts.join(":"), key, context),
    /Cloud credential encryption is unavailable/
  );

  await assert.rejects(
    decryptCloudCredential(envelope, Buffer.alloc(32, 24).toString("base64"), context),
    /Cloud credential encryption is unavailable/
  );
  await assert.rejects(
    decryptCloudCredential(envelope, key, { ...context, tenantId: "tenant-b" }),
    /Cloud credential encryption is unavailable/
  );
  await assert.rejects(
    decryptCloudCredential(envelope, key, { ...context, connectionId: "connection-b" }),
    /Cloud credential encryption is unavailable/
  );
  await assert.rejects(
    decryptCloudCredential(envelope, key, { ...context, field: "refreshToken" }),
    /Cloud credential encryption is unavailable/
  );
});

test("Cloud credential encryption rejects missing and malformed wrapping keys", async () => {
  await assert.rejects(encryptCloudCredential("secret", undefined, context));
  await assert.rejects(encryptCloudCredential("secret", "too-short", context));
  await assert.rejects(
    encryptCloudCredential("secret", Buffer.alloc(31).toString("base64"), context)
  );
});

test("keyed credential envelopes preserve v2 reads and opt into v3 writes only by key ID", async () => {
  const legacyEnvelope = await encryptCloudCredential("legacy-provider-secret", key, context);
  assert.match(legacyEnvelope, /^enc:v2:/);
  assert.equal(
    await decryptCloudCredential(legacyEnvelope, keyring("rotation-2026-10"), context),
    "legacy-provider-secret"
  );

  const withoutActiveId = await encryptCloudCredential("still-v2", keyring(), context);
  assert.match(withoutActiveId, /^enc:v2:/);
  assert.equal(await decryptCloudCredential(withoutActiveId, keyring(), context), "still-v2");

  const keyedEnvelope = await encryptCloudCredential(
    "rotated-provider-secret",
    keyring("rotation-2026-10"),
    context
  );
  assert.match(keyedEnvelope, /^enc:v3:rotation-2026-10:/);
  assert.equal(isCloudCredentialEnvelope(keyedEnvelope), true);
  assert.equal(
    await decryptCloudCredential(keyedEnvelope, keyring("rotation-2026-10"), context),
    "rotated-provider-secret"
  );
});

test("keyed credential envelopes reject missing, wrong, and unconfigured keys", async () => {
  const keyedEnvelope = await encryptCloudCredential(
    "rotated-provider-secret",
    keyring("rotation-2026-10"),
    context
  );
  await assert.rejects(
    decryptCloudCredential(keyedEnvelope, undefined, context),
    CloudCredentialEncryptionError
  );
  await assert.rejects(
    decryptCloudCredential(keyedEnvelope, { legacyKey: key, keys: {} }, context),
    CloudCredentialEncryptionError
  );
  await assert.rejects(
    decryptCloudCredential(
      keyedEnvelope,
      { legacyKey: key, keys: { "rotation-2026-10": key } },
      context
    ),
    CloudCredentialEncryptionError
  );
  await assert.rejects(
    encryptCloudCredential(
      "secret",
      { legacyKey: key, activeKeyId: "missing-key", keys: {} },
      context
    ),
    CloudCredentialEncryptionError
  );
  await assert.rejects(
    encryptCloudCredential(
      "secret",
      { legacyKey: key, activeKeyId: "bad:key", keys: { "bad:key": nextKey } },
      context
    ),
    CloudCredentialEncryptionError
  );
});

test("key ID, tenant, connection, and field remain bound by v3 authenticated context", async () => {
  const keyedEnvelope = await encryptCloudCredential(
    "provider-secret",
    keyring("rotation-2026-10"),
    context
  );
  await assert.rejects(
    decryptCloudCredential(keyedEnvelope, keyring("rotation-2026-10"), {
      ...context,
      tenantId: "tenant-b",
    }),
    CloudCredentialEncryptionError
  );
  await assert.rejects(
    decryptCloudCredential(keyedEnvelope, keyring("rotation-2026-10"), {
      ...context,
      connectionId: "other-resource",
    }),
    CloudCredentialEncryptionError
  );
  await assert.rejects(
    decryptCloudCredential(keyedEnvelope, keyring("rotation-2026-10"), {
      ...context,
      field: "mcpCredential",
    }),
    CloudCredentialEncryptionError
  );
  await assert.rejects(
    decryptCloudCredential(
      keyedEnvelope,
      { legacyKey: key, keys: { "another-key-id": nextKey } },
      context
    ),
    CloudCredentialEncryptionError
  );
});

test("credential rewrap migrates v2 and v3 envelopes to the selected active key", async () => {
  const previousKey = Buffer.alloc(32, 25).toString("base64");
  const sourceKeyring = {
    legacyKey: key,
    keys: { "rotation-2026-10": nextKey },
    activeKeyId: "rotation-2026-10",
  };
  const targetKeyring = {
    legacyKey: key,
    keys: {
      "rotation-2026-10": nextKey,
      "rotation-2027-01": previousKey,
    },
    activeKeyId: "rotation-2027-01",
  };

  const legacyEnvelope = await encryptCloudCredential("provider-secret", key, context);
  const rewrappedLegacy = await rewrapCloudCredential(legacyEnvelope, targetKeyring, context);
  assert.match(rewrappedLegacy, /^enc:v3:rotation-2027-01:/);
  assert.equal(rewrappedLegacy.includes("provider-secret"), false);
  assert.equal(
    await decryptCloudCredential(rewrappedLegacy, targetKeyring, context),
    "provider-secret"
  );

  const priorV3 = await encryptCloudCredential("v3-secret", sourceKeyring, context);
  const rewrappedV3 = await rewrapCloudCredential(priorV3, targetKeyring, context);
  assert.match(rewrappedV3, /^enc:v3:rotation-2027-01:/);
  assert.equal(await decryptCloudCredential(rewrappedV3, targetKeyring, context), "v3-secret");
});

test("credential rewrap authenticates before no-op and rejects malformed, wrong-key, and wrong-AAD inputs", async () => {
  const active = keyring("rotation-2026-10");
  const envelope = await encryptCloudCredential("still-secret", active, context);
  assert.equal(await rewrapCloudCredential(envelope, active, context), envelope);

  await assert.rejects(
    rewrapCloudCredential("enc:v2:malformed", active, context),
    CloudCredentialEncryptionError
  );
  await assert.rejects(
    rewrapCloudCredential(envelope, { ...active, keys: { "rotation-2026-10": key } }, context),
    CloudCredentialEncryptionError
  );
  await assert.rejects(
    rewrapCloudCredential(envelope, active, { ...context, tenantId: "tenant-b" }),
    CloudCredentialEncryptionError
  );
  await assert.rejects(
    rewrapCloudCredential(envelope, { legacyKey: key, keys: active.keys }, context),
    CloudCredentialEncryptionError
  );

  const tampered = `${envelope.slice(0, -2)}00`;
  await assert.rejects(
    rewrapCloudCredential(tampered, active, context),
    CloudCredentialEncryptionError
  );
});

test("Cloud credential envelope shape rejects malformed and truncated values", async () => {
  const envelope = await encryptCloudCredential("provider-secret", key, context);
  assert.equal(isCloudCredentialEnvelope(envelope), true);
  assert.equal(isCloudCredentialEnvelope(`${envelope.slice(0, -2)}zz`), false);
  assert.equal(isCloudCredentialEnvelope("enc:v2:fake"), false);
  assert.equal(isCloudCredentialEnvelope("enc:v3:bad:key-id"), false);
  assert.equal(isCloudCredentialEnvelope(envelope.replace("enc:v2:", "enc:v3:bad:key:")), false);
});
