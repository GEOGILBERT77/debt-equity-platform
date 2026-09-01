import { NextRequest, NextResponse } from "next/server";
import {
  classifyEsppPlan,
  computeEsppGrantDateFairValue,
  buildEsppPurchaseEntry,
  EsppPlanTerms,
  EsppFairValueInputs,
} from "@/lib/accounting/espp";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/espp
 *   { "mode": "CLASSIFY", "discountPercent", "hasLookback", "substantiallyAllEmployeesEligible",
 *     "discountJustifiedAboveSafeHarbor"? }
 *   { "mode": "FAIR_VALUE", "hasLookback", "grantDateStockPrice", "discountPercent",
 *     "riskFreeRate", "volatility"? (required if hasLookback), "offeringPeriodYears", "dividendYield"? }
 *   { "mode": "PURCHASE_ENTRY", "purchaseDate", "quantityPurchased", "purchasePricePerUnit",
 *     "grantDateFairValuePerUnit" (0 for a noncompensatory plan) }
 *
 * ASC 718-50 employee stock purchase plans — the noncompensatory-vs-compensatory
 * classification test, the look-back/discount-only grant-date fair value, and the
 * purchase-date journal entry. See espp.ts's module doc comment for the full mechanics
 * and what's deliberately out of scope (multi-period reset offerings, mid-offering
 * withdrawal optionality, the IRC 423(b)(8) $25,000 limit).
 *
 * A CALCULATOR, same pattern as the other /api/reports/* calculators here. Still
 * requires a logged-in user.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { mode } = body ?? {};

  try {
    if (mode === "CLASSIFY") {
      if (body.discountPercent === undefined || body.hasLookback === undefined || body.substantiallyAllEmployeesEligible === undefined) {
        return NextResponse.json(
          { error: `"discountPercent", "hasLookback", and "substantiallyAllEmployeesEligible" are required for mode CLASSIFY` },
          { status: 400 }
        );
      }
      const result = classifyEsppPlan(body as EsppPlanTerms);
      return NextResponse.json({ mode, ...result });
    }

    if (mode === "FAIR_VALUE") {
      const required = ["hasLookback", "grantDateStockPrice", "discountPercent", "riskFreeRate", "offeringPeriodYears"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode FAIR_VALUE` }, { status: 400 });
        }
      }
      const fairValue = computeEsppGrantDateFairValue(body as EsppFairValueInputs);
      return NextResponse.json({ mode, grantDateFairValuePerUnit: fairValue.toFixed(4) });
    }

    if (mode === "PURCHASE_ENTRY") {
      const required = ["purchaseDate", "quantityPurchased", "purchasePricePerUnit", "grantDateFairValuePerUnit"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode PURCHASE_ENTRY` }, { status: 400 });
        }
      }
      const entry = buildEsppPurchaseEntry({
        purchaseDate: body.purchaseDate,
        quantityPurchased: body.quantityPurchased,
        purchasePricePerUnit: body.purchasePricePerUnit,
        grantDateFairValuePerUnit: body.grantDateFairValuePerUnit,
      });
      return NextResponse.json({
        mode,
        entry: {
          date: entry.date,
          description: entry.description,
          ascReference: entry.ascReference,
          lines: entry.lines.map((l) => ({
            account: l.account,
            debit: l.debit?.toFixed(2),
            credit: l.credit?.toFixed(2),
            memo: l.memo,
          })),
        },
      });
    }

    return NextResponse.json({ error: `"mode" must be one of CLASSIFY, FAIR_VALUE, PURCHASE_ENTRY` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the ESPP result" }, { status: 400 });
  }
}
