import {
  prepareCloudComplianceAuditInsert,
  type CloudComplianceAuditInput,
} from "./complianceAudit";
import type { CloudDb } from "./db";

export interface CloudCustomerBusinessProfile {
  tenantId: string;
  name: string;
  description: string;
  hours: string;
  services: Array<{ name: string; price: string }>;
  assistant: { name: string; tone: string; handoff: string };
  createdAt: string;
  updatedAt: string;
}

interface ProfileRow {
  tenant_id: string;
  name: string;
  description: string;
  hours: string;
  services_json: string;
  assistant_name: string;
  assistant_tone: string;
  assistant_handoff: string;
  created_at: string;
  updated_at: string;
}

function mapProfile(row: ProfileRow): CloudCustomerBusinessProfile {
  return {
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    hours: row.hours,
    services: JSON.parse(row.services_json) as CloudCustomerBusinessProfile["services"],
    assistant: {
      name: row.assistant_name,
      tone: row.assistant_tone,
      handoff: row.assistant_handoff,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCloudCustomerBusinessProfile(
  db: CloudDb,
  tenantId: string
): Promise<CloudCustomerBusinessProfile | null> {
  const row = await db
    .prepare<ProfileRow>(
      `SELECT tenant_id, name, description, hours, services_json, assistant_name,
              assistant_tone, assistant_handoff, created_at, updated_at
         FROM cloud_tenant_business_profiles WHERE tenant_id = ? LIMIT 1`
    )
    .bind(tenantId)
    .first<ProfileRow>();
  return row ? mapProfile(row) : null;
}

export async function updateCloudCustomerBusinessProfile(
  db: CloudDb,
  input: {
    tenantId: string;
    membershipId: string;
    authorization:
      { type: "api_key"; apiKeyId: string } | { type: "oidc_session"; sessionTokenHash: string };
    profile: Omit<CloudCustomerBusinessProfile, "tenantId" | "createdAt" | "updatedAt">;
    updatedAt: string;
    audit: CloudComplianceAuditInput;
  }
): Promise<CloudCustomerBusinessProfile | null> {
  const profile = input.profile;
  if (input.audit.tenantId !== input.tenantId) {
    throw new TypeError("Business profile audit tenant must match the target tenant");
  }
  const authorization = profileAuthorizationPredicate("profile", input, input.updatedAt);
  const authorizedTarget = `EXISTS (
    SELECT 1 FROM cloud_tenant_business_profiles profile
     WHERE profile.tenant_id = ? AND ${authorization.sql}
  )`;
  const canUpdate = await db
    .prepare<{ allowed: number }>(
      `SELECT 1 AS allowed FROM cloud_tenant_business_profiles profile
        WHERE profile.tenant_id = ? AND ${authorization.sql} LIMIT 1`
    )
    .bind(input.tenantId, ...authorization.values)
    .first();
  if (!canUpdate) return null;

  const preparedAudit = prepareCloudComplianceAuditInsert(db, input.audit, {
    where: { sql: authorizedTarget, values: [input.tenantId, ...authorization.values] },
  });
  const result = await db.batch([
    preparedAudit.statement,
    db
      .prepare(
        `UPDATE cloud_tenant_business_profiles AS profile
            SET name = ?, description = ?, hours = ?, services_json = ?, assistant_name = ?,
                assistant_tone = ?, assistant_handoff = ?, updated_at = ?,
                configured_at = COALESCE(configured_at, ?)
          WHERE profile.tenant_id = ?
            AND ${authorization.sql}
            AND changes() = 1
            AND EXISTS (
              SELECT 1 FROM cloud_compliance_audit audit
               WHERE audit.id = ? AND audit.tenant_id = profile.tenant_id
                 AND audit.action = ?
            )`
      )
      .bind(
        profile.name,
        profile.description,
        profile.hours,
        JSON.stringify(profile.services),
        profile.assistant.name,
        profile.assistant.tone,
        profile.assistant.handoff,
        input.updatedAt,
        input.updatedAt,
        input.tenantId,
        ...authorization.values,
        preparedAudit.record.id,
        preparedAudit.record.action
      ),
    db
      .prepare(
        `INSERT INTO cloud_tenant_business_profiles (
           tenant_id, name, description, hours, services_json, assistant_name,
           assistant_tone, assistant_handoff, created_at, updated_at, configured_at
         )
         SELECT profile.tenant_id, profile.name, profile.description, profile.hours,
                profile.services_json, profile.assistant_name, profile.assistant_tone,
                profile.assistant_handoff, profile.created_at, profile.updated_at,
                profile.configured_at
           FROM cloud_tenant_business_profiles profile
          WHERE profile.tenant_id = ? AND changes() != 1
            AND EXISTS (
              SELECT 1 FROM cloud_compliance_audit audit
               WHERE audit.id = ? AND audit.tenant_id = profile.tenant_id
                 AND audit.action = ?
            )`
      )
      .bind(input.tenantId, preparedAudit.record.id, preparedAudit.record.action),
  ]);
  const auditResult = result[0];
  const updateResult = result[1];
  const guardResult = result[2];
  if (
    result.length !== 3 ||
    !isSuccessfulBatchResult(auditResult) ||
    !isSuccessfulBatchResult(updateResult) ||
    !isSuccessfulBatchResult(guardResult)
  ) {
    throw new Error("D1 customer business profile update batch failed");
  }
  const changes =
    "meta" in updateResult && typeof updateResult.meta === "object" && updateResult.meta !== null
      ? Number((updateResult.meta as { changes?: unknown }).changes)
      : Number.NaN;
  if (!Number.isSafeInteger(changes) || changes < 0) {
    throw new Error("D1 customer business profile update returned invalid state");
  }
  const auditChanges =
    "meta" in auditResult && typeof auditResult.meta === "object" && auditResult.meta !== null
      ? (auditResult.meta as { changes?: unknown }).changes
      : undefined;
  const guardChanges =
    "meta" in guardResult && typeof guardResult.meta === "object" && guardResult.meta !== null
      ? (guardResult.meta as { changes?: unknown }).changes
      : undefined;
  if (changes !== 1 || auditChanges !== 1 || guardChanges !== 0) {
    throw new Error("D1 customer business profile audit and update were not completed together");
  }
  return getCloudCustomerBusinessProfile(db, input.tenantId);
}

function profileAuthorizationPredicate(
  profileAlias: string,
  input: {
    membershipId: string;
    authorization:
      { type: "api_key"; apiKeyId: string } | { type: "oidc_session"; sessionTokenHash: string };
  },
  now: string
): { sql: string; values: unknown[] } {
  const credentialCheck =
    input.authorization.type === "api_key"
      ? `EXISTS (
          SELECT 1 FROM cloud_customer_api_keys api_key
           WHERE api_key.tenant_id = membership.tenant_id
             AND api_key.membership_id = membership.id
             AND api_key.id = ? AND api_key.revoked_at IS NULL
             AND (api_key.expires_at IS NULL OR api_key.expires_at > ?)
        )`
      : `EXISTS (
          SELECT 1 FROM cloud_tenant_oidc_sessions session
           WHERE session.tenant_id = membership.tenant_id
             AND session.membership_id = membership.id
             AND session.token_hash = ? AND session.revoked_at_ms IS NULL
             AND session.expires_at_ms > ?
        )`;
  return {
    sql: `EXISTS (
      SELECT 1 FROM cloud_customer_memberships membership
      JOIN tenants tenant ON tenant.id = membership.tenant_id
       WHERE membership.tenant_id = ${profileAlias}.tenant_id
         AND membership.id = ? AND membership.is_active = 1
         AND membership.role IN ('owner', 'admin')
         AND tenant.kind = 'customer' AND tenant.is_active = 1
         AND ${credentialCheck}
    )`,
    values: [
      input.membershipId,
      input.authorization.type === "api_key"
        ? input.authorization.apiKeyId
        : input.authorization.sessionTokenHash,
      input.authorization.type === "api_key" ? now : Date.parse(now),
    ],
  };
}

function isSuccessfulBatchResult(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && "success" in value && value.success === true
  );
}
