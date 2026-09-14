import { Decimal, DecimalValue, ISODate, Money } from "./types.js";
import { AwardActivityEvent, AwardActivityEventType, buildAwardActivityRollforward } from "./reporting.js";

/**
 * The ASC 718 / SEC 10-K "award activity roll-forward" report George asked for,
 * verbatim: "beginning balance [prior year ending balance], additions, exercises,
 * forfeitures, etc.... roll forward dates (beginning and ending)... toggle... between
 * classes (service, performance, market based and option vs RSU)."
 *
 * A PURE function, deliberately — same architectural rule as everything else in this
 * file's directory (see reporting.ts's own module doc comment): this has no idea where
 * `instruments`/`exerciseEvents`/`forfeitureEvents` came from. The caller
 * (/reports/asc-718-disclosures/page.tsx) does the Prisma query and hands over plain
 * data, which is also what makes this testable with zero database.
 *
 * WHY TWO CALLS TO `buildAwardActivityRollforward` (see the function body): that
 * function already does the correct dollar-weighted WAEP/WAFV roll-forward math given
 * a starting balance/price and a list of events in ONE period. To get the balance/price
 * AS OF `periodStart` (the "beginning balance" George asked for), this replays every
 * matching event dated on/before periodStart starting from zero, then feeds ITS ending
 * balance/price into a second call covering only events inside (periodStart,
 * periodEnd] — i.e., "prior year ending balance" isn't a separately-stored fact, it's
 * recomputed from full history every time, which is also why there's no risk of it
 * silently drifting from what the ending balance of an adjacent, earlier-dated report
 * would show.
 *
 * OPTION vs RSU — genuinely different reduction events, not a shared code path:
 *  - STOCK_OPTION: the reduction is EXERCISED (a real, per-event-priced
 *    OptionExerciseEvent) or FORFEITED/EXPIRED (InstrumentForfeitureEvent). There is no
 *    concept of "vesting" reducing the OUTSTANDING count — an unexercised vested option
 *    stays outstanding until it's exercised or expires.
 *  - RSU: this platform has no persisted "settlement/release" event at all (see
 *    InstrumentForfeitureEvent's doc comment in prisma/schema.prisma for the parallel
 *    gap on the option side, which DOES now have one). Instead, the reduction is
 *    VESTING itself — an RSU's tranche `vestDate` passing is exactly what a real 10-K
 *    RSU roll-forward calls "Vested" (the standard shape is "Unvested at beginning /
 *    Granted / Vested / Forfeited / Unvested at end"), so this reads tranche data
 *    (already captured for the amortization schedule) rather than needing a new event
 *    source. FORFEITED/EXPIRED still comes from InstrumentForfeitureEvent.
 *
 * CONDITION CLASS: only STOCK_OPTION carries a `conditionType` discriminator
 * ("service" | "performance" | "market" — see dispatch.ts's
 * StockOption*ConditionTerms). RSU/RESTRICTED_STOCK grants in this app are always
 * plain service-condition awards with no discriminator field at all, so every RSU
 * instrument is treated as "service" here regardless of what's passed on it — picking
 * "performance" or "market" with awardType "RSU" always returns an empty result (see
 * the `warnings` this function returns in that case, rather than silently showing
 * zeroes with no explanation).
 */

export type AwardType = "STOCK_OPTION" | "RSU";
export type ConditionClassFilter = "ALL" | "service" | "performance" | "market";

export interface AwardRollforwardInstrument {
  instrumentId: string;
  grantDate: ISODate;
  quantity: DecimalValue;
  /** STOCK_OPTION only — defaults to "service" by the caller when the grant's terms
   * don't carry the field at all (the common case; see dispatch.ts). */
  conditionType: "service" | "performance" | "market";
  /** STOCK_OPTION only. Missing on a grant recorded before this field existed — see
   * grantsReport.ts's identical defensive handling. */
  strikePrice?: DecimalValue;
  /** RSU only (the ASC 718 fair value used for the "weighted-average grant-date fair
   * value" roll instead of a WAEP, since RSUs have no exercise price) — also missing on
   * older grants. */
  grantDateFairValuePerUnit?: DecimalValue;
  /** RSU only — the vesting tranches that stand in for "settlement" events (see this
   * file's module doc comment). Absent/empty for STOCK_OPTION rows (not needed — a
   * stock option's reduction comes from `exerciseEvents`, not vesting). */
  tranches?: { vestDate: ISODate; quantity: DecimalValue }[];
}

export interface AwardRollforwardExerciseEvent {
  instrumentId: string;
  exerciseDate: ISODate;
  quantityExercised: DecimalValue;
  exercisePricePerShare: DecimalValue;
}

export interface AwardRollforwardForfeitureEvent {
  instrumentId: string;
  forfeitureDate: ISODate;
  quantityForfeited: DecimalValue;
  eventType: "FORFEITED" | "EXPIRED";
}

export interface AwardRollforwardInput {
  awardType: AwardType;
  conditionClass: ConditionClassFilter;
  periodStart: ISODate;
  periodEnd: ISODate;
  /** Pre-filtered to the one `awardType` this call is for — this function doesn't
   * re-check `instrument.type` since it has no InstrumentType field to check (the
   * caller's Prisma query already did `where: { type: awardType }`). */
  instruments: AwardRollforwardInstrument[];
  /** Ignored entirely when `awardType` is "RSU" (RSUs don't exercise). */
  exerciseEvents: AwardRollforwardExerciseEvent[];
  forfeitureEvents: AwardRollforwardForfeitureEvent[];
}

export interface AwardRollforwardResult {
  awardType: AwardType;
  conditionClass: ConditionClassFilter;
  /** How many instruments (after the conditionClass filter, and granted by
   * `periodEnd`) contributed to this roll-forward at all. */
  instrumentCount: number;
  outstandingAtStart: Money;
  granted: Money;
  /** "Exercised" for STOCK_OPTION, "Vested" for RSU — see `reducedLabel`. */
  reduced: Money;
  reducedLabel: "Exercised" | "Vested";
  forfeited: Money;
  expired: Money;
  outstandingAtEnd: Money;
  /** WAEP for STOCK_OPTION, weighted-average grant-date fair value for RSU — see
   * `priceLabel`. Zero (not undefined) when there's no activity at all to compute a
   * price from (e.g. zero matching instruments) — same "isZero() means no
   * information" convention `buildAwardActivityRollforward` itself uses. */
  priceAtStart: Money;
  priceAtEnd: Money;
  priceLabel: "Weighted-average exercise price" | "Weighted-average grant-date fair value";
  warnings: string[];
}

interface InternalEvent {
  date: ISODate;
  type: AwardActivityEventType;
  quantity: DecimalValue;
  price?: DecimalValue;
}

function toActivityEvent(e: InternalEvent): AwardActivityEvent {
  return { type: e.type, quantity: e.quantity, weightedAverageExercisePrice: e.price };
}

function sumByType(events: InternalEvent[], type: AwardActivityEventType): Decimal {
  return events.filter((e) => e.type === type).reduce((sum, e) => sum.plus(e.quantity), new Decimal(0));
}

export function buildAwardRollforward(input: AwardRollforwardInput): AwardRollforwardResult {
  const { awardType, conditionClass, periodStart, periodEnd, instruments, exerciseEvents, forfeitureEvents } = input;
  const warnings: string[] = [];
  const reducedLabel: AwardRollforwardResult["reducedLabel"] = awardType === "STOCK_OPTION" ? "Exercised" : "Vested";
  const priceLabel: AwardRollforwardResult["priceLabel"] =
    awardType === "STOCK_OPTION" ? "Weighted-average exercise price" : "Weighted-average grant-date fair value";

  if (awardType === "RSU" && (conditionClass === "performance" || conditionClass === "market")) {
    warnings.push(
      `RSUs in this app are always service-condition awards (no performance/market discriminator exists for them) — the "${conditionClass}" filter matches zero RSU grants by design, not because of missing data.`
    );
  }

  const matching = instruments.filter((inst) => {
    if (inst.grantDate > periodEnd) return false; // not yet granted as of the report's end date at all
    if (conditionClass === "ALL") return true;
    if (awardType === "RSU") return conditionClass === "service";
    return inst.conditionType === conditionClass;
  });
  const matchingIds = new Set(matching.map((i) => i.instrumentId));

  const allEvents: InternalEvent[] = [];
  let missingPriceCount = 0;

  for (const inst of matching) {
    const grantPrice = awardType === "STOCK_OPTION" ? inst.strikePrice : inst.grantDateFairValuePerUnit;
    if (grantPrice === undefined) missingPriceCount++;
    allEvents.push({ date: inst.grantDate, type: "GRANTED", quantity: inst.quantity, price: grantPrice });

    if (awardType === "RSU") {
      for (const t of inst.tranches ?? []) {
        if (t.vestDate <= periodEnd) {
          allEvents.push({ date: t.vestDate, type: "EXERCISED_OR_SETTLED", quantity: t.quantity, price: grantPrice });
        }
      }
    }
  }

  if (awardType === "STOCK_OPTION") {
    for (const e of exerciseEvents) {
      if (!matchingIds.has(e.instrumentId) || e.exerciseDate > periodEnd) continue;
      allEvents.push({ date: e.exerciseDate, type: "EXERCISED_OR_SETTLED", quantity: e.quantityExercised, price: e.exercisePricePerShare });
    }
  }

  for (const f of forfeitureEvents) {
    if (!matchingIds.has(f.instrumentId) || f.forfeitureDate > periodEnd) continue;
    const inst = matching.find((i) => i.instrumentId === f.instrumentId);
    const price = awardType === "STOCK_OPTION" ? inst?.strikePrice : inst?.grantDateFairValuePerUnit;
    allEvents.push({ date: f.forfeitureDate, type: f.eventType, quantity: f.quantityForfeited, price });
  }

  if (missingPriceCount > 0) {
    warnings.push(
      `${missingPriceCount} grant(s) have no ${awardType === "STOCK_OPTION" ? "strike price" : "grant-date fair value"} on file — their shares are still counted above, but they're excluded from the ${priceLabel.toLowerCase()} calculation.`
    );
  }

  const beforeStart = allEvents.filter((e) => e.date <= periodStart).map(toActivityEvent);
  const inPeriod = allEvents.filter((e) => e.date > periodStart).map(toActivityEvent);
  const inPeriodInternal = allEvents.filter((e) => e.date > periodStart);

  // Seeding both calls with an explicit "0" (not `undefined`) for the starting price
  // means `buildAwardActivityRollforward` always computes a weighted-average price —
  // even a company with zero prior activity gets a defined (zero) starting price
  // rather than `undefined`, so the two calls chain cleanly: `atStart`'s ENDING price
  // (the real weighted price as of `periodStart`, after replaying all prior history)
  // becomes `atEnd`'s STARTING price — not `atStart`'s own starting price, which is
  // always the literal 0 seed and would silently discard all that prior history.
  const atStart = buildAwardActivityRollforward(0, beforeStart, 0);
  const atEnd = buildAwardActivityRollforward(atStart.outstandingAtEnd, inPeriod, atStart.weightedAverageExercisePriceAtEnd);

  const forfeitedInPeriod = sumByType(inPeriodInternal, "FORFEITED");
  const expiredInPeriod = sumByType(inPeriodInternal, "EXPIRED");
  const combinedCheck = forfeitedInPeriod.plus(expiredInPeriod);
  if (!combinedCheck.equals(atEnd.forfeitedOrExpired)) {
    warnings.push("Internal consistency check failed on the forfeited/expired split — please report this.");
  }

  if (atEnd.outstandingAtEnd.isNegative()) {
    warnings.push(
      "The ending balance computed below is negative — more shares were exercised/vested/forfeited than were ever granted for this selection. Check for a forfeiture or exercise recorded against the wrong instrument, or a date outside this award's actual grant history."
    );
  }

  return {
    awardType,
    conditionClass,
    instrumentCount: matching.length,
    outstandingAtStart: atStart.outstandingAtEnd,
    granted: atEnd.granted,
    reduced: atEnd.exercisedOrSettled,
    reducedLabel,
    forfeited: forfeitedInPeriod,
    expired: expiredInPeriod,
    outstandingAtEnd: atEnd.outstandingAtEnd,
    priceAtStart: atStart.weightedAverageExercisePriceAtEnd,
    priceAtEnd: atEnd.weightedAverageExercisePriceAtEnd,
    priceLabel,
    warnings,
  };
}
