import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptCloudCredential,
  encryptCloudCredential,
  isCloudCredentialEnvelope,
} from "@/cloud/credentialEncryption";

const key = Buffer.alloc(32, 23).toString("base64");
const context = { tenantId: "tenant-a", connectionId: "connection-a", field: "apiKey" };

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

test("Cloud credential envelope shape rejects malformed and truncated values", async () => {
  const envelope = await encryptCloudCredential("provider-secret", key, context);
  assert.equal(isCloudCredentialEnvelope(envelope), true);
  assert.equal(isCloudCredentialEnvelope(`${envelope.slice(0, -2)}zz`), false);
  assert.equal(isCloudCredentialEnvelope("enc:v2:fake"), false);
});
