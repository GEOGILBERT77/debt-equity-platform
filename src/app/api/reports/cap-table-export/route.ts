import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeVisibleSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { buildCapTableRollup, CapTableInstrumentInput } from "@/lib/accounting/capTable";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { escapeCsvCell } from "@/lib/api/csv";
import { conditionalResponse } from "@/lib/api/caching";

/**
 * GET /api/reports/cap-table-export?entityId=...
 *
 * Cap table / equity reporting (v0.19.0): a real downloadable export of the same
 * fully-diluted rollup the /captable page renders as HTML — "send this to counsel /
 * an investor / your accountant" is a genuinely different need than "look at it on
 * screen," and until now there was no way to get the numbers out of this app at all
 * except copy-pasting an HTML table. CSV rather than XLSX: no new dependency, and
 * every spreadsheet tool and cap table vendor (Carta's own bulk-upload format
 * included) reads CSV natively — see INTEGRATIONS.md for where a real Carta/Pulley
 * import format would need to diverge from this generic shape.
 *
 * Deliberately duplicates the query/rollup logic already in src/app/captable/page.tsx
 * rather than importing from it — same reasoning that page's own doc comment gives for
 * not fetching its own API route from within a server component; there's no clean way
 * to share a Next.js page's data-fetching with an API route without a third shared
 * module, which isn't worth introducing for logic this short.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest) {
  const entityId = req.nextUrl.searchParams.get("entityId");
  if (!entityId) {
    return NextResponse.json({ error: "entityId query parameter is required" }, { status: 400 });
  }

  const access = await requireApiEntityAccess(req, entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  // `select` rather than `include` (v0.20.0 — "trim over-fetched API responses," a
  // Performance & Scaling item): this route only ever reads stakeholder id/name and a
  // handful of instrument/term-version fields below, but `include` would have pulled
  // every scalar column on Stakeholder — email, phone, address among them — into
  // memory for every stakeholder on the entity just to build a CSV that uses none of
  // it. `select` narrows the base model too, which `include` can't do.
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
    orderBy: { name: "asc" },
  });

  const today = new Date().toISOString().slice(0, 10);
  const rollupInputs: CapTableInstrumentInput[] = [];

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
        } catch {
          // Same "flag rather than crash the whole export" approach as the cap table
          // page — but a CSV row has no natural place for a warning message, so an
          // instrument that fails to compute is simply omitted from the export here
          // rather than shown with a placeholder value that could be mistaken for a
          // real balance. Use the /captable page itself to see which ones and why.
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

  const rollup = buildCapTableRollup(rollupInputs);

  // CSV/formula-injection guard (v0.20.0 — the free-text-field injection review item
  // in the task-status spreadsheet) — see src/lib/api/csv.ts's module doc comment for
  // the full explanation. `stakeholderName` and `note`/`reason` below are free-text
  // fields a user entered (a stakeholder's name, a correction reason); without this,
  // a name starting with "=", "+", "-", or "@" would be interpreted as a live formula
  // the instant this file is opened in Excel or Google Sheets.
  const escapeCsv = escapeCsvCell;
  const lines: string[] = ["Stakeholder,Type,Category,Shares,Ownership %,Outstanding Balance,Note"];

  for (const r of rollup.equityRows) {
    lines.push(
      [
        escapeCsv(r.stakeholderName),
        r.type,
        "Equity",
        r.shares?.toString() ?? "",
        r.ownershipPercent ? r.ownershipPercent.toFixed(4) : "",
        "",
        escapeCsv(r.note ?? ""),
      ].join(",")
    );
  }
  for (const r of rollup.debtRows) {
    lines.push([escapeCsv(r.stakeholderName), r.type, "Debt", "", "", r.outstandingBalance?.toString() ?? "", ""].join(","));
  }
  for (const u of rollup.unsupported) {
    lines.push([escapeCsv(u.stakeholderName), u.type, "Not included", "", "", "", escapeCsv(u.reason)].join(","));
  }
  lines.push(["TOTAL", "", "", rollup.totalFullyDilutedShares.toString(), "100.0000", "", ""].join(","));

  const csv = lines.join("\n") + "\n";

  // Conditional GET / ETag (v0.20.0 — see src/lib/api/caching.ts): a client
  // re-downloading the same day's export with nothing changed gets a 304 instead of
  // re-transferring the whole CSV body.
  return conditionalResponse(req, csv, {
    contentType: "text/csv; charset=utf-8",
    extraHeaders: { "Content-Disposition": `attachment; filename="cap-table-${entityId}-${today}.csv"` },
  });
}
