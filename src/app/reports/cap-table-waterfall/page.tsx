import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { computeVisibleSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { CapTableInstrumentInput } from "@/lib/accounting/capTable";
import { buildWaterfallClassesFromCapTable } from "@/lib/accounting/capTableWaterfall";
import { buildWaterfallSensitivity, findWaterfallBreakpoints } from "@/lib/accounting/waterfallAnalysis";
import { Decimal } from "@/lib/accounting/types";
import { requirePageEntityAccess, requireCurrentUser } from "@/lib/auth/pageGuard";
import CapTableWaterfallCalculator, { WaterfallClassSummary } from "@/app/components/CapTableWaterfallCalculator";
import WaterfallBreakpoints from "@/app/components/WaterfallBreakpoints";
import WaterfallSensitivityAnalysis from "@/app/components/WaterfallSensitivityAnalysis";
import { theme } from "@/lib/theme";

/**
 * Cap table waterfall report (v0.31.0) — George's ask, verbatim: "we should have a
 * waterfall report for the capitalization table (Depending on the ownership
 * rights/seniority) showing current priorities. we should also build in a scenario
 * analysis function showing different impacts on waterfall."
 *
 * This is the real-data counterpart to /reports/exit-waterfall: that page is (and
 * remains) a standalone calculator where the caller types in the whole class stack by
 * hand. This page instead reads THIS entity's actual stored preferred-stock terms
 * (seniority rank, liquidation-preference multiple, participation — the new
 * `LiquidationPreferenceTerms` on `PreferredStockInstrumentTerms`, see dispatch.ts),
 * derives the waterfall class stack from them via `buildWaterfallClassesFromCapTable`,
 * and shows the resulting "current priorities" ordering before any exit-value math
 * even runs. The exit-value input (and the scenario-analysis comparison across several
 * exit values) is handed off to CapTableWaterfallCalculator.tsx, which calls
 * POST /api/reports/cap-table-waterfall to actually run the numbers — that route
 * re-derives the class stack itself server-side rather than trusting whatever this
 * page rendered, so a stale page load can't feed a stale stack into the calculation.
 *
 * Same "flag rather than silently drop" posture as /captable and cap-table-export:
 * a PREFERRED_STOCK instrument with no liquidationPreference recorded, or a series
 * whose holders disagree on its own terms, is surfaced in the "Not included" section
 * below (from `excluded`) instead of being guessed at or dropped without a trace. Debt
 * (TERM_LOAN/REVOLVER/PIK_NOTE) is excluded from the waterfall ON PURPOSE, not a gap —
 * see capTableWaterfall.ts's module doc comment: a real liquidation pays creditors
 * before any equity waterfall begins, so the exit proceeds entered here are assumed to
 * already be the equity value left AFTER debt is repaid.
 *
 * v0.32.0 adds the two analyses George asked for after comparing this against what
 * Carta and Pulley ship: breakpoint analysis (WaterfallBreakpoints.tsx — the exit value
 * each class needs to see any money, or to flip from taking its preference to
 * converting, or to hit a participation cap) and sensitivity analysis
 * (WaterfallSensitivityAnalysis.tsx — a payout curve for every class across a
 * continuous range of exit values, Carta's own "line graph of payouts... across a
 * range of exit values"). Both render immediately on page load with a server-computed
 * default range/ceiling — see `defaultAnalysisCeiling` below — the same "no user input
 * required, since your cap table is already here" posture Carta's automatic breakpoint
 * view takes, and both can be re-run with a different range from the client component
 * itself via POST /api/reports/cap-table-waterfall's `breakpointsMax`/`sensitivity`
 * request fields. See waterfallAnalysis.ts for why these are built as repeated/
 * bisected `buildExitWaterfall` calls rather than separately-derived formulas.
 *
 * NOT EXECUTED IN THIS SANDBOX — no Postgres, no installed Next.js/React here.
 */
export default async function CapTableWaterfallPage({ searchParams }: { searchParams: { entityId?: string } }) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    if (user.defaultEntityId) redirect(`/reports/cap-table-waterfall?entityId=${user.defaultEntityId}`);
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view this report, or go to <Link href="/">the entity list</Link>
          (or set a default entity there).
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "VIEWER");

  const stakeholders = await db.stakeholder.findMany({
    where: { entityId },
    include: {
      instruments: {
        include: { termVersions: { orderBy: { effectiveDate: "desc" }, take: 1 } },
      },
    },
    orderBy: { name: "asc" },
  });

  const today = new Date().toISOString().slice(0, 10);
  const rollupInputs: CapTableInstrumentInput[] = [];
  const computeWarnings: { instrumentId: string; stakeholderName: string; type: string; message: string }[] = [];

  for (const s of stakeholders) {
    for (const inst of s.instruments) {
      const latestTerms = inst.termVersions[0]?.terms;
      if (latestTerms === undefined) continue;
      const type = inst.type as InstrumentTypeForDispatch;
      const isDebtType = type === "TERM_LOAN" || type === "REVOLVER" || type === "PIK_NOTE";
      let outstandingBalance: string | undefined;
      if (isDebtType) {
        try {
          const schedule = computeVisibleSchedule(
            type,
            inst.termVersions.map((v) => ({
              effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
              label: v.label,
              terms: v.terms,
            })),
            today
          );
          outstandingBalance = schedule[schedule.length - 1]?.endingBalance?.toString();
        } catch (err) {
          computeWarnings.push({
            instrumentId: inst.id,
            stakeholderName: s.name,
            type,
            message: err instanceof Error ? err.message : "Failed to compute current balance",
          });
        }
      }
      rollupInputs.push({
        instrumentId: inst.id,
        stakeholderId: s.id,
        stakeholderName: s.name,
        type,
        terms: latestTerms,
        outstandingBalance,
      });
    }
  }

  const { classes, excluded } = buildWaterfallClassesFromCapTable(rollupInputs);
  const sortedClasses = classes.slice().sort((a, b) => a.seniorityRank - b.seniorityRank);
  const classSummaries: WaterfallClassSummary[] = sortedClasses.map((c) => ({
    id: c.id,
    name: c.name,
    seniorityRank: c.seniorityRank,
    shares: c.shares.toString(),
    liquidationPreferencePerShare: c.liquidationPreferencePerShare.toString(),
    participating: c.participating,
    participationCap: c.participationCap !== undefined ? c.participationCap.toString() : null,
  }));

  // Default search ceiling / range for breakpoints and sensitivity: 10x the larger of
  // (a) the total preference stack across every class, or (b) the total participation-
  // cap amount where set — comfortably above where any class's own breakpoints could
  // occur (a class can never need MORE than its own preference stack to break even,
  // and a cap can never bind below the cap amount itself). Floors at $1,000,000 so an
  // all-common cap table (no preference at all) still gets a sensible, nonzero range
  // instead of a degenerate $0–$0 sweep. This is a search ceiling for the analysis, not
  // a real assumption about the entity's value — the UI lets it be widened.
  let totalPreference = new Decimal(0);
  let totalCapAmount = new Decimal(0);
  for (const c of classes) {
    totalPreference = totalPreference.plus(new Decimal(c.liquidationPreferencePerShare).times(c.shares));
    if (c.participationCap !== undefined) {
      totalCapAmount = totalCapAmount.plus(new Decimal(c.participationCap).times(c.shares));
    }
  }
  const baseline = Decimal.max(totalPreference, totalCapAmount, new Decimal(1_000_000));
  const defaultAnalysisCeiling = baseline.times(10);

  let breakpointSummaries: ReturnType<typeof findWaterfallBreakpoints> = [];
  let sensitivityPoints: ReturnType<typeof buildWaterfallSensitivity> = [];
  if (classes.length > 0) {
    breakpointSummaries = findWaterfallBreakpoints(classes, defaultAnalysisCeiling);
    sensitivityPoints = buildWaterfallSensitivity(classes, { min: 0, max: defaultAnalysisCeiling, steps: 20 });
  }
  const serializedBreakpoints = breakpointSummaries.map((b) => ({
    id: b.id,
    name: b.name,
    breakevenExitProceeds: b.breakevenExitProceeds !== null ? b.breakevenExitProceeds.toFixed(2) : null,
    conversionBreakpointExitProceeds: b.conversionBreakpointExitProceeds !== null ? b.conversionBreakpointExitProceeds.toFixed(2) : null,
    participationCapBreakpointExitProceeds:
      b.participationCapBreakpointExitProceeds !== null ? b.participationCapBreakpointExitProceeds.toFixed(2) : null,
  }));
  const serializedSensitivity = sensitivityPoints.map((p) => ({
    exitProceeds: p.exitProceeds.toFixed(2),
    classResults: p.classResults.map((r) => ({ id: r.id, name: r.name, totalProceeds: r.totalProceeds.toFixed(2) })),
  }));
  const breakpointsClassSummaries = sortedClasses.map((c) => ({
    id: c.id,
    name: c.name,
    participating: c.participating,
    hasParticipationCap: c.participationCap !== undefined,
  }));

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1100 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${entityId}`}>Cap table</Link> {" · "}
        <Link href="/reports/exit-waterfall">Standalone exit waterfall calculator</Link>
      </p>
      <h1>Cap table waterfall</h1>
      <p style={{ color: theme.inkMuted }}>
        Current priorities on exit, derived from this entity&apos;s actual stored seniority, liquidation-preference,
        and participation terms — not a hand-typed hypothetical. Debt (term loans, revolvers, PIK notes) is
        excluded from the class stack; the exit proceeds you enter below are assumed to already be the equity value
        available after outstanding debt is repaid.
      </p>

      <h2>Current priorities (seniority order)</h2>
      {classSummaries.length === 0 ? (
        <p style={{ color: theme.warning.fg }}>
          No waterfall classes could be derived yet — add liquidation-preference terms to at least one preferred
          stock instrument, or common/option/warrant instruments to form the common pool. See &ldquo;Not
          included&rdquo; below for specifics.
        </p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Seniority</th>
              <th style={cellStyle}>Class</th>
              <th style={cellStyle}>As-converted shares</th>
              <th style={cellStyle}>Preference / share</th>
              <th style={cellStyle}>Participating?</th>
              <th style={cellStyle}>Participation cap / share</th>
            </tr>
          </thead>
          <tbody>
            {classSummaries.map((c) => (
              <tr key={c.id}>
                <td style={cellStyle}>{c.seniorityRank === Number.MAX_SAFE_INTEGER ? "Last (common)" : c.seniorityRank}</td>
                <td style={cellStyle}>{c.name}</td>
                <td style={cellStyle}>{c.shares}</td>
                <td style={cellStyle}>${Number(c.liquidationPreferencePerShare).toFixed(2)}</td>
                <td style={cellStyle}>{c.participating ? "Yes" : "No"}</td>
                <td style={cellStyle}>{c.participationCap ? `$${Number(c.participationCap).toFixed(2)}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(excluded.length > 0 || computeWarnings.length > 0) && (
        <>
          <h2 style={{ color: theme.warning.fg }}>Not included above</h2>
          <ul>
            {excluded.map((e, i) => (
              <li key={`${e.instrumentId}-${i}`} style={{ color: theme.warning.fg }}>
                <Link href={`/instruments/${e.instrumentId}`}>{e.stakeholderName}</Link> ({e.type}): {e.reason}
              </li>
            ))}
            {computeWarnings.map((w) => (
              <li key={w.instrumentId} style={{ color: theme.warning.fg }}>
                <Link href={`/instruments/${w.instrumentId}`}>{w.stakeholderName}</Link> ({w.type}): {w.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {classSummaries.length > 0 && (
        <>
          <h2>Breakpoint analysis</h2>
          <WaterfallBreakpoints
            entityId={entityId}
            classes={breakpointsClassSummaries}
            initialBreakpoints={serializedBreakpoints}
            initialMax={defaultAnalysisCeiling.toFixed(0)}
          />

          <h2>Sensitivity analysis</h2>
          <WaterfallSensitivityAnalysis
            entityId={entityId}
            classes={sortedClasses.map((c) => ({ id: c.id, name: c.name }))}
            initialPoints={serializedSensitivity}
            initialMin="0"
            initialMax={defaultAnalysisCeiling.toFixed(0)}
            initialSteps={20}
          />

          <CapTableWaterfallCalculator entityId={entityId} classes={classSummaries} />
        </>
      )}
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.5rem", textAlign: "left" };
