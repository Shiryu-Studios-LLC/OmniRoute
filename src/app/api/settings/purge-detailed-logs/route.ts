import { NextResponse } from "next/server";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { purgeDetailedLogs } from "@/lib/db/cleanup";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    const result = await purgeDetailedLogs();
    return NextResponse.json({
      deleted: result.deleted,
      errors: result.errors,
    });
  } catch {
    return NextResponse.json(buildErrorBody(500, "Failed to purge detailed logs"), {
      status: 500,
    });
  }
}
