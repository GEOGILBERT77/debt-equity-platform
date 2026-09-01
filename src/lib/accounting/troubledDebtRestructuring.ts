import { Money, money, Decimal, DecimalValue, ISODate, CurrencyCode, ScheduleRow, JournalEntry, JournalLine, assertBalanced } from "./types.js";
import { Period } from "./dateMath.js";
import { solveEffectiveYield } from "./debtAmortization.js";

/**
 * ASC 470-60 troubled debt restructuring (TDR) — a substantively DIFFERENT model from
 * `debtModification.ts`'s ASC 470-50 10% cash flow test, not a variant of it. That
 * module's own doc comment already flags TDR as explicitly out of scope for exactly
 * this reason: a TDR only applies when the CREDITOR grants a concession specifically
 * BECAUSE the debtor is experiencing financial difficulty (ASC 470-60-55-6 through
 * 55-8 walk through the indicators) — an ordinary arm's-length renegotiation, however
 * large a change in terms, is never a TDR regardless of the 470-50 10% test's result.
 * This module assumes that threshold judgment call has already been made by the
 * caller; it does not attempt to detect financial difficulty itself.
 *
 * THE SINGLE POINT MOST OFTEN CONFUSED WITH THE 470-50 TEST, stated up front because
 * it's the whole reason this needs its own module rather than a flag on the other
 * one: `debtModification.ts` discounts both cash-flow streams to present value.
 * ASC 470-60-35-5's test for a TDR that continues as debt (not settled outright)
 * compares the CARRYING VALUE of the debt to the TOTAL FUTURE CASH PAYMENTS,
 * UNDISCOUNTED. No discounting happens in this comparison at all.
 *
 * TWO SCENARIOS, TWO GENUINELY DIFFERENT OUTCOMES (ASC 470-60-35-5 through 35-9):
 *  1. Total future cash payments (undiscounted) is LESS than the current carrying
 *     value: the debtor recognizes a gain immediately, equal to the difference, and
 *     the carrying value is written down to exactly the total future cash payments.
 *     Because the new carrying value now EQUALS the sum of everything left to pay,
 *     there is nothing left to attribute to interest — every future payment is
 *     recognized purely as a reduction of the carrying value, with ZERO interest
 *     expense for the remaining life of the restructured debt. This is the specific
 *     rule `buildTdrReducedCarryingValueSchedule` implements, and it is NOT the same
 *     shape as any other schedule in this codebase (every other debt engine here
 *     recognizes some interest expense every period).
 *  2. Total future cash payments is GREATER THAN OR EQUAL TO the current carrying
 *     value: no gain is recognized at all. Instead, a NEW effective interest rate is
 *     solved for — the rate at which the discounted future cash payments equal the
 *     CURRENT carrying value — and the debt continues on the ordinary effective-
 *     interest model from there. This module does not duplicate that amortization
 *     engine: it reuses `solveEffectiveYield` (already built for exactly this "solve
 *     for the rate that makes a cash-flow stream equal a given present value"
 *     problem) and hands the result straight to `buildEffectiveInterestSchedule` —
 *     the identical function TERM_LOAN already uses — since once the new rate is
 *     known, a TDR that continues as debt amortizes exactly like ordinary term debt.
 *
 * A THIRD SCENARIO — full settlement, not a continuing modification — happens when
 * the creditor accepts assets or an equity interest in FULL satisfaction of the debt
 * (ASC 470-60-35-7/35-9). `buildTdrSettlementEntry` handles that: a gain equal to the
 * debt's carrying value minus the fair value of whatever was transferred. Any
 * gain/loss on the TRANSFERRED ASSET ITSELF (its fair value vs. its own book value,
 * under whatever other GAAP governs that asset) is a separate, prior step this module
 * does not compute — the fair value handed to this function is assumed already
 * determined.
 *
 * OUT OF SCOPE, DELIBERATELY: a PARTIAL settlement (part cash/assets, part continuing
 * modified debt) combines both scenarios above and needs its own composition, not
 * attempted here; and a restructuring that also changes contingent-payment terms
 * (e.g. a payment tied to future revenue) needs its own valuation approach beyond a
 * fixed cash-flow schedule.
 */

export interface TdrModificationTestInput {
  currentCarryingValue: Money;
  /** Every future cash payment under the restructured terms, positional — one entry
   * per future period, UNDISCOUNTED (see the module doc comment for why, unlike
   * `debtModification.ts`'s test). */
  restructuredCashFlows: DecimalValue[];
}

export type TdrModificationOutcome =
  | { kind: "GAIN_RECOGNIZED_IMMEDIATELY"; gain: Money; newCarryingValue: Money }
  | { kind: "NEW_EFFECTIVE_RATE_REQUIRED"; newEffectiveAnnualYield: Money };

/** Runs the ASC 470-60-35-5 undiscounted total-future-cash-payments test and returns
 * which of the two outcomes applies — see the module doc comment for the full
 * reasoning behind each branch. */
export function classifyTdrModification(input: TdrModificationTestInput): TdrModificationOutcome {
  if (input.restructuredCashFlows.length === 0) {
    throw new Error("restructuredCashFlows must contain at least one future payment.");
  }
  const totalFutureCashPayments = input.restructuredCashFlows.reduce<Money>(
    (sum, cf) => sum.plus(cf),
    money(0)
  );

  if (totalFutureCashPayments.lessThan(input.currentCarryingValue)) {
    const gain = input.currentCarryingValue.minus(totalFutureCashPayments);
    return { kind: "GAIN_RECOGNIZED_IMMEDIATELY", gain, newCarryingValue: totalFutureCashPayments };
  }

  const newEffectiveAnnualYield = solveEffectiveYield(input.currentCarryingValue, input.restructuredCashFlows);
  return { kind: "NEW_EFFECTIVE_RATE_REQUIRED", newEffectiveAnnualYield };
}

/** Books the immediate gain for the GAIN_RECOGNIZED_IMMEDIATELY branch: the debt's
 * carrying value is written down to exactly the total future cash payments, with the
 * difference recognized as a gain (ASC 470-60-35-6). */
export function buildTdrGainEntry(
  date: ISODate,
  oldCarryingValue: Money,
  newCarryingValue: Money,
  currency?: CurrencyCode
): JournalEntry {
  const gain = oldCarryingValue.minus(newCarryingValue);
  if (!gain.greaterThan(0)) {
    throw new Error(
      `newCarryingValue (${newCarryingValue.toFixed(2)}) must be less than oldCarryingValue (${oldCarryingValue.toFixed(2)}) — this entry only applies to the GAIN_RECOGNIZED_IMMEDIATELY branch of classifyTdrModification.`
    );
  }
  const entry: JournalEntry = {
    date,
    description: "Troubled debt restructuring — carrying value written down, gain recognized immediately",
    ascReference: "ASC 470-60-35-6",
    currency,
    lines: [
      { account: "Debt Payable (old carrying value)", debit: oldCarryingValue },
      { account: "Debt Payable, Restructured (= total future cash payments)", credit: newCarryingValue },
      { account: "Gain on Troubled Debt Restructuring", credit: gain },
    ],
  };
  assertBalanced(entry);
  return entry;
}

/** The GAIN_RECOGNIZED_IMMEDIATELY branch's ongoing schedule: since the new carrying
 * value equals the exact sum of everything left to pay, every future payment is
 * recognized purely as principal reduction — ZERO interest expense for the remaining
 * life of the restructured debt (ASC 470-60-35-8). Do not run
 * `buildEffectiveInterestSchedule` on this branch's cash flows — there is, by
 * construction, no yield left to solve for or amortize. */
export function buildTdrReducedCarryingValueSchedule(
  newCarryingValue: Money,
  restructuredCashFlows: DecimalValue[],
  periods: Period[]
): ScheduleRow[] {
  if (restructuredCashFlows.length !== periods.length) {
    throw new Error("restructuredCashFlows must have one entry per period.");
  }
  let balance = newCarryingValue;
  return periods.map((p, i) => {
    const payment = Decimal.from(restructuredCashFlows[i]);
    const endingBalance = balance.minus(payment);
    const row: ScheduleRow = {
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: money(0),
      endingBalance,
      meta: {
        ascReference: "ASC 470-60-35-8 (TDR, gain recognized at modification — no further interest expense)",
        cashPaid: payment,
      },
    };
    balance = endingBalance;
    return row;
  });
}

/** Full settlement of debt via a transfer of assets or an equity interest, in FULL
 * satisfaction of the obligation (ASC 470-60-35-7/35-9) — as distinct from a
 * continuing modification (the two functions above). Any gain/loss on the transferred
 * asset ITSELF (its fair value vs. its own book value) is a separate, prior
 * computation this function does not perform — `considerationFairValue` is assumed
 * already determined. `considerationAccountName` should name whatever was actually
 * transferred ("Real Estate, at fair value", "Common Stock and APIC issued to
 * creditor") so the credit side reads correctly for a reviewer. */
export function buildTdrSettlementEntry(
  date: ISODate,
  debtCarryingValue: Money,
  considerationAccountName: string,
  considerationFairValue: Money,
  currency?: CurrencyCode
): { entry: JournalEntry; gainOnRestructuring: Money } {
  const gainOnRestructuring = debtCarryingValue.minus(considerationFairValue);

  const lines: JournalLine[] = [
    { account: "Debt Payable (carrying value, including any accrued interest)", debit: debtCarryingValue },
    { account: considerationAccountName, credit: considerationFairValue },
  ];
  if (gainOnRestructuring.greaterThan(0)) {
    lines.push({ account: "Gain on Troubled Debt Restructuring", credit: gainOnRestructuring });
  } else if (gainOnRestructuring.isNegative()) {
    // Uncommon (the consideration transferred is worth more than the debt it settles)
    // but not impossible — recorded as a loss rather than silently left unbalanced.
    lines.push({ account: "Loss on Troubled Debt Restructuring", debit: gainOnRestructuring.abs() });
  }

  const entry: JournalEntry = {
    date,
    description: "Troubled debt restructuring — full settlement via transfer of assets/equity",
    ascReference: "ASC 470-60-35-7 / 35-9",
    currency,
    lines,
  };
  assertBalanced(entry);
  return { entry, gainOnRestructuring };
}
