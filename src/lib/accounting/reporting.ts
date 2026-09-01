import { Decimal, JournalEntry, Money, CurrencyCode, currencyOf, ISODate, DecimalValue } from "./types.js";
import { daysBetween } from "./dateMath.js";

/**
 * Cross-instrument reporting aggregations — pure functions over a list of already-
 * persisted JournalEntry objects. Deliberately has no idea where those entries came
 * from (one instrument or a thousand, one entity or across a portfolio); the API route
 * that calls this is responsible for the database query that assembles the list.
 *
 * CURRENCY: every aggregation here groups by currency first. Summing a $100 USD debit
 * and a €100 EUR debit into "$200" is not a number that means anything, and it's exactly
 * the kind of bug that looks fine until a client with foreign-currency debt runs their
 * first report. An entity with instruments in more than one currency gets one
 * AccountSummary/ReconciliationResult PER currency — deliberately not auto-converted to
 * a single reporting currency here, since that's a translation/remeasurement decision
 * (see fxTranslation.ts) that belongs upstream of this function, not inside it.
 */

export interface AccountSummary {
  account: string;
  currency: CurrencyCode;
  totalDebit: Money;
  totalCredit: Money;
  /** Debit-normal net (debits - credits). Read it as credit-normal (flip the sign) for
   * liability/equity/revenue accounts — this function doesn't know your chart of
   * accounts, so it reports the raw net and leaves the normal-balance convention to
   * the caller, same as any trial balance export would. */
  net: Money;
}

/** A basic trial-balance-style rollup: total debits, credits, and net per account (and
 * per currency — see the file-level note above) across every journal entry passed in.
 * This is the first thing requirement #4 ("reporting function that outputs all
 * accounting entries and reconciliations") actually needs — everything else (filtering
 * by date range, instrument, stakeholder) is a query concern before this function ever
 * runs, not a reason to complicate it. */
export function summarizeByAccount(entries: JournalEntry[]): AccountSummary[] {
  const totals = new Map<string, { account: string; currency: CurrencyCode; debit: Money; credit: Money }>();

  for (const entry of entries) {
    const currency = currencyOf(entry);
    for (const line of entry.lines) {
      const key = `${currency}::${line.account}`;
      const existing = totals.get(key) ?? { account: line.account, currency, debit: new Decimal(0), credit: new Decimal(0) };
      totals.set(key, {
        account: line.account,
        currency,
        debit: existing.debit.plus(line.debit ?? 0),
        credit: existing.credit.plus(line.credit ?? 0),
      });
    }
  }

  return [...totals.values()]
    .map(({ account, currency, debit, credit }) => ({
      account,
      currency,
      totalDebit: debit,
      totalCredit: credit,
      net: debit.minus(credit),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.account.localeCompare(b.account));
}

export interface ReconciliationResult {
  currency: CurrencyCode;
  balanced: boolean;
  totalDebits: Money;
  totalCredits: Money;
  difference: Money;
}

/** Checks that a batch of journal entries nets to zero across ALL accounts combined,
 * separately for each currency present — the reconciliation half of requirement #4.
 * Each individual entry is already checked at creation time by `assertBalanced`
 * (types.ts); this is the second, independent check across the whole reported set,
 * which is what actually catches a bug where entries balance individually but
 * something got double-posted or dropped between computation and persistence. */
export function checkReconciliation(entries: JournalEntry[], tolerance = new Decimal("0.01")): ReconciliationResult[] {
  const summary = summarizeByAccount(entries);
  const currencies = [...new Set(summary.map((s) => s.currency))];

  return currencies.map((currency) => {
    const rowsForCurrency = summary.filter((s) => s.currency === currency);
    const totalDebits = rowsForCurrency.reduce((sum, s) => sum.plus(s.totalDebit), new Decimal(0));
    const totalCredits = rowsForCurrency.reduce((sum, s) => sum.plus(s.totalCredit), new Decimal(0));
    const difference = totalDebits.minus(totalCredits).abs();
    return { currency, balanced: difference.lessThanOrEqualTo(tolerance), totalDebits, totalCredits, difference };
  });
}

// =============================================================================
// PERIOD ROLL-FORWARD — financial-statement support (v0.19.0)
// =============================================================================
/**
 * "What was this account's beginning balance, what moved during the period, and what's
 * the ending balance" — the standard shape of a footnote roll-forward table (debt
 * roll-forward, APIC roll-forward, etc.). Built entirely on top of `summarizeByAccount`
 * above rather than re-walking `entries` a second time with new logic: a roll-forward
 * is just two account summaries (everything strictly before the period, and the period
 * itself) merged together, so reusing the already-tested aggregation is both less code
 * and one less place a currency-mixing bug could sneak back in.
 *
 * Same currency-segregation rule as the rest of this file: one row per (account,
 * currency) pair, never summed across currencies.
 */
export interface RollForwardRow {
  account: string;
  currency: CurrencyCode;
  /** Net (debit-normal) balance as of the instant before `periodStart` — flip the sign
   * to read it credit-normal, same caveat as `AccountSummary.net`. */
  beginningBalance: Money;
  /** Net activity strictly within [periodStart, periodEnd] (inclusive both ends). */
  periodActivity: Money;
  /** beginningBalance + periodActivity, by construction — never independently derived,
   * so it can never drift out of tie with the other two columns. */
  endingBalance: Money;
}

export function buildAccountRollForward(entries: JournalEntry[], periodStart: ISODate, periodEnd: ISODate): RollForwardRow[] {
  const priorEntries = entries.filter((e) => e.date < periodStart);
  const periodEntries = entries.filter((e) => e.date >= periodStart && e.date <= periodEnd);

  const beginningSummary = summarizeByAccount(priorEntries);
  const periodSummary = summarizeByAccount(periodEntries);

  const beginningByKey = new Map(beginningSummary.map((s) => [`${s.currency}::${s.account}`, s.net]));
  const periodByKey = new Map(periodSummary.map((s) => [`${s.currency}::${s.account}`, s.net]));
  const allKeys = new Set([...beginningByKey.keys(), ...periodByKey.keys()]);

  const rows: RollForwardRow[] = [...allKeys].map((key) => {
    const [currency, account] = key.split("::");
    const beginningBalance = beginningByKey.get(key) ?? new Decimal(0);
    const periodActivity = periodByKey.get(key) ?? new Decimal(0);
    return { account, currency, beginningBalance, periodActivity, endingBalance: beginningBalance.plus(periodActivity) };
  });

  return rows.sort((a, b) => a.currency.localeCompare(b.currency) || a.account.localeCompare(b.account));
}

// =============================================================================
// ASC 718 STOCK COMPENSATION DISCLOSURE — financial-statement support (v0.19.0)
// =============================================================================
/**
 * The standard "unrecognized compensation cost" footnote table ASC 718-10-50-2(g)
 * requires: total compensation cost related to nonvested awards not yet recognized,
 * and the weighted-average period over which it's expected to be recognized. This is a
 * pure aggregation over numbers the vesting engines (vesting.ts, restrictedStock.ts,
 * stockAppreciationRights.ts) and dispatch.ts already compute per instrument — it does
 * not recompute any schedule itself, the same separation `capTable.ts` keeps between
 * "classify what's already computed" and "compute it in the first place."
 *
 * SCOPE: the weighted-average remaining period is computed from each award's own
 * `serviceEndDate` (its last requisite-service/vesting date) relative to `asOfDate` —
 * a fully-vested award (serviceEndDate in the past) contributes 0 remaining years and,
 * necessarily, $0 unrecognized cost (see the caller-supplied
 * `cumulativeExpenseRecognized` — if it's computed correctly upstream, a fully-vested
 * award's cumulative recognized should already equal its total grant-date fair value).
 * This function trusts its inputs on that point rather than re-deriving them; a
 * mismatch (unrecognized cost > 0 with zero remaining years) is left visible in the
 * output rather than silently clamped, so a caller feeding it inconsistent numbers
 * finds out from the report instead of a hidden correction.
 */
export interface StockCompInstrumentInput {
  instrumentId: string;
  stakeholderName: string;
  /** e.g. "STOCK_OPTION", "RSU", "RESTRICTED_STOCK", "SAR" (stock-settled only —
   * cash-settled SAR is a liability remeasured to fair value each period, not a
   * grant-date-fair-value-amortized award, so it doesn't belong in this disclosure). */
  type: string;
  /** Total expense the award will recognize over its life (quantity x grant-date fair
   * value per unit, for the usual case). */
  totalGrantDateFairValue: DecimalValue;
  /** Sum of expense already recognized through `asOfDate`. */
  cumulativeExpenseRecognized: DecimalValue;
  /** The award's last requisite-service / vesting date. */
  serviceEndDate: ISODate;
  asOfDate: ISODate;
}

export interface StockCompDisclosureRow {
  instrumentId: string;
  stakeholderName: string;
  type: string;
  totalGrantDateFairValue: Money;
  cumulativeExpenseRecognized: Money;
  unrecognizedCompCost: Money;
  /** Years remaining from `asOfDate` to `serviceEndDate`, floored at 0 for an award
   * whose service period has already ended. */
  remainingRecognitionYears: number;
}

export interface StockCompDisclosureSummary {
  rows: StockCompDisclosureRow[];
  totalUnrecognizedCompCost: Money;
  /** Weighted by each row's own unrecognized cost — the standard ASC 718 disclosure
   * methodology (an award with more cost left to recognize should move the average
   * more than one that's nearly done vesting). 0 when there's no unrecognized cost at
   * all (nothing left to weight). */
  weightedAverageRemainingYears: number;
}

export function buildStockCompDisclosure(inputs: StockCompInstrumentInput[]): StockCompDisclosureSummary {
  const rows: StockCompDisclosureRow[] = inputs.map((i) => {
    const totalGrantDateFairValue = new Decimal(i.totalGrantDateFairValue);
    const cumulativeExpenseRecognized = new Decimal(i.cumulativeExpenseRecognized);
    const unrecognizedCompCost = Decimal.max(new Decimal(0), totalGrantDateFairValue.minus(cumulativeExpenseRecognized));
    const daysRemaining = Math.max(0, daysBetween(i.asOfDate, i.serviceEndDate));
    const remainingRecognitionYears = daysRemaining / 365.25;
    return {
      instrumentId: i.instrumentId,
      stakeholderName: i.stakeholderName,
      type: i.type,
      totalGrantDateFairValue,
      cumulativeExpenseRecognized,
      unrecognizedCompCost,
      remainingRecognitionYears,
    };
  });

  const totalUnrecognizedCompCost = rows.reduce((sum, r) => sum.plus(r.unrecognizedCompCost), new Decimal(0));
  const weightedSum = rows.reduce((sum, r) => sum + r.unrecognizedCompCost.toNumber() * r.remainingRecognitionYears, 0);
  const weightedAverageRemainingYears = totalUnrecognizedCompCost.isZero() ? 0 : weightedSum / totalUnrecognizedCompCost.toNumber();

  return { rows, totalUnrecognizedCompCost, weightedAverageRemainingYears };
}

/**
 * Settlement/exercise activity rollup for the ASC 718 disclosure package (v0.20.0) —
 * the piece the README's "additional ASC 718 footnote disclosures" pinned gap called
 * out as blocked on `optionSettlement.ts` not existing yet (it now does). Aggregates a
 * batch of already-computed settlement transactions (one row per
 * `computeCashExercise`/`computeNetShareSettlement` call — see optionSettlement.ts)
 * into the totals a disclosure footnote actually presents: shares issued, cash
 * received from cash exercises, and cash effects (tax withholding) from net
 * settlements.
 *
 * DELIBERATELY TAKES ALREADY-COMPUTED TRANSACTIONS, NOT A DATE RANGE OVER STORED DATA —
 * same limitation as `optionSettlement.ts` itself and the exit-waterfall calculator:
 * this platform's data model has no persisted "exercise" or "settlement" event yet
 * (only grant terms and vesting schedules), so there is nothing in the database this
 * function could query a period's activity from. Once that data model gap closes, this
 * function's shape is exactly what a real query result would map into — the
 * aggregation logic itself doesn't change, only where its inputs come from.
 *
 * NOT the full "additional ASC 718 footnote disclosures" package (award-activity
 * rollforward by count, fair-value assumptions rollup, vested/expected-to-vest table,
 * intrinsic value at exercise, tax benefit realized) — intrinsic value specifically
 * still needs a per-exercise stock-price-at-exercise input this doesn't collect either;
 * this covers the share-count and cash-effects slice that `optionSettlement.ts`'s
 * outputs make possible today, not the whole pinned gap.
 */
export interface SettlementActivityInput {
  instrumentId: string;
  stakeholderName: string;
  type: "CASH_EXERCISE" | "NET_SHARE_SETTLEMENT";
  /** Net shares actually issued in this transaction (for CASH_EXERCISE, this is the
   * full quantity exercised — nothing is withheld in a cash exercise). */
  sharesIssued: DecimalValue;
  /** Cash exercise only — the exercise price paid in cash. Omit/zero for a net
   * settlement, where no cash changes hands from the holder for the exercise price. */
  cashReceivedFromExercise?: DecimalValue;
  /** Net settlement only — the dollar value of shares withheld for tax withholding
   * (this is a cash effect from the EMPLOYER's side: it's the amount ultimately
   * remitted to the taxing authority, per `buildTaxWithholdingRemittanceEntry`). Omit
   * /zero for a cash exercise, which has no withholding component of its own. */
  taxWithholdingAmount?: DecimalValue;
}

export interface SettlementActivityRow {
  instrumentId: string;
  stakeholderName: string;
  type: SettlementActivityInput["type"];
  sharesIssued: Money;
  cashReceivedFromExercise: Money;
  taxWithholdingAmount: Money;
}

export interface SettlementActivitySummary {
  rows: SettlementActivityRow[];
  totalSharesIssued: Money;
  totalCashReceivedFromExercise: Money;
  totalTaxWithholdingAmount: Money;
  /** Count of underlying transactions, broken out by type — a disclosure footnote
   * commonly reports "options exercised: N" as a headline number alongside the dollar
   * rollup. */
  transactionCountByType: { CASH_EXERCISE: number; NET_SHARE_SETTLEMENT: number };
}

export function buildSettlementActivityDisclosure(inputs: SettlementActivityInput[]): SettlementActivitySummary {
  const rows: SettlementActivityRow[] = inputs.map((i) => ({
    instrumentId: i.instrumentId,
    stakeholderName: i.stakeholderName,
    type: i.type,
    sharesIssued: new Decimal(i.sharesIssued),
    cashReceivedFromExercise: new Decimal(i.cashReceivedFromExercise ?? 0),
    taxWithholdingAmount: new Decimal(i.taxWithholdingAmount ?? 0),
  }));

  const totalSharesIssued = rows.reduce((sum, r) => sum.plus(r.sharesIssued), new Decimal(0));
  const totalCashReceivedFromExercise = rows.reduce((sum, r) => sum.plus(r.cashReceivedFromExercise), new Decimal(0));
  const totalTaxWithholdingAmount = rows.reduce((sum, r) => sum.plus(r.taxWithholdingAmount), new Decimal(0));

  const transactionCountByType = { CASH_EXERCISE: 0, NET_SHARE_SETTLEMENT: 0 };
  for (const r of rows) transactionCountByType[r.type]++;

  return { rows, totalSharesIssued, totalCashReceivedFromExercise, totalTaxWithholdingAmount, transactionCountByType };
}

/**
 * Two more pieces of the "additional ASC 718 footnote disclosures" pinned gap
 * (v0.20.0), added here as further exports exactly as the pinned callout above asked
 * ("add these as further exports alongside `buildStockCompDisclosure` in
 * `reporting.ts`, not as a replacement for it") rather than as a new, separate module.
 *
 * (c) AWARD ACTIVITY ROLLFORWARD BY COUNT (`buildAwardActivityRollforward`) — the
 * familiar "outstanding at beginning, granted, exercised, forfeited, expired,
 * outstanding at end" table, with an optional weighted-average-exercise-price roll
 * alongside it. This is genuinely different from both existing rollforwards in this
 * file: `buildAccountRollForward` (if present elsewhere) rolls forward DOLLAR amounts
 * by account, and `buildSettlementActivityDisclosure` above rolls up TRANSACTION-level
 * cash/tax effects — neither tracks a running SHARE COUNT balance the way this does.
 * The WAEP columns are rolled by dollar balance (starting balance, plus each granted
 * event's dollars, minus each exercised/forfeited/expired event's dollars, divided by
 * the ending share count) rather than a naive average of per-event prices, which would
 * silently ignore how many shares each event actually represents.
 *
 * (e) INTRINSIC VALUE OF EXERCISES (`computeIntrinsicValueRealized`) — the pinned
 * callout above specifically flagged this as blocked on "a per-period market/
 * FMV-at-exercise input this codebase doesn't currently collect anywhere." That's
 * still true — nothing here derives a stock price — but the blocker was really just
 * that no function existed that would accept it as a given input and do the
 * arithmetic. This one does: `quantity * (FMV at exercise - exercise price)`, summed
 * across a batch of exercise events, mirroring the exact per-event calculation
 * `optionSettlement.ts`'s `computeCashExercise` already performs, not a new pricing
 * model. Deliberately does NOT also total cash received — `buildSettlementActivityDisclosure`
 * above already owns that number; duplicating it here would just be two functions
 * computing the same thing from overlapping inputs.
 *
 * STILL NOT BUILT after this pass — (b) the fair-value-assumptions rollup (blocked:
 * this platform's schema doesn't persist per-grant valuation assumptions, only the
 * resulting fair value) and (f) the vested/expected-to-vest table (a genuinely
 * different prospective-forfeiture-rate methodology, not attempted here) — see the
 * pinned callout above, which still applies to those two.
 */
export type AwardActivityEventType = "GRANTED" | "EXERCISED_OR_SETTLED" | "FORFEITED" | "EXPIRED";

export interface AwardActivityEvent {
  type: AwardActivityEventType;
  quantity: DecimalValue;
  /** This event's own weighted-average exercise price, if the award type has one
   * (omit for RSUs or SARs with no exercise price). Needed only if you want the
   * weighted-average-exercise-price columns computed — see
   * `weightedAverageExercisePriceAtStart` below. */
  weightedAverageExercisePrice?: DecimalValue;
}

export interface AwardActivityRollforward {
  outstandingAtStart: Money;
  granted: Money;
  exercisedOrSettled: Money;
  forfeitedOrExpired: Money;
  outstandingAtEnd: Money;
  weightedAverageExercisePriceAtStart?: Money;
  weightedAverageExercisePriceAtEnd?: Money;
}

export function buildAwardActivityRollforward(
  outstandingAtStart: DecimalValue,
  events: AwardActivityEvent[],
  weightedAverageExercisePriceAtStart?: DecimalValue
): AwardActivityRollforward {
  const startQty = new Decimal(outstandingAtStart);
  const sumByType = (type: AwardActivityEventType) =>
    events.filter((e) => e.type === type).reduce((sum, e) => sum.plus(e.quantity), new Decimal(0));

  const granted = sumByType("GRANTED");
  const exercisedOrSettled = sumByType("EXERCISED_OR_SETTLED");
  const forfeitedOrExpired = sumByType("FORFEITED").plus(sumByType("EXPIRED"));
  const outstandingAtEnd = startQty.plus(granted).minus(exercisedOrSettled).minus(forfeitedOrExpired);

  const result: AwardActivityRollforward = {
    outstandingAtStart: startQty,
    granted,
    exercisedOrSettled,
    forfeitedOrExpired,
    outstandingAtEnd,
  };

  if (weightedAverageExercisePriceAtStart !== undefined) {
    const startWaep = new Decimal(weightedAverageExercisePriceAtStart);
    let dollarBalance = startQty.times(startWaep);
    for (const e of events) {
      if (e.weightedAverageExercisePrice === undefined) continue;
      const qty = new Decimal(e.quantity);
      const price = new Decimal(e.weightedAverageExercisePrice);
      const dollars = qty.times(price);
      dollarBalance = e.type === "GRANTED" ? dollarBalance.plus(dollars) : dollarBalance.minus(dollars);
    }
    result.weightedAverageExercisePriceAtStart = startWaep;
    result.weightedAverageExercisePriceAtEnd = outstandingAtEnd.isZero() ? new Decimal(0) : dollarBalance.div(outstandingAtEnd);
  }

  return result;
}

export interface IntrinsicValueExerciseEvent {
  quantity: DecimalValue;
  /** 0 for an RSU or a SAR with no exercise price. */
  exercisePricePerUnit: DecimalValue;
  fairMarketValuePerUnitAtExercise: DecimalValue;
}

/** Sums intrinsic value realized across a batch of exercise/settlement events — see
 * the doc comment above, point (e). Pair with `buildSettlementActivityDisclosure` for
 * the cash/tax-withholding side of the same period's activity. */
export function computeIntrinsicValueRealized(events: IntrinsicValueExerciseEvent[]): Money {
  let intrinsic = new Decimal(0);
  for (const e of events) {
    const qty = new Decimal(e.quantity);
    const exercisePrice = new Decimal(e.exercisePricePerUnit);
    const fmv = new Decimal(e.fairMarketValuePerUnitAtExercise);
    intrinsic = intrinsic.plus(qty.times(fmv.minus(exercisePrice)));
  }
  return intrinsic;
}
