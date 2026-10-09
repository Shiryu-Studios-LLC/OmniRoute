import type { CloudDb } from "./db";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CURSOR_LENGTH = 512;

export interface CloudTenantPortalMember {
  id: string;
  role: "owner" | "admin" | "member" | "viewer";
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MembershipRow {
  id: string;
  role: CloudTenantPortalMember["role"];
  is_active: number;
  created_at: string;
  updated_at: string;
}

function encodeCursor(createdAt: string, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ createdAt, id }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  if (cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new TypeError("Invalid membership cursor");
  }
  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !value ||
      typeof value !== "object" ||
      !("createdAt" in value) ||
      !("id" in value) ||
      typeof value.createdAt !== "string" ||
      typeof value.id !== "string" ||
      !ID_PATTERN.test(value.id) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt
    ) {
      throw new TypeError("Invalid membership cursor");
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new TypeError("Invalid membership cursor");
  }
}

export async function listCloudTenantPortalMembers(
  db: CloudDb,
  tenantId: string,
  limit = 50,
  cursor?: string
): Promise<{ members: CloudTenantPortalMember[]; nextCursor: string | null }> {
  if (!ID_PATTERN.test(tenantId)) throw new TypeError("Invalid tenant ID");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Membership page limit must be between 1 and 100");
  }
  const after = cursor === undefined ? null : decodeCursor(cursor);
  const rows = await db
    .prepare<MembershipRow>(
      `SELECT id, role, is_active, created_at, updated_at
         FROM cloud_customer_memberships
        WHERE tenant_id = ?
          AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
        ORDER BY created_at ASC, id ASC LIMIT ?`
    )
    .bind(
      tenantId,
      after?.createdAt ?? null,
      after?.createdAt ?? null,
      after?.createdAt ?? null,
      after?.id ?? null,
      limit + 1
    )
    .all();
  if (!rows.success) throw new Error("D1 tenant membership list failed");
  const page = rows.results.slice(0, limit);
  const members = page.map((row) => ({
    id: row.id,
    role: row.role,
    isActive: row.is_active !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const last = page.at(-1);
  return {
    members,
    nextCursor: rows.results.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}
