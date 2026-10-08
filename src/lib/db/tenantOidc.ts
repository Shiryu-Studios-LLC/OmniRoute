/**
 * Tenant-owned OIDC configuration and external identity persistence.
 *
 * This module deliberately does not participate in login, issuer discovery,
 * account linking, or tenant membership authorization. Those flows must be
 * completed before these records are used to authenticate a customer.
 */
import { randomUUID } from "crypto";
import { z } from "zod";
import { getDbInstance } from "./core";
import { decrypt, encrypt, isEncryptionEnabled, looksEncrypted } from "./encryption";
import { assertTenantScope, currentDbTenantId } from "./tenantScope";

const issuerSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => {
    try {
      const issuer = new URL(value);
      return (
        issuer.protocol === "https:" &&
        issuer.username.length === 0 &&
        issuer.password.length === 0 &&
        issuer.search.length === 0 &&
        issuer.hash.length === 0
      );
    } catch {
      return false;
    }
  }, "OIDC issuer must be an HTTPS URL without credentials, query, or fragment");

const configSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(128).optional(),
    issuer: issuerSchema,
    clientId: z.string().trim().min(1).max(200),
    clientSecret: z.string().min(1).max(500).optional(),
    scopes: z.array(z.string().trim().min(1).max(100)).min(1).max(32).optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict();

const identitySchema = z
  .object({
    tenantId: z.string().trim().min(1).max(128).optional(),
    issuer: issuerSchema,
    subject: z.string().min(1).max(512),
    principalId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export interface TenantOidcConfig {
  tenantId: string;
  issuer: string;
  clientId: string;
  scopes: string[];
  isEnabled: boolean;
  hasClientSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TenantOidcCredentials extends TenantOidcConfig {
  clientSecret: string;
}

export interface TenantOidcIdentity {
  id: string;
  tenantId: string;
  issuer: string;
  subject: string;
  principalId: string;
  createdAt: string;
}

interface ConfigRow {
  tenant_id: string;
  issuer: string;
  client_id: string;
  client_secret_encrypted: string;
  scopes_json: string;
  is_enabled: number;
  created_at: string;
  updated_at: string;
}

interface IdentityRow {
  id: string;
  tenant_id: string;
  issuer: string;
  subject: string;
  principal_id: string;
  created_at: string;
}

function parseScopes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string")
      ? parsed
      : ["openid", "profile", "email"];
  } catch {
    return ["openid", "profile", "email"];
  }
}

function toConfig(row: ConfigRow): TenantOidcConfig {
  return {
    tenantId: row.tenant_id,
    issuer: row.issuer,
    clientId: row.client_id,
    scopes: parseScopes(row.scopes_json),
    isEnabled: row.is_enabled !== 0,
    hasClientSecret: Boolean(row.client_secret_encrypted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIdentity(row: IdentityRow): TenantOidcIdentity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    issuer: row.issuer,
    subject: row.subject,
    principalId: row.principal_id,
    createdAt: row.created_at,
  };
}

function encryptClientSecret(secret: string): string {
  if (looksEncrypted(secret)) throw new Error("OIDC client secret must be plaintext input");
  if (!isEncryptionEnabled()) {
    throw new Error("STORAGE_ENCRYPTION_KEY is required to store tenant OIDC credentials");
  }
  const encrypted = encrypt(secret);
  if (typeof encrypted !== "string" || !looksEncrypted(encrypted)) {
    throw new Error("OIDC client secret encryption failed");
  }
  return encrypted;
}

/** Store or replace the current tenant's OIDC client configuration. */
export function setTenantOidcConfig(input: {
  tenantId?: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  isEnabled?: boolean;
}): TenantOidcConfig {
  const data = configSchema.parse(input);
  const tenantId = assertTenantScope(data.tenantId);
  const db = getDbInstance();
  const existing = db
    .prepare(
      "SELECT issuer, created_at, client_secret_encrypted FROM tenant_oidc_configs WHERE tenant_id = ?"
    )
    .get(tenantId) as
    { issuer: string; created_at: string; client_secret_encrypted: string } | undefined;
  const encryptedSecret = data.clientSecret
    ? encryptClientSecret(data.clientSecret)
    : existing?.client_secret_encrypted;
  if (!encryptedSecret) {
    throw new Error("OIDC client secret is required when creating tenant OIDC configuration");
  }
  const now = new Date().toISOString();
  const saveConfig = db.transaction(() => {
    if (existing && existing.issuer !== data.issuer) {
      db.prepare("DELETE FROM tenant_oidc_identities WHERE tenant_id = ?").run(tenantId);
    }
    db.prepare(
      `INSERT INTO tenant_oidc_configs
       (tenant_id, issuer, client_id, client_secret_encrypted, scopes_json, is_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       issuer = excluded.issuer,
       client_id = excluded.client_id,
       client_secret_encrypted = excluded.client_secret_encrypted,
       scopes_json = excluded.scopes_json,
       is_enabled = excluded.is_enabled,
       updated_at = excluded.updated_at`
    ).run(
      tenantId,
      data.issuer,
      data.clientId,
      encryptedSecret,
      JSON.stringify(data.scopes ?? ["openid", "profile", "email"]),
      data.isEnabled === true ? 1 : 0,
      existing?.created_at ?? now,
      now
    );
  });
  saveConfig();
  const config = getTenantOidcConfig();
  if (!config) throw new Error("Failed to store tenant OIDC configuration");
  return config;
}

/** Return safe OIDC configuration metadata for the current tenant. */
export function getTenantOidcConfig(): TenantOidcConfig | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM tenant_oidc_configs WHERE tenant_id = ? LIMIT 1")
    .get(currentDbTenantId()) as ConfigRow | undefined;
  return row ? toConfig(row) : null;
}

/** Server-side credential reader, scoped to the already established tenant context. */
export function getTenantOidcCredentials(): TenantOidcCredentials | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM tenant_oidc_configs WHERE tenant_id = ? LIMIT 1")
    .get(currentDbTenantId()) as ConfigRow | undefined;
  if (!row || row.is_enabled === 0) return null;
  if (!looksEncrypted(row.client_secret_encrypted)) {
    throw new Error("Tenant OIDC client secret is not encrypted at rest");
  }
  const clientSecret = decrypt(row.client_secret_encrypted, { quiet: true });
  if (!clientSecret) throw new Error("Tenant OIDC client secret could not be decrypted");
  return { ...toConfig(row), clientSecret };
}

/** Disable the current tenant's OIDC config without deleting its credentials. */
export function disableTenantOidcConfig(): TenantOidcConfig | null {
  const tenantId = currentDbTenantId();
  const result = getDbInstance()
    .prepare("UPDATE tenant_oidc_configs SET is_enabled = 0, updated_at = ? WHERE tenant_id = ?")
    .run(new Date().toISOString(), tenantId);
  return result.changes > 0 ? getTenantOidcConfig() : null;
}

/** Delete the current tenant's OIDC configuration. */
export function deleteTenantOidcConfig(tenantId?: string): boolean {
  const scopedTenantId = assertTenantScope(tenantId);
  const db = getDbInstance();
  const removeConfig = db.transaction(() => {
    db.prepare("DELETE FROM tenant_oidc_identities WHERE tenant_id = ?").run(scopedTenantId);
    return db.prepare("DELETE FROM tenant_oidc_configs WHERE tenant_id = ?").run(scopedTenantId)
      .changes;
  });
  return removeConfig() > 0;
}

/** Add an externally verified identity mapping for the current tenant. */
export function addTenantOidcIdentity(input: {
  tenantId?: string;
  issuer: string;
  subject: string;
  principalId?: string;
}): TenantOidcIdentity {
  const data = identitySchema.parse(input);
  const tenantId = assertTenantScope(data.tenantId);
  const config = getDbInstance()
    .prepare("SELECT issuer, is_enabled FROM tenant_oidc_configs WHERE tenant_id = ? LIMIT 1")
    .get(tenantId) as { issuer: string; is_enabled: number } | undefined;
  if (!config || config.is_enabled === 0 || config.issuer !== data.issuer) {
    throw new Error("OIDC identity issuer must match the tenant's enabled OIDC configuration");
  }
  const identityId = randomUUID();
  const principalId = data.principalId ?? randomUUID();
  const createdAt = new Date().toISOString();
  getDbInstance()
    .prepare(
      `INSERT INTO tenant_oidc_identities (id, tenant_id, issuer, subject, principal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(identityId, tenantId, data.issuer, data.subject, principalId, createdAt);
  const identity = getTenantOidcIdentityByIssuerSubject(data.issuer, data.subject);
  if (!identity) throw new Error("Failed to store tenant OIDC identity");
  return identity;
}

/** Look up an identity by exact OIDC issuer and subject in the current tenant. */
export function getTenantOidcIdentityByIssuerSubject(
  issuer: string,
  subject: string
): TenantOidcIdentity | null {
  const parsedIssuer = issuerSchema.parse(issuer);
  const parsedSubject = z.string().min(1).max(512).parse(subject);
  const row = getDbInstance()
    .prepare(
      `SELECT identity.id, identity.tenant_id, identity.issuer, identity.subject,
              identity.principal_id, identity.created_at
       FROM tenant_oidc_identities AS identity
       INNER JOIN tenant_oidc_configs AS config
         ON config.tenant_id = identity.tenant_id
        AND config.issuer = identity.issuer
        AND config.is_enabled = 1
       WHERE identity.tenant_id = ? AND identity.issuer = ? AND identity.subject = ? LIMIT 1`
    )
    .get(currentDbTenantId(), parsedIssuer, parsedSubject) as IdentityRow | undefined;
  return row ? toIdentity(row) : null;
}

/** List identity links belonging to the current tenant. */
export function listTenantOidcIdentities(): TenantOidcIdentity[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT id, tenant_id, issuer, subject, principal_id, created_at
       FROM tenant_oidc_identities WHERE tenant_id = ? ORDER BY created_at, id`
    )
    .all(currentDbTenantId()) as IdentityRow[];
  return rows.map(toIdentity);
}

/** Remove a current-tenant identity link by its internal id. */
export function removeTenantOidcIdentity(id: string, tenantId?: string): boolean {
  const scopedTenantId = assertTenantScope(tenantId);
  const identityId = z.string().uuid().parse(id);
  return (
    getDbInstance()
      .prepare("DELETE FROM tenant_oidc_identities WHERE id = ? AND tenant_id = ?")
      .run(identityId, scopedTenantId).changes > 0
  );
}
