import { logAuditEvent } from "@/lib/compliance";
import { runWithTenantContext } from "@/lib/tenantContext";

interface ExpiryAuditStatement {
  run(...params: unknown[]): { changes?: number };
  get(...params: unknown[]): unknown;
}

interface ExpiryAuditDatabase {
  prepare(sql: string): ExpiryAuditStatement;
  transaction<T>(callback: () => T): () => T;
}

/**
 * Record one natural expiration transition for an active API key.
 *
 * The marker claim and audit row share one SQLite transaction. A composite
 * unique key makes simultaneous validators converge on a single event; if
 * audit persistence fails, the marker is rolled back so a later validation
 * can retry it. Explicit expiry changes use their existing lifecycle event.
 */
export function auditNaturalApiKeyExpiry(
  db: ExpiryAuditDatabase,
  input: { id: string; tenantId: string; expiresAt: string }
): boolean {
  const expiryMs = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(expiryMs) ||
    expiryMs > Date.now() ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.tenantId)
  ) {
    return false;
  }

  const expiresAt = new Date(expiryMs).toISOString();
  const detectedAt = new Date().toISOString();
  const details = { tenantId: input.tenantId, expiresAt };
  const serializedDetails = JSON.stringify(details);

  try {
    return db.transaction(() => {
      const claimed = db
        .prepare(
          `INSERT OR IGNORE INTO api_key_expiry_audit_markers (
            tenant_id, api_key_id, expires_at, detected_at
          )
          SELECT tenant_id, id, ?, ? FROM api_keys
          WHERE id = ? AND tenant_id = ? AND expires_at = ?
            AND is_active = 1 AND is_banned = 0 AND revoked_at IS NULL`
        )
        .run(expiresAt, detectedAt, input.id, input.tenantId, input.expiresAt);
      if ((claimed.changes ?? 0) === 0) return false;

      runWithTenantContext({ tenantId: input.tenantId, principalId: "system" }, () => {
        logAuditEvent({
          action: "apiKey.expired",
          actor: "system",
          target: input.id,
          resourceType: "api_key",
          status: "success",
          createdAt: detectedAt,
          details,
        });
      });

      const auditRow = db
        .prepare(
          `SELECT id FROM audit_log
           WHERE timestamp = ? AND action = ? AND target = ? AND details = ? LIMIT 1`
        )
        .get(detectedAt, "apiKey.expired", input.id, serializedDetails);
      if (!auditRow) throw new Error("Natural API-key expiry audit was not persisted");
      return true;
    })();
  } catch {
    // Auth must still reject the expired key when audit storage is unavailable.
    // The transaction rolls back the marker so a later validation can retry.
    return false;
  }
}
