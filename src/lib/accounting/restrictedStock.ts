import { ScheduleRow, Decimal, DecimalValue } from "./types.js";
import { Period } from "./dateMath.js";
import { Tranche } from "./vesting.js";

/**
 * ASC 718 restricted stock and early-exercised stock options — grouped as one
 * instrument type (RESTRICTED_STOCK) because, once the shares are actually
 * outstanding, they are accounted for identically regardless of how they got that
 * way: an employee either purchases restricted stock directly at grant (often at par
 * value or a nominal price), or early-exercises an option before it's vested. Either
 * way, the company holds a repurchase right over the UNVESTED shares at the original
 * purchase/exercise price if the holder leaves before vesting — and that repurchase
 * right is the single fact that drives the accounting difference from a plain stock
 * option or plain common stock:
 *
 *  - COMPENSATION EXPENSE is completely unaffected by the early-exercise/restricted
 *    mechanic — it's recognized exactly the way a service-condition stock option's
 *    is: grant-date fair value (here, fair value at grant minus whatever price the
 *    holder paid — usually zero for a nominal-price restricted grant, or the
 *    Black-Scholes value of the option for an early-exercised option) times quantity,
 *    straight-line or graded over the requisite service period. That's precisely
 *    `buildServiceConditionSchedule` (vesting.ts) — the same function STOCK_OPTION/
 *    RSU and a stock-settled SAR already delegate to — so this module does NOT define
 *    a new expense function; see dispatch.ts's RESTRICTED_STOCK branch.
 *  - BALANCE SHEET PRESENTATION is what genuinely differs, and IS new math: because
 *    the company can force the holder to sell the unvested shares back at cost if
 *    they leave, the cash/consideration received for shares that haven't vested yet
 *    isn't real, unconditional equity — it's presented as a liability (sometimes
 *    called "early exercise liability" or "unvested shares subject to repurchase"),
 *    NOT as issued Common Stock/APIC. As each tranche actually vests, the repurchase
 *    right on that tranche lapses, and the PURCHASE PRICE originally paid for those
 *    specific shares reclassifies from that liability into real equity. That
 *    reclassification is a discrete, per-tranche event on each tranche's own vest
 *    date — not a day-weighted allocation the way expense attribution is — which is
 *    exactly what `buildRepurchaseRightLapseSchedule` below computes.
 *
 * SCOPE, FLAGGED: this assumes every tranche's purchase price is paid at the SAME
 * per-share rate (`purchasePricePerShare` is one number for the whole grant) — a
 * grant where different tranches were priced differently isn't modeled. It also
 * assumes the repurchase right is a simple "we can buy back at cost" provision — a
 * fair-value (rather than cost) repurchase right would actually mean the award never
 * qualifies as a real "sale" for accounting purposes at all (ASC 718-10-25-9), which
 * is a materially different situation this module doesn't attempt to detect.
 */

export interface RepurchaseRightLapseGrant {
  quantity: DecimalValue;
  purchasePricePerShare: DecimalValue;
  tranches: Tranche[];
}

/**
 * For each period, sums the purchase price of every tranche whose `vestDate` falls
 * within that period (`start < vestDate <= end`) — the repurchase right lapses on
 * exactly that date, so the reclassification is booked in whichever period contains
 * it, not spread across it. `endingBalance` is the CUMULATIVE amount reclassified
 * into equity so far (i.e., how much of the original liability has become real
 * equity) — the remaining, not-yet-vested liability balance is
 * `quantity * purchasePricePerShare` minus this running total, which the caller can
 * derive without this function needing to track it separately.
 */
export function buildRepurchaseRightLapseSchedule(grant: RepurchaseRightLapseGrant, periods: Period[]): ScheduleRow[] {
  if (!grant.tranches || grant.tranches.length === 0) {
    throw new Error("A restricted stock / early-exercise grant must have at least one vesting tranche");
  }

  const purchasePricePerShare = new Decimal(grant.purchasePricePerShare);
  let cumulative = new Decimal(0);

  return periods.map((p) => {
    const vestingInPeriod = grant.tranches.filter((t) => t.vestDate > p.start && t.vestDate <= p.end);
    const periodAmount = vestingInPeriod.reduce((sum, t) => sum.plus(new Decimal(t.quantity).times(purchasePricePerShare)), new Decimal(0));
    cumulative = cumulative.plus(periodAmount);
    return {
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: periodAmount,
      endingBalance: cumulative,
      meta: {
        ascReference:
          "ASC 718-10-25-9 (repurchase right lapse — reclassifies the purchase price of newly-vested shares from a liability into issued equity)",
        vestedTrancheIds: vestingInPeriod.map((t) => t.id),
      },
    };
  });
}

// NOTE ON dispatch.ts's `naturalScheduleEndDate`: this schedule is NOT susceptible to
// the remainder-allocation truncation bug that STOCK_OPTION/RSU (and stock-settled
// SAR, and mezzanine preferred accretion) need special handling for. Each period's
// amount above depends only on which tranches vest strictly within that period's own
// boundaries — never on "how many periods come after this one" — so it's a
// period-by-period computation in the same sense buildPikSchedule/
// buildFairValueRemeasurementSchedule are: correctly showing only what's actually
// vested so far when handed a `periods` array truncated at today's date, with no
// special end-date extension needed. dispatch.ts correctly falls through to its
// default (null) for RESTRICTED_STOCK for exactly this reason.
