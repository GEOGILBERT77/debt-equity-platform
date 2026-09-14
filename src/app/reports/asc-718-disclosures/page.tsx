import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { money } from "@/lib/accounting/types";
import { buildStockCompDisclosure, StockCompInstrumentInput, computeIntrinsicValueRealized } from "@/lib/accounting/reporting";
import { buildAwardRollforward, AwardType, ConditionClassFilter, AwardRollforwardInstrument } from "@/lib/accounting/awardRollforward";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { theme } from "@/lib/theme";
import { ListingTable } from "@/app/components/ListingTable";

const AWARD_TYPES: { value: AwardType; label: string }[] = [
  { value: "STOCK_OPTION", label: "Stock options" },
  { value: "RSU", label: "RSUs" },
];
const CONDITION_CLASSES: { value: ConditionClassFilter; label: string }[] = [
  { value: "ALL", label: "All classes" },
  { value: "service", label: "Service condition" },
  { value: "performance", label: "Performance condition" },
  { value: "market", label: "Market condition" },
];

/** STOCK_OPTION terms optionally carry a `conditionType` discriminator ("service" |
 * "performance" | "market" — see dispatch.ts's StockOption*ConditionTerms); every
 * other award type (RSU, RESTRICTED_STOCK) has no such field at all and defaults to
 * "service" — see awardRollforward.ts's own doc comment on why RSU is always treated
 * as service-condition in this app. Read defensively (terms is untyped JSON), same
 * posture as grantsReport.ts's readTranches. */
function readConditionType(terms: Record<string, unknown>): "service" | "performance" | "market" {
  const raw = terms.conditionType;
  if (raw === "performance") return "performance";
  if (raw === "market") return "market";
  return "service";
}

/**
 * "ASC 718 disclosures" (v0.46.0) — George, verbatim: "Financial statements should
 * have the 718 disclosures, we need to add roll forward (showing beginning balance
 * [prior year ending balance], additions, exercises, forfeitures, etc.), user should
 * be able to indicate the roll forward dates (beginning and ending) and have the
 * ability to toggle via dropdown between classes (service, performance, market based
 * and option vs RSU)."
 *
 * A REAL, database-driven report — genuinely different from the existing
 * "Equity comp footnote disclosures" calculator under the ASC calculators group
 * (EquityCompDisclosuresCalculator.tsx), which is explicitly hand-entry-only (its own
 * doc comment: "NOT wired to any stored Instrument data or existing schedule"). This
 * page queries actual grants (InstrumentTermVersion), actual exercises
 * (OptionExerciseEvent), and actual forfeitures/expirations (InstrumentForfeitureEvent,
 * new this version) — the calculator stays where it is for quick what-if scenarios,
 * this is the report you'd actually attach to a 10-K footnote. All the roll-forward
 * math itself lives in awardRollforward.ts (a pure, unit-tested function) — this page
 * only does the Prisma query and hands it plain data, same split as
 * financial-statements/page.tsx.
 *
 * "ALL SEC 10-K DISCLOSURE REQUIREMENTS" — SCOPING NOTE: a full ASC 718/10-K equity
 * compensation footnote also conventionally includes a few items this page does NOT
 * attempt, because the data simply doesn't exist anywhere in this app yet and
 * fabricating it would be worse than omitting it:
 *   - Weighted-average remaining contractual term & aggregate intrinsic value of
 *     options OUTSTANDING/EXERCISABLE at period end — both need a current fair market
 *     value per share (a 409A valuation or public trading price), which this platform
 *     has no company-wide field for (only a per-exercise FMV, captured at the moment of
 *     each individual exercise, which isn't the same thing as "today's FMV").
 *   - The Black-Scholes/lattice ASSUMPTIONS table (volatility, risk-free rate, expected
 *     term, dividend yield) — this platform stores the resulting grant-date fair value,
 *     never the assumptions that produced it (see reporting.ts's own pinned "STILL NOT
 *     BUILT" note on this exact gap).
 * Below the roll-forward, this page DOES surface three more real, DB-backed 10-K
 * disclosure items for the same period/award-type/class selection: unrecognized
 * compensation cost (reusing buildStockCompDisclosure, also used by
 * financial-statements/page.tsx), and — for stock options — intrinsic value realized
 * and cash received from exercises in the period (both computed from real
 * OptionExerciseEvent rows, not entered by hand).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function Asc718DisclosuresPage({
  searchParams,
}: {
  searchParams: { entityId?: string; periodStart?: string; periodEnd?: string; awardType?: string; conditionClass?: string };
}) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) {
      const params = new URLSearchParams({ entityId: defaultEntityId });
      for (const key of ["periodStart", "periodEnd", "awardType", "conditionClass"] as const) {
        if (searchParams[key]) params.set(key, searchParams[key] as string);
      }
      redirect(`/reports/asc-718-disclosures?${params.toString()}`);
    }
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view this report, or go to <Link href="/">the entity list</Link> (or set
          a default entity there).
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "VIEWER");

  const today = new Date().toISOString().slice(0, 10);
  const periodStart = searchParams.periodStart ?? `${today.slice(0, 4)}-01-01`;
  const periodEnd = searchParams.periodEnd ?? today;
  const awardType: AwardType = searchParams.awardType === "RSU" ? "RSU" : "STOCK_OPTION";
  const conditionClass: ConditionClassFilter = CONDITION_CLASSES.some((c) => c.value === searchParams.conditionClass)
    ? (searchParams.conditionClass as ConditionClassFilter)
    : "ALL";

  const instrumentRows = await db.instrument.findMany({
    where: { entityId, type: awardType },
    include: {
      stakeholder: true,
      termVersions: { orderBy: { effectiveDate: "desc" }, take: 1 },
      exerciseEvents: awardType === "STOCK_OPTION",
      forfeitureEvents: true,
    },
  });

  const rollforwardInstruments: AwardRollforwardInstrument[] = [];
  const stockCompInputs: StockCompInstrumentInput[] = [];
  const stockCompWarnings: string[] = [];

  for (const inst of instrumentRows) {
    const terms = (inst.termVersions[0]?.terms ?? {}) as Record<string, unknown>;
    const grantDate = String(terms.grantDate ?? inst.issueDate.toISOString().slice(0, 10));
    const conditionType = readConditionType(terms);

    rollforwardInstruments.push({
      instrumentId: inst.id,
      grantDate,
      quantity: String(terms.quantity ?? "0"),
      conditionType,
      strikePrice: terms.strikePrice !== undefined ? String(terms.strikePrice) : undefined,
      grantDateFairValuePerUnit: terms.grantDateFairValuePerUnit !== undefined ? String(terms.grantDateFairValuePerUnit) : undefined,
      tranches: Array.isArray(terms.tranches)
        ? (terms.tranches as Record<string, unknown>[]).map((t) => ({ vestDate: String(t.vestDate ?? ""), quantity: String(t.quantity ?? "0") }))
        : [],
    });

    // Same "ASC 718 unrecognized compensation cost" input assembly as
    // financial-statements/page.tsx, filtered to the same award-type/class selection
    // rather than duplicated across every equity-comp type.
    if (conditionClass === "ALL" || conditionType === conditionClass) {
      const tranches = Array.isArray(terms.tranches) ? (terms.tranches as { vestDate?: string }[]) : [];
      if (!terms.quantity || !terms.grantDateFairValuePerUnit || tranches.length === 0) {
        stockCompWarnings.push(`${inst.stakeholder.name} (${inst.type}): missing data on its latest term version — excluded from unrecognized cost below.`);
      } else {
        const serviceEndDate = tranches.map((t) => String(t.vestDate ?? "")).sort().slice(-1)[0];
        stockCompInputs.push({
          instrumentId: inst.id,
          stakeholderName: inst.stakeholder.name,
          type: inst.type,
          totalGrantDateFairValue: money(String(terms.quantity)).times(String(terms.grantDateFairValuePerUnit)).toFixed(4),
          cumulativeExpenseRecognized: "0", // recomputed just below, once we know which instruments passed the filter
          serviceEndDate,
          asOfDate: periodEnd,
        });
      }
    }
  }

  // Recognized-to-date amounts, fetched only for the instruments that passed the
  // award-type/class filter above — same aggregate-per-instrument approach
  // financial-statements/page.tsx uses, just batched here instead of awaited in the
  // loop (that page's instrument count is typically small enough not to matter either
  // way, but there's no reason to serialize N round trips when Promise.all is free).
  const recognizedAggs = await Promise.all(
    stockCompInputs.map((s) =>
      db.scheduleEntry.aggregate({
        where: { instrumentId: s.instrumentId, periodEnd: { lte: new Date(periodEnd) }, supersededByCorrectionId: null },
        _sum: { amount: true },
      })
    )
  );
  stockCompInputs.forEach((s, i) => {
    s.cumulativeExpenseRecognized = recognizedAggs[i]._sum.amount?.toString() ?? "0";
  });
  const stockCompDisclosure = buildStockCompDisclosure(stockCompInputs);

  const rollforward = buildAwardRollforward({
    awardType,
    conditionClass,
    periodStart,
    periodEnd,
    instruments: rollforwardInstruments,
    exerciseEvents: instrumentRows.flatMap((inst) =>
      (inst.exerciseEvents ?? []).map((e) => ({
        instrumentId: inst.id,
        exerciseDate: e.exerciseDate.toISOString().slice(0, 10),
        quantityExercised: e.quantityExercised.toString(),
        exercisePricePerShare: e.exercisePricePerShare.toString(),
      }))
    ),
    forfeitureEvents: instrumentRows.flatMap((inst) =>
      inst.forfeitureEvents.map((e) => ({
        instrumentId: inst.id,
        forfeitureDate: e.forfeitureDate.toISOString().slice(0, 10),
        quantityForfeited: e.quantityForfeited.toString(),
        eventType: e.eventType,
      }))
    ),
  });

  // Intrinsic value realized + cash received from exercises IN THE PERIOD — real
  // OptionExerciseEvent data, options only (RSUs have no exercise price — see
  // computeIntrinsicValueRealized's own doc comment on the RSU case). Only meaningful
  // when awardType is STOCK_OPTION; left null for RSU rather than a misleading zero.
  let intrinsicValueRealized: string | null = null;
  let cashReceivedFromExercises: string | null = null;
  if (awardType === "STOCK_OPTION") {
    const exercisesInPeriod = instrumentRows.flatMap((inst) => {
      const terms = (inst.termVersions[0]?.terms ?? {}) as Record<string, unknown>;
      const conditionType = readConditionType(terms);
      if (conditionClass !== "ALL" && conditionType !== conditionClass) return [];
      return (inst.exerciseEvents ?? [])
        .filter((e) => {
          const d = e.exerciseDate.toISOString().slice(0, 10);
          return d > periodStart && d <= periodEnd;
        })
        .map((e) => ({
          quantity: e.quantityExercised.toString(),
          exercisePricePerUnit: e.exercisePricePerShare.toString(),
          fairMarketValuePerUnitAtExercise: e.fairMarketValuePerShareAtExercise.toString(),
        }));
    });
    intrinsicValueRealized = computeIntrinsicValueRealized(exercisesInPeriod).toFixed(2);
    cashReceivedFromExercises = exercisesInPeriod
      .reduce((sum, e) => sum.plus(money(e.quantity).times(e.exercisePricePerUnit)), money(0))
      .toFixed(2);
  }

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1050 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/reports/financial-statements?entityId=${entityId}`}>Financial statement support</Link> {" · "}
        <Link href={`/captable?entityId=${entityId}`}>Cap table</Link>
      </p>
      <h1>ASC 718 disclosures</h1>
      <p style={{ color: theme.inkMuted }}>
        Award activity roll-forward and related ASC 718 disclosures, computed from actual recorded grants, exercises,
        and forfeitures/expirations — not hand-entered. See{" "}
        <Link href="/reports/equity-comp-disclosures">Equity comp footnote disclosures</Link> for a quick manual
        what-if calculator instead.
      </p>

      <form method="get" style={filterFormStyle}>
        <input type="hidden" name="entityId" value={entityId} />
        <label style={filterLabelStyle}>
          Beginning
          <input type="date" name="periodStart" defaultValue={periodStart} style={filterInputStyle} />
        </label>
        <label style={filterLabelStyle}>
          Ending
          <input type="date" name="periodEnd" defaultValue={periodEnd} style={filterInputStyle} />
        </label>
        <label style={filterLabelStyle}>
          Award type
          <select name="awardType" defaultValue={awardType} style={filterInputStyle}>
            {AWARD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label style={filterLabelStyle}>
          Vesting class
          <select name="conditionClass" defaultValue={conditionClass} style={filterInputStyle}>
            {CONDITION_CLASSES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" style={filterButtonStyle}>
          Update
        </button>
      </form>

      {rollforward.warnings.length > 0 && (
        <ul>
          {rollforward.warnings.map((w, i) => (
            <li key={i} style={{ color: theme.warning.fg }}>
              {w}
            </li>
          ))}
        </ul>
      )}

      <h2>
        Award activity roll-forward — {AWARD_TYPES.find((t) => t.value === awardType)?.label}, {periodStart} to {periodEnd}
      </h2>
      <ListingTable
        columns={[
          { label: `Outstanding at ${periodStart}` },
          { label: "Granted", align: "right" },
          { label: rollforward.reducedLabel, align: "right" },
          { label: "Forfeited", align: "right" },
          { label: "Expired", align: "right" },
          { label: `Outstanding at ${periodEnd}`, align: "right" },
        ]}
        rows={[
          {
            key: "totals",
            cells: [
              rollforward.outstandingAtStart.toFixed(2),
              rollforward.granted.toFixed(2),
              rollforward.reduced.toFixed(2),
              rollforward.forfeited.toFixed(2),
              rollforward.expired.toFixed(2),
              rollforward.outstandingAtEnd.toFixed(2),
            ],
          },
        ]}
      />
      <p style={{ color: theme.inkMuted, fontSize: "0.9rem" }}>
        {rollforward.priceLabel}: {rollforward.priceAtStart.toFixed(2)} at {periodStart} → {rollforward.priceAtEnd.toFixed(2)} at{" "}
        {periodEnd}. Based on {rollforward.instrumentCount} grant(s) matching this selection.
      </p>

      <h2>Unrecognized compensation cost</h2>
      {stockCompWarnings.length > 0 && (
        <ul>
          {stockCompWarnings.map((w, i) => (
            <li key={i} style={{ color: theme.warning.fg }}>
              {w}
            </li>
          ))}
        </ul>
      )}
      {stockCompDisclosure.rows.length === 0 ? (
        <p>No grants with usable data for this selection.</p>
      ) : (
        <p>
          Total unrecognized cost as of {periodEnd}: <strong>{stockCompDisclosure.totalUnrecognizedCompCost.toFixed(2)}</strong>, expected
          to be recognized over a weighted-average remaining period of{" "}
          <strong>{stockCompDisclosure.weightedAverageRemainingYears.toFixed(2)} years</strong>.
        </p>
      )}

      {awardType === "STOCK_OPTION" && (
        <>
          <h2>Exercise activity — {periodStart} to {periodEnd}</h2>
          <p>
            Intrinsic value realized: <strong>{intrinsicValueRealized}</strong> · Cash received from exercises:{" "}
            <strong>{cashReceivedFromExercises}</strong>
          </p>
        </>
      )}

      <p style={{ color: theme.inkMuted, fontSize: "0.85rem", marginTop: "2rem" }}>
        Not included above (no data source exists in this app yet): weighted-average remaining contractual term and
        aggregate intrinsic value of options outstanding/exercisable (needs a current fair-market-value-per-share
        input this platform doesn't track company-wide), and the Black-Scholes/lattice valuation assumptions table.
      </p>
    </main>
  );
}

const filterFormStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: "1rem",
  margin: "1rem 0 1.5rem",
  padding: "0.75rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
};
const filterLabelStyle: React.CSSProperties = { fontSize: "0.85rem" };
const filterInputStyle: React.CSSProperties = { display: "block", padding: "0.35rem", marginTop: "0.25rem" };
const filterButtonStyle: React.CSSProperties = {
  padding: "0.45rem 0.9rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
};
