import { NextResponse } from "next/server";
import { getComboBuilderOptions } from "@/lib/combos/builderOptions";
import { withManagementTenantContext } from "@/lib/api/requireManagementAuth";

export async function GET(request: Request) {
  return withManagementTenantContext(request, async () => {
    try {
      const options = await getComboBuilderOptions();
      return NextResponse.json(options);
    } catch (error) {
      console.log("Error fetching combo builder options:", error);
      return NextResponse.json({ error: "Failed to fetch combo builder options" }, { status: 500 });
    }
  });
}
