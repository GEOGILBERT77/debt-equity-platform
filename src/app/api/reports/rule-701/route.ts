import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { computeRule701RollingWindow, Rule701Grant, Rule701SecurityType } from "@/lib/accounting/rule701";
import { ServiceConditionGrant } from "@/lib/accounting/vesting";

/**
 * GET /api/reports/rule-701?entityId=...&asOfDate=YYYY-MM-DD&totalAssets=...
 *
 * The real, entity-scoped counterpart to the tax page's ad hoc calculators: reads
 * this entity's actual STOCK_OPTION/RSU/RESTRICTED_STOCK grants (every one that
 * shares the `ServiceConditionGrant` terms shape — see vesting.ts) and runs them
 * through rule701.ts's rolling-12-month aggregate.
 *
 * SCOPE, DELIBERATE: COMMON_STOCK and WARRANT are NOT included, even though
 * rule701.ts's engine supports both as security types. Rule 701 exists specifically
 * for COMPENSATORY benefit plans (employees, directors, consultants, advisors) — a
 * direct COMMON_STOCK issuance to an investor isn't a Rule 701 sale at all in the
 * ordinary case, and this platform's `CommonStockTerms` (capTable.ts) doesn't even
 * carry a per-unit price to value one with. A WARRANT is likewise typically issued to
 * a lender or investor in this platform's actual usage, not as employee
 * compensation. Including either here by default would risk overstating a real
 * company's Rule 701 exposure with instruments that were never sold under Rule 701's
 * exemption in the first place. rule701.ts's engine still accepts both types directly
 * for the rarer case where one genuinely was a compensatory grant.
 *
 * A GRANT WITH NO strikePrice (RSU, RESTRICTED_STOCK, or an early-exercise/
 * RESTRICTED_STOCK-typed award) omits `exercisePricePerUnit` entirely, which
 * `computeRule701GrantSalesPrice` correctly treats as "value at fair market value
 * only, no exercise-price comparison" — see that function's own doc comment.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest) {
  const entityId = req.nextUrl.searchParams.get("entityId");
  if (!entityId) {
    return NextResponse.json({ error: "entityId query parameter is required" }, { status: 400 });
  }

  const access = await requireApiEntityAccess(req, entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  const asOfDate = req.nextUrl.searchParams.get("asOfDate") ?? new Date().toISOString().slice(0, 10);
  const totalAssetsParam = req.nextUrl.searchParams.get("totalAssets");
  const totalAssets = totalAssetsParam ? totalAssetsParam : undefined;

  const instruments = await db.instrument.findMany({
    where: { entityId, type: { in: ["STOCK_OPTION", "RSU", "RESTRICTED_STOCK"] } },
    select: {
      id: true,
      type: true,
      stakeholder: { select: { name: true } },
      termVersions: { select: { terms: true }, orderBy: { effectiveDate: "asc" }, take: 1 },
    },
  });

  const grants: (Rule701Grant & { stakeholderName: string })[] = [];
  const skipped: { instrumentId: string; reason: string }[] = [];
  for (const inst of instruments) {
    const terms = inst.termVersions[0]?.terms as ServiceConditionGrant | undefined;
    if (!terms || terms.grantDate === undefined || terms.quantity === undefined || terms.grantDateFairValuePerUnit === undefined) {
      skipped.push({ instrumentId: inst.id, reason: "No term version with a complete grant date/quantity/fair value on file." });
      continue;
    }
    grants.push({
      id: inst.id,
      type: inst.type as Rule701SecurityType,
      grantDate: terms.grantDate,
      quantity: terms.quantity,
      fairMarketValuePerUnitAtGrant: terms.grantDateFairValuePerUnit,
      exercisePricePerUnit: inst.type === "STOCK_OPTION" ? terms.strikePrice : undefined,
      stakeholderName: inst.stakeholder.name,
    });
  }

  const result = computeRule701RollingWindow({ asOfDate, grants, totalAssets });

  // Attach the stakeholder name back onto each in-window grant for display — the
  // engine itself has no idea what a "stakeholder" is (see rule701.ts's own scope),
  // so this join happens here, at the report layer, same separation of concerns as
  // every other report in this app.
  const nameById = new Map(grants.map((g) => [g.id, g.stakeholderName]));
  const grantsInWindow = result.grantsInWindow.map((g) => ({ ...g, stakeholderName: nameById.get(g.grantId) ?? "(unknown)" }));

  return NextResponse.json({
    asOfDate,
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
    grantsInWindow,
    skippedInstruments: skipped,
    aggregateSalesPriceInWindow: result.aggregateSalesPriceInWindow.toFixed(2),
    disclosureThreshold: result.disclosureThreshold.toFixed(2),
    exceedsDisclosureThreshold: result.exceedsDisclosureThreshold,
    headroomBeforeDisclosureThreshold: result.headroomBeforeDisclosureThreshold.toFixed(2),
    eligibilityCeiling: result.eligibilityCeiling.toFixed(2),
    eligibilityCeilingBasis: result.eligibilityCeilingBasis,
    thirdProngNotComputed: result.thirdProngNotComputed,
    exceedsEligibilityCeiling: result.exceedsEligibilityCeiling,
  });
}
