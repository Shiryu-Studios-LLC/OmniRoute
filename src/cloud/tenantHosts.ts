import type { CloudDb } from "./db";

export interface CloudCustomerHostPortalAuthorization {
  tenantId: string;
  membershipId: string;
  sessionTokenHash: string;
  nowMs: number;
}

export interface CloudAdminVerifiedCustomerHost {
  hostname: string;
  tenantId: string;
  verifiedAt: string;
  verifiedBy: string;
  createdAt: string;
}

interface HostRow {
  hostname: string;
  tenant_id: string;
  verified_at: string;
  verified_by: string;
  created_at: string;
}

export interface CloudCustomerHostVerificationChallenge {
  hostname: string;
  tenantId: string;
  challengeId: string;
  tokenHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  attempts: number;
}

interface HostVerificationChallengeRow {
  hostname: string;
  tenant_id: string;
  challenge_id: string;
  token_hash: string;
  created_at_ms: number;
  expires_at_ms: number;
  attempts: number;
}

function mapHostVerificationChallenge(
  row: HostVerificationChallengeRow
): CloudCustomerHostVerificationChallenge {
  return {
    hostname: row.hostname,
    tenantId: row.tenant_id,
    challengeId: row.challenge_id,
    tokenHash: row.token_hash,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    attempts: row.attempts,
  };
}

function mapHost(row: HostRow): CloudAdminVerifiedCustomerHost {
  return {
    hostname: row.hostname,
    tenantId: row.tenant_id,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    createdAt: row.created_at,
  };
}

export function normalizeCustomerHostname(value: string): string | null {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    hostname.length < 1 ||
    hostname.length > 253 ||
    hostname.includes("..") ||
    hostname.startsWith("*.") ||
    hostname.includes("*") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      hostname
    )
  ) {
    return null;
  }
  return hostname;
}

export async function registerAdminVerifiedCustomerHost(
  db: CloudDb,
  input: { hostname: string; tenantId: string; verifiedAt: string; verifiedBy: string }
): Promise<CloudAdminVerifiedCustomerHost | null> {
  const statement = prepareAdminVerifiedCustomerHostInsert(db, input);
  const result = await statement.run();
  if (!result.success || Number(result.meta?.changes ?? 0) !== 1) return null;
  return getAdminVerifiedCustomerHost(db, input.hostname);
}

export function prepareAdminVerifiedCustomerHostInsert(
  db: CloudDb,
  input: { hostname: string; tenantId: string; verifiedAt: string; verifiedBy: string }
) {
  // Keep direct registration as a platform-admin break-glass operation. Routine
  // customer hosts should use the DNS challenge flow in tenantHostsHttpApi.ts.
  const hostname = normalizeCustomerHostname(input.hostname);
  if (!hostname) throw new TypeError("Invalid customer hostname");
  return db
    .prepare(
      `INSERT INTO cloud_verified_customer_hosts
         (hostname, tenant_id, verified_at, verified_by, created_at)
       SELECT ?, t.id, ?, ?, ? FROM tenants t
        WHERE t.id = ? AND t.kind = 'customer' AND t.is_active = 1`
    )
    .bind(hostname, input.verifiedAt, input.verifiedBy, input.verifiedAt, input.tenantId);
}

export function prepareCustomerHostVerificationChallengeInsert(
  db: CloudDb,
  input: {
    hostname: string;
    tenantId: string;
    challengeId: string;
    tokenHash: string;
    createdAtMs: number;
    expiresAtMs: number;
  },
  portalAuthorization?: CloudCustomerHostPortalAuthorization,
  replaceActiveChallenge = false
) {
  const hostname = normalizeCustomerHostname(input.hostname);
  if (!hostname) throw new TypeError("Invalid customer hostname");
  if (!/^[a-f0-9]{64}$/.test(input.tokenHash)) throw new TypeError("Invalid host challenge hash");
  if (
    !Number.isSafeInteger(input.createdAtMs) ||
    !Number.isSafeInteger(input.expiresAtMs) ||
    input.expiresAtMs <= input.createdAtMs
  ) {
    throw new TypeError("Invalid host challenge expiry");
  }
  return db
    .prepare(
      `INSERT INTO cloud_customer_host_verification_challenges
         (hostname, tenant_id, challenge_id, token_hash, created_at_ms, expires_at_ms, attempts)
       SELECT ?, t.id, ?, ?, ?, ?, 0
         FROM tenants t
        WHERE t.id = ? AND t.kind = 'customer' AND t.is_active = 1
          ${portalAuthorization ? `AND ${portalSessionPredicate()}` : ""}
          AND NOT EXISTS (
            SELECT 1 FROM cloud_verified_customer_hosts h WHERE h.hostname = ?
          )
       ON CONFLICT(hostname) DO UPDATE SET
         challenge_id = excluded.challenge_id,
         token_hash = excluded.token_hash,
         created_at_ms = excluded.created_at_ms,
         expires_at_ms = excluded.expires_at_ms,
         attempts = 0
       WHERE cloud_customer_host_verification_challenges.tenant_id = excluded.tenant_id
         AND (cloud_customer_host_verification_challenges.expires_at_ms <= ? OR ? = 1)
         AND NOT EXISTS (
           SELECT 1 FROM cloud_verified_customer_hosts h WHERE h.hostname = excluded.hostname
         )`
    )
    .bind(
      hostname,
      input.challengeId,
      input.tokenHash,
      input.createdAtMs,
      input.expiresAtMs,
      input.tenantId,
      ...(portalAuthorization ? portalSessionBindings(portalAuthorization) : []),
      hostname,
      input.createdAtMs,
      replaceActiveChallenge ? 1 : 0
    );
}

export async function getCustomerHostVerificationChallenge(
  db: CloudDb,
  hostnameValue: string
): Promise<CloudCustomerHostVerificationChallenge | null> {
  const hostname = normalizeCustomerHostname(hostnameValue);
  if (!hostname) return null;
  const row = await db
    .prepare<HostVerificationChallengeRow>(
      `SELECT hostname, tenant_id, challenge_id, token_hash, created_at_ms, expires_at_ms, attempts
         FROM cloud_customer_host_verification_challenges
        WHERE hostname = ? LIMIT 1`
    )
    .bind(hostname)
    .first<HostVerificationChallengeRow>();
  return row ? mapHostVerificationChallenge(row) : null;
}

export function prepareCustomerHostVerificationAttemptUpdate(
  db: CloudDb,
  input: { hostname: string; tenantId: string; challengeId: string; nowMs: number },
  portalAuthorization?: CloudCustomerHostPortalAuthorization
) {
  return db
    .prepare(
      `UPDATE cloud_customer_host_verification_challenges
          SET attempts = attempts + 1
        WHERE hostname = ? AND tenant_id = ? AND challenge_id = ?
          AND expires_at_ms > ? AND attempts < 5
          ${portalAuthorization ? `AND ${portalSessionPredicate()}` : ""}`
    )
    .bind(
      input.hostname,
      input.tenantId,
      input.challengeId,
      input.nowMs,
      ...(portalAuthorization ? portalSessionBindings(portalAuthorization) : [])
    );
}

export function prepareDnsVerifiedCustomerHostInsert(
  db: CloudDb,
  input: {
    hostname: string;
    tenantId: string;
    challengeId: string;
    tokenHash: string;
    verifiedAt: string;
    nowMs: number;
    verifiedBy?: string;
  },
  portalAuthorization?: CloudCustomerHostPortalAuthorization
) {
  return db
    .prepare(
      `INSERT INTO cloud_verified_customer_hosts
         (hostname, tenant_id, verified_at, verified_by, created_at)
       SELECT c.hostname, c.tenant_id, ?, ?, ?
         FROM cloud_customer_host_verification_challenges c
         JOIN tenants t ON t.id = c.tenant_id
        WHERE c.hostname = ? AND c.tenant_id = ? AND c.challenge_id = ?
          AND c.token_hash = ? AND c.expires_at_ms > ? AND c.attempts < 5
          AND t.kind = 'customer' AND t.is_active = 1
          ${portalAuthorization ? `AND ${portalSessionPredicate()}` : ""}`
    )
    .bind(
      input.verifiedAt,
      input.verifiedBy ?? "dns-txt",
      input.verifiedAt,
      input.hostname,
      input.tenantId,
      input.challengeId,
      input.tokenHash,
      input.nowMs,
      ...(portalAuthorization ? portalSessionBindings(portalAuthorization) : [])
    );
}

export function prepareCustomerHostVerificationChallengeDelete(
  db: CloudDb,
  input: {
    hostname: string;
    tenantId: string;
    challengeId: string;
    tokenHash: string;
    nowMs: number;
  },
  portalAuthorization?: CloudCustomerHostPortalAuthorization
) {
  return db
    .prepare(
      `DELETE FROM cloud_customer_host_verification_challenges
        WHERE hostname = ? AND tenant_id = ? AND challenge_id = ? AND token_hash = ?
          AND expires_at_ms > ? AND attempts < 5
          AND EXISTS (SELECT 1 FROM cloud_verified_customer_hosts h WHERE h.hostname = ?)
          ${portalAuthorization ? `AND ${portalSessionPredicate()}` : ""}`
    )
    .bind(
      input.hostname,
      input.tenantId,
      input.challengeId,
      input.tokenHash,
      input.nowMs,
      input.hostname,
      ...(portalAuthorization ? portalSessionBindings(portalAuthorization) : [])
    );
}

function portalSessionPredicate(): string {
  return `EXISTS (
    SELECT 1 FROM cloud_tenant_oidc_sessions s
    JOIN cloud_customer_memberships m
      ON m.tenant_id = s.tenant_id AND m.id = s.membership_id
    JOIN cloud_tenant_oidc_identities i
      ON i.tenant_id = s.tenant_id AND i.id = s.identity_id AND i.membership_id = s.membership_id
    JOIN cloud_tenant_oidc_configs c
      ON c.tenant_id = i.tenant_id AND c.issuer = i.issuer AND c.is_enabled = 1
    JOIN tenants t ON t.id = s.tenant_id AND t.kind = 'customer' AND t.is_active = 1
    WHERE s.token_hash = ? AND s.tenant_id = ? AND s.membership_id = ?
      AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ?
      AND m.is_active = 1 AND m.role IN ('owner', 'admin')
  )`;
}

function portalSessionBindings(authorization: CloudCustomerHostPortalAuthorization): unknown[] {
  return [
    authorization.sessionTokenHash,
    authorization.tenantId,
    authorization.membershipId,
    authorization.nowMs,
  ];
}

export async function listAdminVerifiedCustomerHosts(
  db: CloudDb,
  tenantId: string
): Promise<CloudAdminVerifiedCustomerHost[]> {
  const result = await db
    .prepare<HostRow>(
      `SELECT h.hostname, h.tenant_id, h.verified_at, h.verified_by, h.created_at
         FROM cloud_verified_customer_hosts h
         JOIN tenants t ON t.id = h.tenant_id
        WHERE h.tenant_id = ? AND t.kind = 'customer'
        ORDER BY h.hostname`
    )
    .bind(tenantId)
    .all<HostRow>();
  if (!result.success) throw new Error("D1 customer host list failed");
  return result.results.map(mapHost);
}

export async function getAdminVerifiedCustomerHost(
  db: CloudDb,
  hostnameValue: string
): Promise<CloudAdminVerifiedCustomerHost | null> {
  const hostname = normalizeCustomerHostname(hostnameValue);
  if (!hostname) return null;
  const row = await db
    .prepare<HostRow>(
      `SELECT h.hostname, h.tenant_id, h.verified_at, h.verified_by, h.created_at
         FROM cloud_verified_customer_hosts h
         JOIN tenants t ON t.id = h.tenant_id
        WHERE h.hostname = ? AND t.kind = 'customer' AND t.is_active = 1
        LIMIT 1`
    )
    .bind(hostname)
    .first<HostRow>();
  return row ? mapHost(row) : null;
}

export async function removeAdminVerifiedCustomerHost(
  db: CloudDb,
  hostnameValue: string,
  tenantId: string
): Promise<boolean> {
  const result = await prepareRemoveAdminVerifiedCustomerHost(db, hostnameValue, tenantId).run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}

export function prepareRemoveAdminVerifiedCustomerHost(
  db: CloudDb,
  hostnameValue: string,
  tenantId: string
) {
  const hostname = normalizeCustomerHostname(hostnameValue);
  if (!hostname) throw new TypeError("Invalid customer hostname");
  return db
    .prepare("DELETE FROM cloud_verified_customer_hosts WHERE hostname = ? AND tenant_id = ?")
    .bind(hostname, tenantId);
}
