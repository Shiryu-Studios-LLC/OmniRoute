import { NextResponse } from "next/server";
import { withPlatformAdminManagementContext } from "@/lib/api/requireManagementAuth";

/**
 * POST /api/providers/volcengine-plan/connect/[sessionId]/resend
 * Re-trigger the SMS verification code for an active login session.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<NextResponse> {
  return withPlatformAdminManagementContext(request, async () => {
    const { sessionId } = await params;

    try {
      const { volcengineConsoleAutoLoginService } =
        await import("@omniroute/open-sse/services/volcengineConsoleAutoLogin.ts");
      const session = await volcengineConsoleAutoLoginService.resendCode(sessionId);
      if (!session) {
        return NextResponse.json(
          { success: false, error: "Unknown or expired Volcano login session" },
          { status: 404 }
        );
      }
      return NextResponse.json({ success: true, session });
    } catch {
      return NextResponse.json({ success: false, error: "Resend failed" }, { status: 500 });
    }
  });
}
