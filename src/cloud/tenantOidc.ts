import type { CloudDb } from "./db";
import { encryptCloudCredential, isCloudCredentialEnvelope } from "./credentialEncryption";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_SCOPES = ["openid", "profile", "email"];

export interface CloudTenantOidcConfig {
  tenantId: string;
  issuer: string;
  clientId: string;
  scopes: string[];
  isEnabled: boolean;
  hasClientSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CloudTenantOidcIdentity {
  id: string;
  tenantId: string;
  issuer: string;
  subject: string;
  membershipId: string;
  principalId: string;
  role: "owner" | "admin" | "member" | "viewer";
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
  membership_id: string;
  principal_id: string;
  role: CloudTenantOidcIdentity["role"];
  created_at: string;
}

function requireId(value: string, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value;
}

function requireIssuer(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value !== value.trim()
  ) {
    throw new TypeError("Invalid OIDC issuer");
  }
  try {
    const issuer = new URL(value);
    if (
      issuer.protocol !== "https:" ||
      issuer.username !== "" ||
      issuer.password !== "" ||
      issuer.search !== "" ||
      issuer.hash !== ""
    ) {
      throw new TypeError("Invalid OIDC issuer");
    }
  } catch {
    throw new TypeError("Invalid OIDC issuer");
  }
  return value;
}

function requireClientId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value !== value.trim()
  ) {
    throw new TypeError("Invalid OIDC clientId");
  }
  return value;
}

function requireSecret(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 500) {
    throw new TypeError("Invalid OIDC clientSecret");
  }
  if (isCloudCredentialEnvelope(value))
    throw new TypeError("OIDC clientSecret must be plaintext input");
  return value;
}

function requireScopes(value: string[] | undefined): string[] {
  if (value === undefined) return DEFAULT_SCOPES;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 32 ||
    value.some(
      (scope) =>
        typeof scope !== "string" ||
        scope.length < 1 ||
        scope.length > 100 ||
        scope !== scope.trim()
    )
  ) {
    throw new TypeError("Invalid OIDC scopes");
  }
  return [...new Set(value)];
}

function mapConfig(row: ConfigRow): CloudTenantOidcConfig {
  let scopes: unknown;
  try {
    scopes = JSON.parse(row.scopes_json) as unknown;
  } catch {
    scopes = null;
  }
  return {
    tenantId: row.tenant_id,
    issuer: row.issuer,
    clientId: row.client_id,
    scopes:
      Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string")
        ? scopes
        : DEFAULT_SCOPES,
    isEnabled: row.is_enabled === 1,
    hasClientSecret: isCloudCredentialEnvelope(row.client_secret_encrypted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCloudTenantOidcConfig(
  db: CloudDb,
  tenantId: string
): Promise<CloudTenantOidcConfig | null> {
  requireId(tenantId, "tenantId");
  const row = await db
    .prepare<ConfigRow>("SELECT * FROM cloud_tenant_oidc_configs WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId)
    .first();
  return row ? mapConfig(row) : null;
}

export async function setCloudTenantOidcConfig(
  db: CloudDb,
  encryptionKey: string | undefined,
  input: {
    tenantId: string;
    issuer: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    isEnabled?: boolean;
    now?: string;
  }
): Promise<CloudTenantOidcConfig> {
  const tenantId = requireId(input.tenantId, "tenantId");
  const issuer = requireIssuer(input.issuer);
  const clientId = requireClientId(input.clientId);
  const clientSecret = requireSecret(input.clientSecret);
  if (input.isEnabled !== undefined && typeof input.isEnabled !== "boolean") {
    throw new TypeError("Invalid OIDC isEnabled");
  }

  const tenant = await db
    .prepare<{ id: string; kind: string; is_active: number }>(
      "SELECT id, kind, is_active FROM tenants WHERE id = ? LIMIT 1"
    )
    .bind(tenantId)
    .first();
  if (!tenant || tenant.kind !== "customer") throw new TypeError("Customer tenant not found");

  const existing = await db
    .prepare<ConfigRow>("SELECT * FROM cloud_tenant_oidc_configs WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId)
    .first();
  const scopes = requireScopes(input.scopes ?? (existing ? mapConfig(existing).scopes : undefined));
  if (!existing && !clientSecret) throw new TypeError("OIDC clientSecret is required for setup");
  const now = input.now ?? new Date().toISOString();
  const secretEnvelope = clientSecret
    ? await encryptCloudCredential(clientSecret, encryptionKey, {
        tenantId,
        connectionId: "tenant-oidc",
        field: "clientSecret",
      })
    : existing?.client_secret_encrypted;
  if (!secretEnvelope) throw new TypeError("OIDC clientSecret is required for setup");
  const isEnabled =
    input.isEnabled === undefined ? (existing?.is_enabled ?? 0) === 1 : input.isEnabled;
  const createdAt = existing?.created_at ?? now;
  const statements: ReturnType<CloudDb["prepare"]>[] = [];
  if (existing && existing.issuer !== issuer) {
    statements.push(
      db.prepare("DELETE FROM cloud_tenant_oidc_identities WHERE tenant_id = ?").bind(tenantId)
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO cloud_tenant_oidc_configs
           (tenant_id, issuer, client_id, client_secret_encrypted, scopes_json,
            is_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           issuer = excluded.issuer,
           client_id = excluded.client_id,
           client_secret_encrypted = excluded.client_secret_encrypted,
           scopes_json = excluded.scopes_json,
           is_enabled = excluded.is_enabled,
           updated_at = excluded.updated_at`
      )
      .bind(
        tenantId,
        issuer,
        clientId,
        secretEnvelope,
        JSON.stringify(scopes),
        isEnabled ? 1 : 0,
        createdAt,
        now
      )
  );
  const results = await db.batch(statements);
  if (
    results.some(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        "success" in result &&
        result.success === false
    )
  ) {
    throw new Error("OIDC configuration could not be saved");
  }
  const config = await getCloudTenantOidcConfig(db, tenantId);
  if (!config) throw new Error("OIDC configuration could not be read after save");
  return config;
}

export async function deleteCloudTenantOidcConfig(db: CloudDb, tenantId: string): Promise<boolean> {
  requireId(tenantId, "tenantId");
  const results = await db.batch([
    db.prepare("DELETE FROM cloud_tenant_oidc_identities WHERE tenant_id = ?").bind(tenantId),
    db.prepare("DELETE FROM cloud_tenant_oidc_configs WHERE tenant_id = ?").bind(tenantId),
  ]);
  return results.some(
    (result) =>
      typeof result === "object" &&
      result !== null &&
      "meta" in result &&
      Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0
  );
}

export async function listCloudTenantOidcIdentities(
  db: CloudDb,
  tenantId: string
): Promise<CloudTenantOidcIdentity[]> {
  requireId(tenantId, "tenantId");
  const result = await db
    .prepare<IdentityRow>(
      `SELECT identity.id, identity.tenant_id, identity.issuer, identity.subject,
              identity.membership_id, membership.principal_id, membership.role, identity.created_at
         FROM cloud_tenant_oidc_identities AS identity
         JOIN cloud_customer_memberships AS membership
           ON membership.tenant_id = identity.tenant_id AND membership.id = identity.membership_id
        WHERE identity.tenant_id = ? ORDER BY identity.created_at, identity.id`
    )
    .bind(tenantId)
    .all();
  if (!result.success) throw new Error("OIDC identity links could not be read");
  return result.results.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    issuer: row.issuer,
    subject: row.subject,
    membershipId: row.membership_id,
    principalId: row.principal_id,
    role: row.role,
    createdAt: row.created_at,
  }));
}

export async function addCloudTenantOidcIdentity(
  db: CloudDb,
  input: { tenantId: string; issuer: string; subject: string; membershipId: string; now?: string }
): Promise<CloudTenantOidcIdentity> {
  const tenantId = requireId(input.tenantId, "tenantId");
  const issuer = requireIssuer(input.issuer);
  const membershipId = requireId(input.membershipId, "membershipId");
  if (typeof input.subject !== "string" || input.subject.length < 1 || input.subject.length > 512) {
    throw new TypeError("Invalid OIDC subject");
  }
  const config = await db
    .prepare<{ issuer: string }>(
      "SELECT issuer FROM cloud_tenant_oidc_configs WHERE tenant_id = ? LIMIT 1"
    )
    .bind(tenantId)
    .first();
  if (!config || config.issuer !== issuer) {
    throw new TypeError("OIDC identity issuer must exactly match the tenant's configured issuer");
  }
  const membership = await db
    .prepare<{ id: string; is_active: number }>(
      `SELECT id, is_active FROM cloud_customer_memberships
        WHERE tenant_id = ? AND id = ? LIMIT 1`
    )
    .bind(tenantId, membershipId)
    .first();
  if (!membership || membership.is_active !== 1) {
    throw new TypeError("Active tenant membership not found");
  }
  const id = crypto.randomUUID();
  const createdAt = input.now ?? new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO cloud_tenant_oidc_identities
         (id, tenant_id, issuer, subject, membership_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, tenantId, issuer, input.subject, membershipId, createdAt)
    .run();
  const identities = await listCloudTenantOidcIdentities(db, tenantId);
  const identity = identities.find((entry) => entry.id === id);
  if (!identity) throw new Error("OIDC identity link could not be read after save");
  return identity;
}

export async function deleteCloudTenantOidcIdentity(
  db: CloudDb,
  tenantId: string,
  identityId: string
): Promise<boolean> {
  requireId(tenantId, "tenantId");
  requireId(identityId, "identityId");
  const result = await db
    .prepare("DELETE FROM cloud_tenant_oidc_identities WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, identityId)
    .run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}
