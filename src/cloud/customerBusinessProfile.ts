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
    apiKeyId: string;
    profile: Omit<CloudCustomerBusinessProfile, "tenantId" | "createdAt" | "updatedAt">;
    updatedAt: string;
    audit: CloudComplianceAuditInput;
  }
): Promise<CloudCustomerBusinessProfile | null> {
  const profile = input.profile;
  const result = await db.batch([
    db
      .prepare(
        `UPDATE cloud_tenant_business_profiles
            SET name = ?, description = ?, hours = ?, services_json = ?, assistant_name = ?,
                assistant_tone = ?, assistant_handoff = ?, updated_at = ?,
                configured_at = COALESCE(configured_at, ?)
          WHERE tenant_id = ?
            AND EXISTS (
              SELECT 1 FROM cloud_customer_memberships m
              JOIN cloud_customer_api_keys k
                ON k.tenant_id = m.tenant_id AND k.membership_id = m.id
              JOIN tenants t ON t.id = m.tenant_id
              WHERE m.tenant_id = cloud_tenant_business_profiles.tenant_id
                AND m.id = ? AND m.is_active = 1 AND m.role IN ('owner', 'admin')
                AND k.id = ? AND k.revoked_at IS NULL
                AND (k.expires_at IS NULL OR k.expires_at > ?)
                AND t.kind = 'customer' AND t.is_active = 1
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
        input.membershipId,
        input.apiKeyId,
        input.updatedAt
      ),
    prepareCloudComplianceAuditInsert(db, input.audit, {
      requirePreviousStatementChange: true,
    }).statement,
  ]);
  const changes =
    typeof result[0] === "object" && result[0] !== null && "meta" in result[0]
      ? Number((result[0] as { meta?: { changes?: unknown } }).meta?.changes)
      : Number.NaN;
  if (changes !== 1) return null;
  return getCloudCustomerBusinessProfile(db, input.tenantId);
}
