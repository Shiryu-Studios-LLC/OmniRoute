import { NextResponse } from "next/server";
import { getCostSummary, setBudget, checkBudget } from "@/domain/costRules";
import { setBudgetSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyById } from "@/lib/db/apiKeys";
import { getManagementTenantId } from "@/lib/api/managementTenant";

export async function GET(request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const apiKeyId = searchParams.get("apiKeyId");
    if (!apiKeyId) {
      return NextResponse.json({ error: "apiKeyId query param is required" }, { status: 400 });
    }
    if (!(await getApiKeyById(apiKeyId, await getManagementTenantId(request)))) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }
    const summary = getCostSummary(apiKeyId);
    const budgetCheck = checkBudget(apiKeyId);
    return NextResponse.json({
      ...summary,
      budgetCheck,
      dailyLimitUsd: summary.dailyLimitUsd,
      weeklyLimitUsd: summary.weeklyLimitUsd,
      monthlyLimitUsd: summary.monthlyLimitUsd,
      warningThreshold: summary.warningThreshold,
      resetInterval: summary.resetInterval,
      resetTime: summary.resetTime,
      budgetResetAt: summary.budgetResetAt,
      lastBudgetResetAt: summary.lastBudgetResetAt,
      totalCostToday: summary.totalCostToday,
      totalCostMonth: summary.totalCostMonth,
      totalCostPeriod: summary.totalCostPeriod,
      activeLimitUsd: summary.activeLimitUsd,
      nextResetAt: summary.nextResetAt,
      periodStartAt: summary.periodStartAt,
    });
  } catch (error) {
    console.error("Error fetching budget summary:", error);
    return NextResponse.json({ error: "Failed to fetch budget summary" }, { status: 500 });
  }
}

export async function POST(request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(setBudgetSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    if (!(await getApiKeyById(validation.data.apiKeyId, await getManagementTenantId(request)))) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }
    const {
      apiKeyId,
      dailyLimitUsd,
      weeklyLimitUsd,
      monthlyLimitUsd,
      warningThreshold,
      resetInterval,
      resetTime,
    } = validation.data;

    const budget = setBudget(apiKeyId, {
      dailyLimitUsd,
      weeklyLimitUsd,
      monthlyLimitUsd,
      warningThreshold,
      resetInterval,
      resetTime,
    });
    return NextResponse.json({ success: true, apiKeyId, budget });
  } catch (error) {
    console.error("Error setting budget:", error);
    return NextResponse.json({ error: "Failed to set budget" }, { status: 500 });
  }
}
