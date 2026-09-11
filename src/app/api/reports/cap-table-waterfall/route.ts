import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeVisibleSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { CapTableInstrumentInput } from "@/lib/accounting/capTable";
import { buildWaterfallClassesFromCapTable } from "@/lib/accounting/capTableWaterfall";
import { buildExitWaterfallScenarios, ExitWaterfallScenario, WaterfallClassInput } from "@/lib/accounting/exitWaterfall";
import { buildWaterfallSensitivity, findWaterfallBreakpoints } from "@/lib/accounting/waterfallAnalysis";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/cap-table-waterfall
 *   { "entityId": "...",
 *     "scenarios"?: [ { "label": "Base case", "exitProceeds": "50000000" }, ... ],
 *     "sensitivity"?: { "min": "0", "max": "200000000", "steps": 20 },
 *     "breakpointsMax"?: "500000000" }
 *
 * v0.31.0 gave this report the "run it on THIS entity's actual stack" scenario
 * comparison (`scenarios`) that /reports/exit-waterfall's standalone calculator never
 * had. v0.32.0 adds the two analyses George specifically asked for after comparing
 * this against Carta and Pulley's own waterfall products: SENSITIVITY (a payout curve
 * for every class across a continuous RANGE of exit values — Carta's own "line graph
 * of payouts... across a range of exit values") and BREAKPOINTS (the specific exit
 * values where a class's treatment actually changes — Carta's "what exit valuation
 * would each share class need to participate in payouts"). See
 * waterfallAnalysis.ts's module doc comment for why both are built as repeated/
 * bisected calls into the same `buildExitWaterfall` rather than separately-derived
 * formulas.
 *
 * All three sections (`scenarios`, `sensitivity`, `breakpoints`) are independently
 * optional in the request — the report page requests sensitivity + breakpoints with
 * sensible defaults on first load (so, like Carta's "since your equity data is already
 * on Carta," these show up with no user input at all), and the scenario comparison
 * only once the user has actually entered exit values to compare. Every section reuses
 * the SAME server-derived class stack from a single query — the class stack is never
 * taken from the request body, so a caller cannot fabricate the stack that gets run.
 *
 * Re-derives the same `CapTableInstrumentInput[]` the /captable page and the
 * cap-table-export route each build from `db.stakeholder.findMany` — deliberately
 * duplicated rather than shared, same reasoning cap-table-export's own doc comment
 * gives (no clean way to share a page's data-fetching with an API route without a
 * third shared module not worth introducing for logic this short).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { entityId, scenarios, sensitivity, breakpointsMax } = body ?? {};

  if (!entityId || typeof entityId !== "string") {
    return NextResponse.json({ error: "entityId is required" }, { status: 400 });
  }

  const access = await requireApiEntityAccess(req, entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  const wantsScenarios = scenarios !== undefined;
  const wantsSensitivity = sensitivity !== undefined;
  const wantsBreakpoints = breakpointsMax !== undefined;
  if (!wantsScenarios && !wantsSensitivity && !wantsBreakpoints) {
    return NextResponse.json(
      { error: "Request at least one of: scenarios, sensitivity, breakpointsMax" },
      { status: 400 }
    );
  }

  if (wantsScenarios) {
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      return NextResponse.json({ error: "scenarios must be a non-empty array of { label, exitProceeds }" }, { status: 400 });
    }
    for (const [i, s] of scenarios.entries()) {
      if (!s || typeof s.label !== "string" || s.label.trim() === "") {
        return NextResponse.json({ error: `scenarios[${i}] is missing a label` }, { status: 400 });
      }
      if (s.exitProceeds === undefined || s.exitProceeds === null || s.exitProceeds === "") {
        return NextResponse.json({ error: `scenarios[${i}] is missing exitProceeds` }, { status: 400 });
      }
    }
  }
  if (wantsSensitivity) {
    if (!sensitivity || sensitivity.min === undefined || sensitivity.max === undefined || !Number.isInteger(sensitivity.steps)) {
      return NextResponse.json({ error: "sensitivity requires { min, max, steps } with steps as an integer" }, { status: 400 });
    }
  }
  if (wantsBreakpoints) {
    if (breakpointsMax === null || breakpointsMax === "") {
      return NextResponse.json({ error: "breakpointsMax must be a positive number" }, { status: 400 });
    }
  }

  const stakeholders = await db.stakeholder.findMany({
    where: { entityId },
    select: {
      id: true,
      name: true,
      instruments: {
        select: {
          id: true,
          type: true,
          termVersions: {
            select: { effectiveDate: true, label: true, terms: true },
            orderBy: { effectiveDate: "desc" },
            take: 1,
          },
        },
      },
    },
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
            inst.termVersions.map((v) => ({ effectiveDate: v.effectiveDate.toISOString().slice(0, 10), label: v.label, terms: v.terms })),
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

  if (classes.length === 0) {
    return NextResponse.json(
      { error: "No waterfall classes could be derived from this entity's cap table — see the excluded list for why.", excluded },
      { status: 400 }
    );
  }

  const sortedClasses = classes.slice().sort((a, b) => a.seniorityRank - b.seniorityRank);

  const responseBody: Record<string, unknown> = {
    classes: sortedClasses.map(serializeClass),
    excluded,
    computeWarnings,
  };

  if (wantsScenarios) {
    let scenarioResults;
    try {
      scenarioResults = buildExitWaterfallScenarios(scenarios as ExitWaterfallScenario[], classes);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the waterfall" }, { status: 400 });
    }
    responseBody.scenarios = scenarioResults.map(({ label, result }) => ({
      label,
      exitProceeds: result.exitProceeds.toFixed(2),
      totalDistributed: result.totalDistributed.toFixed(2),
      undistributed: result.undistributed.toFixed(2),
      classResults: result.classResults.map(serializeClassResult),
    }));
  }

  if (wantsSensitivity) {
    let points;
    try {
      points = buildWaterfallSensitivity(classes, sensitivity);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute sensitivity analysis" }, { status: 400 });
    }
    responseBody.sensitivity = points.map((p) => ({
      exitProceeds: p.exitProceeds.toFixed(2),
      classResults: p.classResults.map(serializeClassResult),
    }));
  }

  if (wantsBreakpoints) {
    let breakpoints;
    try {
      breakpoints = findWaterfallBreakpoints(classes, breakpointsMax);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute breakpoints" }, { status: 400 });
    }
    responseBody.breakpoints = breakpoints.map((b) => ({
      id: b.id,
      name: b.name,
      breakevenExitProceeds: b.breakevenExitProceeds !== null ? b.breakevenExitProceeds.toFixed(2) : null,
      conversionBreakpointExitProceeds: b.conversionBreakpointExitProceeds !== null ? b.conversionBreakpointExitProceeds.toFixed(2) : null,
      participationCapBreakpointExitProceeds:
        b.participationCapBreakpointExitProceeds !== null ? b.participationCapBreakpointExitProceeds.toFixed(2) : null,
    }));
  }

  return NextResponse.json(responseBody);
}

function serializeClass(c: WaterfallClassInput & { shares: any; liquidationPreferencePerShare: any; participationCap?: any }) {
  return {
    id: c.id,
    name: c.name,
    seniorityRank: c.seniorityRank,
    shares: c.shares.toString(),
    liquidationPreferencePerShare: c.liquidationPreferencePerShare.toString(),
    participating: c.participating,
    participationCap: c.participationCap !== undefined ? c.participationCap.toString() : null,
  };
}

function serializeClassResult(r: {
  id: string;
  name: string;
  shares: any;
  converted: boolean;
  cappedByParticipation: boolean;
  proceedsFromPreference: any;
  proceedsFromResidual: any;
  totalProceeds: any;
  perShareProceeds: any;
}) {
  return {
    id: r.id,
    name: r.name,
    shares: r.shares.toString(),
    converted: r.converted,
    cappedByParticipation: r.cappedByParticipation,
    proceedsFromPreference: r.proceedsFromPreference.toFixed(2),
    proceedsFromResidual: r.proceedsFromResidual.toFixed(2),
    totalProceeds: r.totalProceeds.toFixed(2),
    perShareProceeds: r.perShareProceeds.toFixed(4),
  };
}
