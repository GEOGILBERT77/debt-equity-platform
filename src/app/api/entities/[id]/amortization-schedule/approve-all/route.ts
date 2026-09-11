import { NextRequest, NextResponse } from "next/server";
import { approveAllAmortizationSchedulesForEntity } from "@/lib/db/amortizationSchedule";
import { isServiceConditionType, SERVICE_CONDITION_TYPES } from "@/lib/db/bulkUploadServiceConditionGrants";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/entities/:id/amortization-schedule/approve-all?type=STOCK_OPTION
 *
 * Entity-wide counterpart to POST /api/instruments/:id/amortization-schedule — runs
 * approveAmortizationSchedule across every instrument of the given type in this
 * entity instead of one at a time, so a large batch of grants (bulk-uploaded or
 * entered by hand) can be approved and rolled into /reports/stock-option-amortization
 * in one action. `type` must be one of STOCK_OPTION, RSU, or RESTRICTED_STOCK — reuses
 * the same SERVICE_CONDITION_TYPES set bulk upload validates against, since those are
 * exactly the types a full monthly amortization table is a meaningful concept for.
 *
 * EDITOR-or-above, same bar as approving one instrument's schedule — an unreviewed
 * number shouldn't feed a company-wide report, whether it got there one grant or a
 * hundred at a time.
 *
 * Returns a per-instrument breakdown (approved / skipped-current / error), same
 * "never one opaque pass/fail" reasoning as POST /api/entities/:id/close.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const type = req.nextUrl.searchParams.get("type") ?? "";
  if (!isServiceConditionType(type)) {
    return NextResponse.json({ error: `type query parameter must be one of: ${SERVICE_CONDITION_TYPES.join(", ")}` }, { status: 400 });
  }

  const results = await approveAllAmortizationSchedulesForEntity(params.id, type, access.user.id);

  const approved = results.filter((r) => r.status === "approved");
  const skipped = results.filter((r) => r.status === "skipped-current");
  const errors = results.filter((r) => r.status === "error");

  return NextResponse.json({
    totalInstruments: results.length,
    approvedCount: approved.length,
    skippedCount: skipped.length,
    errorCount: errors.length,
    results,
  });
}
