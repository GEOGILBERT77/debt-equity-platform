import { ScheduleRow, ISODate, Decimal, DecimalValue } from "./types.js";
import { Period } from "./dateMath.js";
import { daysBetween } from "./dateMath.js";
import { allocateStraightLineByElapsedTime } from "./allocation.js";
import { buildEffectiveInterestSchedule, TermDebtInputs } from "./debtAmortization.js";

/**
 * ASC 480-10 preferred stock — like SAR (stockAppreciationRights.ts) and WARRANT
 * (warrantAllocation.ts), this is a case where a single classification question
 * decides which of genuinely different accounting models applies, so the module opens
 * with a classification triage (mirroring `classifyWarrant`'s style and its explicit
 * "triage, not a substitute for judgment" caveat) rather than one schedule function.
 *
 * THREE CLASSIFICATIONS (ASC 480-10-25-4 and ASC 480-10-S99-3A):
 *  - "liability": MANDATORILY redeemable — redemption is required, either on a fixed
 *    date or upon an event certain to occur (not merely possible). ASC 480-10-25-4
 *    requires liability classification, and ASC 480-10-35-3 requires subsequent
 *    measurement using the interest method to accrete from issuance proceeds to the
 *    mandatory redemption amount, with dividend payments treated as interest expense.
 *    That is EXACTLY the effective-interest debt model this codebase already has
 *    (`debtAmortization.ts`'s `buildEffectiveInterestSchedule` — the same engine
 *    TERM_LOAN uses) — a genuine equivalence, not an approximation, which is why this
 *    branch reuses that engine directly rather than building a new one. See
 *    `buildMandatorilyRedeemablePreferredSchedule` below.
 *  - "mezzanine": redeemable at the HOLDER's option, or upon a contingent event not
 *    solely within the company's control (a change of control or deemed liquidation —
 *    the single most common real-world provision in VC-backed preferred stock).
 *    ASC 480-10-S99-3A requires this to sit in temporary equity, between liabilities
 *    and permanent equity on the balance sheet, and its carrying amount to be accreted
 *    toward the redemption value over time — see `buildMezzanineAccretionSchedule`.
 *  - "permanent_equity": everything else — perpetual (no redemption feature at all),
 *    or redeemable solely at the COMPANY's own option. No accretion applies (there's
 *    no redemption value being accreted toward); nothing here computes a periodic
 *    schedule for it (see the module-level SCOPE note below).
 *
 * SCOPE, FLAGGED HONESTLY: this is a representative slice, not full preferred-stock
 * accounting. NOT covered here: participating preferred and the two-class method for
 * EPS (ASC 260-10-45), convertible preferred's as-converted dilution (no conversion
 * ratio is modeled — see dispatch.ts's cap table wiring note), embedded feature
 * bifurcation for a preferred stock host with a conversion option that itself requires
 * separate accounting (ASC 815-15), and the beneficial conversion feature computation
 * (ASC 470-20-30) for a preferred convertible at a below-market price. Each is a real,
 * separate piece of work, not something this pass claims to have covered by omission.
 *
 * CUMULATIVE DIVIDEND ACCRUAL — TRACKED, BUT NOT WIRED INTO THE CLOSE WORKFLOW:
 * `buildCumulativeDividendAccrualSchedule` computes the running "dividends in arrears"
 * balance for a cumulative preferred — a real number CPAs need for EPS (the two-class
 * method) and liquidation-preference disclosures — but undeclared cumulative preferred
 * dividends are NOT a balance-sheet liability and NOT a P&L expense under GAAP; nothing
 * is actually booked until the board declares a dividend. That's a genuinely different
 * shape from every other schedule in this codebase (which all produce a real,
 * closeable journal entry every period), so this function is exported standalone for a
 * future disclosure-only view, deliberately NOT wired into `dispatch.ts`'s
 * `getScheduleBuilder`/`journalEntryForRow` (which assume "every schedule row gets a
 * real journal entry, one-to-one" — see `closeService.ts`). Forcing a fabricated
 * journal entry just to fit that shape would be worse than leaving the gap visible.
 */

export interface PreferredStockClassificationInputs {
  /** Redemption is required — a fixed date, or upon an event certain to occur (not
   * merely possible). ASC 480-10-25-4. */
  mandatorilyRedeemable: boolean;
  /** The HOLDER can force redemption at their own option (a "put"). */
  redeemableAtHolderOption: boolean;
  /** Redeemable upon a contingent event not solely within the company's control — a
   * change of control, a deemed liquidation, an IPO failing to occur by a deadline.
   * The classic VC-preferred provision that triggers ASC 480-10-S99-3A mezzanine
   * treatment even though there's no unconditional redemption obligation. */
  redeemableUponContingentEventOutsideCompanyControl: boolean;
}

export type PreferredStockClassification = "liability" | "mezzanine" | "permanent_equity";

export function classifyPreferredStock(inputs: PreferredStockClassificationInputs): PreferredStockClassification {
  if (inputs.mandatorilyRedeemable) return "liability"; // ASC 480-10-25-4
  if (inputs.redeemableAtHolderOption || inputs.redeemableUponContingentEventOutsideCompanyControl) {
    return "mezzanine"; // ASC 480-10-S99-3A
  }
  return "permanent_equity";
}

/**
 * See the module doc comment's "liability" case — this is a thin wrapper around the
 * existing effective-interest debt engine, relabeling the ASC citation and stamping a
 * `classification` discriminator into `meta` so `journalEntryForRow` in dispatch.ts
 * can route to the debt journal-entry mapper without needing `terms` itself (same
 * "meta carries what the mapper needs" pattern SAR's settlementType and WARRANT's
 * instrumentAccountName already use).
 */
export function buildMandatorilyRedeemablePreferredSchedule(inputs: TermDebtInputs, periods: Period[]): ScheduleRow[] {
  return buildEffectiveInterestSchedule(inputs, periods).map((row) => ({
    ...row,
    meta: {
      ...row.meta,
      ascReference: "ASC 480-10-25-4 / 480-10-35-3 (mandatorily redeemable preferred stock — liability-classified, dividends treated as interest)",
      classification: "liability",
    },
  }));
}

export interface MezzanineAccretionGrant {
  issueDate: ISODate;
  quantity: DecimalValue;
  issuePricePerShare: DecimalValue;
  redemptionDate: ISODate;
  redemptionValuePerShare: DecimalValue;
}

/**
 * Straight-line accretion of a mezzanine-classified preferred's carrying value from
 * issuance proceeds to its stated redemption value, over the period from issuance to
 * the redemption date — one of the two methods ASC 480-10-S99-3A permits (the other,
 * the effective-interest/rate-of-return method, is NOT implemented here; straight-line
 * is the simpler, more commonly elected policy for a plain redemption feature with no
 * embedded rate of return to solve for — flagged as a real scope cut, same spirit as
 * `buildRevolverFeeSchedule`'s equal-division-by-count note in debtAmortization.ts).
 * Reuses `allocateStraightLineByElapsedTime` — the exact same remainder-allocation
 * math `vesting.ts`'s market-condition attribution uses — so this schedule has the
 * IDENTICAL truncation hazard `dispatch.ts`'s big CORRECTNESS NOTE describes for
 * STOCK_OPTION/RSU: `naturalScheduleEndDate` must return `redemptionDate` for this
 * case, which it does (see dispatch.ts's PREFERRED_STOCK branch).
 */
export function buildMezzanineAccretionSchedule(grant: MezzanineAccretionGrant, periods: Period[]): ScheduleRow[] {
  const totalCarrying = new Decimal(grant.quantity).times(grant.issuePricePerShare);
  const totalRedemption = new Decimal(grant.quantity).times(grant.redemptionValuePerShare);
  const totalAccretion = totalRedemption.minus(totalCarrying);

  const amounts = allocateStraightLineByElapsedTime(totalAccretion, grant.issueDate, grant.redemptionDate, periods);

  let cumulative = totalCarrying;
  return periods.map((p, i) => {
    cumulative = cumulative.plus(amounts[i]);
    return {
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: amounts[i],
      endingBalance: cumulative,
      meta: {
        ascReference: "ASC 480-10-S99-3A (mezzanine equity — accretion to redemption value, straight-line method)",
        classification: "mezzanine",
      },
    };
  });
}

export interface CumulativeDividendGrant {
  issueDate: ISODate;
  quantity: DecimalValue;
  issuePricePerShare: DecimalValue;
  /** Annualized rate on issue price per share, e.g. 0.08 for an "8% cumulative
   * preferred." */
  annualDividendRate: DecimalValue;
}

/** See the module doc comment's "CUMULATIVE DIVIDEND ACCRUAL" note for why this is
 * standalone rather than wired into dispatch.ts. Actual/365 day-count simplification
 * (a real, common convention for this purpose, but flagged rather than assumed silent
 * — an actual/360 or 30/360 convention would produce a slightly different number). */
export function buildCumulativeDividendAccrualSchedule(grant: CumulativeDividendGrant, periods: Period[]): ScheduleRow[] {
  const perShareAnnualDividend = new Decimal(grant.issuePricePerShare).times(grant.annualDividendRate);
  const annualDividend = perShareAnnualDividend.times(grant.quantity);

  let cumulative = new Decimal(0);
  return periods.map((p) => {
    const days = daysBetween(p.start, p.end);
    const accrual = annualDividend.times(days).div(365);
    cumulative = cumulative.plus(accrual);
    return {
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: accrual,
      endingBalance: cumulative,
      meta: {
        ascReference: "ASC 480-10-S99-3A (cumulative preferred dividends in arrears — accrues whether or not declared; NOT a balance-sheet liability or P&L expense until declared)",
        dayCountConvention: "actual/365",
      },
    };
  });
}
