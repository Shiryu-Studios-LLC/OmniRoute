import { NextResponse } from "next/server";
import { requirePlatformAdminManagement } from "@/lib/api/platformAdminAuth";

/**
 * @deprecated Use /api/rate-limits instead.
 * This route redirects to the consolidated rate-limits endpoint.
 */

export async function GET(request: Request) {
  const authError = await requirePlatformAdminManagement(request);
  if (authError) return authError;

  const url = new URL(request.url);
  url.pathname = "/api/rate-limits";
  return NextResponse.redirect(url, 308);
}

export async function POST(request: Request) {
  const authError = await requirePlatformAdminManagement(request);
  if (authError) return authError;

  const url = new URL(request.url);
  url.pathname = "/api/rate-limits";
  return NextResponse.redirect(url, 308);
}
