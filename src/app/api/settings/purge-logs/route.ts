import { NextResponse } from "next/server";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { getCallLogRetentionDays } from "@/lib/logEnv";
import { deleteCallLogsBefore } from "@/lib/usage/callLogs";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    const retentionMs = getCallLogRetentionDays() * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const result = deleteCallLogsBefore(cutoff);
    return NextResponse.json({
      deleted: result.deletedRows,
      deletedArtifacts: result.deletedArtifacts,
    });
  } catch {
    return NextResponse.json(buildErrorBody(500, "Failed to purge call logs"), { status: 500 });
  }
}
