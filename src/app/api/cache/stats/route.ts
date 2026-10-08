import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { clearMemoryCache, getMemoryCacheStats } from "@/lib/semanticCache";
import { requirePlatformAdminManagement } from "@/lib/api/platformAdminAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export async function GET(req: NextRequest) {
  const authError = await requirePlatformAdminManagement(req);
  if (authError) return authError;

  try {
    return NextResponse.json(getMemoryCacheStats());
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const authError = await requirePlatformAdminManagement(req);
  if (authError) return authError;

  try {
    clearMemoryCache();
    return NextResponse.json({ success: true, message: "Cache cleared" });
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
