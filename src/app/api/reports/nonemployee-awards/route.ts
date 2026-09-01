import { NextRequest, NextResponse } from "next/server";
import {
  determineNonemployeeVestingTranches,
  buildNonemployeeAwardExpenseSchedule,
  buildNonemployeeAwardRecognitionEntry,
  laterOfRevenueRecognitionOrGrant,
  NonemployeeAwardTerms,
} from "@/lib/accounting/nonemployeeAwards";
import { Decimal } from "@/lib/accounting/types";
import { Period } from "@/lib/accounting/dateMath";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/nonemployee-awards
 *   { "mode": "VESTING_TRANCHES", "grantDate", "quantity", "grantDateFairValuePerUnit",
 *     "counterpartyType", "explicitVestingTranches"? (array of {id, vestDate, quantity}) }
 *   { "mode": "SCHEDULE", "grantDate", "quantity", "grantDateFairValuePerUnit",
 *     "counterpartyType", "explicitVestingTranches"? (array of {id, vestDate, quantity}),
 *     "periods": [{label, start, end}, ...] }
 *   { "mode": "RECOGNITION_ENTRY", "counterpartyType", "row": {periodStart, periodEnd, label, amount} }
 *   { "mode": "CUSTOMER_TIMING", "awardGrantDate", "revenueRecognitionDate" }
 *
 * ASC 718-10 nonemployee share-based payment awards (post-ASU 2018-07) — the
 * requisite-service-period presumption, expense recognition (reusing vesting.ts),
 * the counterparty-dependent recognition account (expense vs. reduction of revenue
 * for a customer, ASU 2019-08/ASC 606-10-32-25), and the ASC 606-10-32-27 timing
 * floor for the customer case. See nonemployeeAwards.ts's module doc comment for the
 * full mechanics and what's deliberately out of scope.
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
    if (mode === "VESTING_TRANCHES") {
      const required = ["grantDate", "quantity", "grantDateFairValuePerUnit", "counterpartyType"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode VESTING_TRANCHES` }, { status: 400 });
        }
      }
      const terms: NonemployeeAwardTerms = {
        grantDate: body.grantDate,
        quantity: body.quantity,
        grantDateFairValuePerUnit: body.grantDateFairValuePerUnit,
        counterpartyType: body.counterpartyType,
        explicitVestingTranches: body.explicitVestingTranches,
      };
      const tranches = determineNonemployeeVestingTranches(terms);
      const totalValue = Decimal.from(terms.quantity).times(terms.grantDateFairValuePerUnit);
      return NextResponse.json({
        mode,
        tranches,
        totalGrantDateFairValue: totalValue.toFixed(2),
        immediatelyRecognized: tranches.length === 1 && tranches[0].vestDate === terms.grantDate,
      });
    }

    if (mode === "SCHEDULE") {
      const required = ["grantDate", "quantity", "grantDateFairValuePerUnit", "counterpartyType", "periods"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode SCHEDULE` }, { status: 400 });
        }
      }
      const terms: NonemployeeAwardTerms = {
        grantDate: body.grantDate,
        quantity: body.quantity,
        grantDateFairValuePerUnit: body.grantDateFairValuePerUnit,
        counterpartyType: body.counterpartyType,
        explicitVestingTranches: body.explicitVestingTranches,
      };
      const tranches = determineNonemployeeVestingTranches(terms);
      const schedule = buildNonemployeeAwardExpenseSchedule(terms, body.periods as Period[]);
      return NextResponse.json({
        mode,
        tranches,
        schedule: schedule.map((r) => ({ label: r.label, periodStart: r.periodStart, periodEnd: r.periodEnd, amount: r.amount.toFixed(2) })),
      });
    }

    if (mode === "RECOGNITION_ENTRY") {
      if (body.counterpartyType === undefined || body.row === undefined) {
        return NextResponse.json({ error: `"counterpartyType" and "row" are required for mode RECOGNITION_ENTRY` }, { status: 400 });
      }
      const entry = buildNonemployeeAwardRecognitionEntry(body.row, body.counterpartyType);
      return NextResponse.json({
        mode,
        entry: {
          date: entry.date,
          description: entry.description,
          ascReference: entry.ascReference,
          lines: entry.lines.map((l) => ({ account: l.account, debit: l.debit?.toFixed(2), credit: l.credit?.toFixed(2), memo: l.memo })),
        },
      });
    }

    if (mode === "CUSTOMER_TIMING") {
      if (body.awardGrantDate === undefined || body.revenueRecognitionDate === undefined) {
        return NextResponse.json({ error: `"awardGrantDate" and "revenueRecognitionDate" are required for mode CUSTOMER_TIMING` }, { status: 400 });
      }
      const date = laterOfRevenueRecognitionOrGrant(body as { awardGrantDate: string; revenueRecognitionDate: string });
      return NextResponse.json({ mode, noEarlierThan: date });
    }

    return NextResponse.json({ error: `"mode" must be one of SCHEDULE, RECOGNITION_ENTRY, CUSTOMER_TIMING` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the nonemployee award result" }, { status: 400 });
  }
}
