import Link from "next/link";
import { theme } from "@/lib/theme";
import { db } from "@/lib/db";
import { computeVisibleSchedule, computeFullSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { CloseInstrumentButton } from "@/app/components/CloseInstrumentButton";
import { CorrectionPanel } from "@/app/components/CorrectionPanel";
import { ApproveAmortizationScheduleButton } from "@/app/components/ApproveAmortizationScheduleButton";
import { PerformanceConditionAssessmentPanel } from "@/app/components/PerformanceConditionAssessmentPanel";
import { ScheduleGridTable } from "@/app/components/ScheduleGridTable";
import { requirePageEntityAccess } from "@/lib/auth/pageGuard";
import { attachPerformanceConditionAssessments } from "@/lib/db/performanceConditions";

/**
 * Schedule + term-version-history viewer for one instrument. The term-version table at
 * the bottom is the modification audit trail made visible — every row there is an
 * InstrumentTermVersion, in the order it was recorded, never edited after the fact.
 *
 * Shows THREE distinct things, deliberately not collapsed into one table, because
 * conflating them is exactly the mistake the "Live preview vs. closed/reported numbers"
 * section of the README warns about:
 *   1. The live-computed schedule (recomputed on every page load — a preview).
 *   2. What's actually been closed/persisted (ScheduleEntry rows — the real record).
 *   3. The journal entries booked for what's closed (JournalEntry/JournalLine rows).
 * The "Close through today" button is what moves rows from (1) into (2) and (3).
 *
 * NOT EXECUTED IN THIS SANDBOX — see captable/page.tsx for the same caveat.
 */
export default async function InstrumentPage({ params }: { params: { id: string } }) {
  const instrument = await db.instrument.findUnique({
    where: { id: params.id },
    include: {
      stakeholder: true,
      entity: true,
      termVersions: {
        orderBy: { effectiveDate: "asc" },
        include: {
          // v0.38.0 — only ever populated for the LATEST term version below, but
          // fetched on all of them here since Prisma's `include` on a to-many relation
          // can't be conditioned on which row it is — negligible cost since a grant
          // has at most a handful of term versions.
          performanceCondition: { include: { assessments: { orderBy: { effectiveDate: "desc" }, take: 1 }, _count: { select: { termVersions: true } } } },
        },
      },
    },
  });

  if (!instrument) {
    return <p>No instrument found with id "{params.id}".</p>;
  }

  // VIEWER is enough to see this page — the write actions on it (CloseInstrumentButton,
  // CorrectionPanel) hit API routes that independently require EDITOR, so a VIEWER
  // loading this page just sees controls that will 404 if they try to use them. Giving
  // VIEWER-only users a cleaner "read-only" rendering of this page (hiding those
  // buttons rather than letting them fail) is left as a front-end polish item, not a
  // security gap — the API is what actually enforces the boundary.
  await requirePageEntityAccess(instrument.entityId, "VIEWER");

  const today = new Date().toISOString().slice(0, 10);

  let scheduleError: string | null = null;
  let schedule: ReturnType<typeof computeVisibleSchedule> = [];
  try {
    // computeVisibleSchedule, not a manually-truncated buildAnnualPeriods +
    // computeScheduleForInstrument — see dispatch.ts's CORRECTNESS NOTE for why the
    // naive pattern silently overstated stock comp / revolver fee schedules here.
    schedule = computeVisibleSchedule(
      instrument.type as InstrumentTypeForDispatch,
      await attachPerformanceConditionAssessments(instrument.termVersions),
      today
    );
  } catch (err) {
    scheduleError = err instanceof Error ? err.message : "Failed to compute schedule";
  }

  const [closedRows, journalEntries, latestApproval] = await Promise.all([
    db.scheduleEntry.findMany({
      where: { instrumentId: instrument.id, supersededByCorrectionId: null },
      orderBy: { periodEnd: "asc" },
    }),
    db.journalEntry.findMany({
      where: { instrumentId: instrument.id, supersededByCorrectionId: null },
      include: { lines: true },
      orderBy: { date: "asc" },
    }),
    db.amortizationScheduleApproval.findFirst({
      where: { instrumentId: instrument.id },
      orderBy: { approvedAt: "desc" },
      include: { rows: { orderBy: { periodEnd: "asc" } }, approvedByUser: true },
    }),
  ]);

  // v0.22.0 — the full, end-to-end MONTHLY amortization table (see computeFullSchedule's
  // doc comment in dispatch.ts): only meaningful for instrument types with a natural end
  // date (STOCK_OPTION, RSU, RESTRICTED_STOCK, ...). Silently omitted below for any type
  // where it throws for THAT specific, expected reason; any other error is shown, since
  // that would mean something is actually wrong rather than "this type doesn't have one."
  let fullMonthlySchedule: ReturnType<typeof computeFullSchedule> | null = null;
  let fullScheduleError: string | null = null;
  try {
    fullMonthlySchedule = computeFullSchedule(
      instrument.type as InstrumentTypeForDispatch,
      await attachPerformanceConditionAssessments(instrument.termVersions)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to compute the full amortization table";
    if (msg.includes("has no natural end date")) {
      fullMonthlySchedule = null; // expected — this type has no full-schedule concept
    } else {
      fullScheduleError = msg;
    }
  }
  const latestTermVersion = instrument.termVersions[instrument.termVersions.length - 1];
  const latestTermVersionId = latestTermVersion?.id;
  const approvalIsStale = latestApproval != null && latestApproval.sourceTermVersionId !== latestTermVersionId;
  // v0.38.0 — "assess for amortization... as part of the preview process prior to
  // posting": only shown when the CURRENT (latest) term version is linked to a shared
  // PerformanceCondition — see PerformanceConditionAssessmentPanel's doc comment.
  const linkedPerformanceCondition = latestTermVersion?.performanceCondition;

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${instrument.entityId}`}>{instrument.entity.name} cap table</Link>
      </p>
      <h1>
        {instrument.type} — {instrument.stakeholder.name}
      </h1>
      <p>
        Status: {instrument.status} · Currency: {instrument.currency} · Issued: {instrument.issueDate.toISOString().slice(0, 10)}
      </p>

      <CloseInstrumentButton instrumentId={instrument.id} />
      <p style={{ margin: "0.5rem 0" }}>
        <Link href={`/instruments/${instrument.id}/modify`} style={buttonLinkStyle}>
          Modify terms
        </Link>
        <span style={{ color: theme.inkMuted, fontSize: "0.85rem", marginLeft: "0.75rem" }}>
          Amend this instrument (a repricing, an extended vest, etc.) with a preview of the dollar impact
          before committing.
        </span>
      </p>
      <CorrectionPanel instrumentId={instrument.id} />

      <h2>Live computed schedule (preview — not yet closed/reported)</h2>
      {scheduleError && (
        <p style={{ color: theme.danger.fg }}>
          {scheduleError}
          {schedule.length === 0 && closedRows.length > 0 && " (The closed/reported rows below are unaffected.)"}
        </p>
      )}
      {!scheduleError && (
        <ScheduleGridTable
          columns={[
            { label: "Period" },
            { label: "Amount", align: "right" },
            { label: "Ending balance", align: "right" },
            { label: "Term version" },
          ]}
          rows={schedule.map((row, i) => ({
            key: i,
            cells: [row.label, row.amount.toFixed(2), row.endingBalance?.toFixed(2) ?? "—", String(row.meta?.termVersionLabel ?? "—")],
          }))}
          emptyMessage="No periods computed yet."
        />
      )}

      {(fullMonthlySchedule || fullScheduleError) && (
        <>
          <h2>Full amortization table (monthly, grant through final vest)</h2>
          <p style={{ color: theme.inkMuted }}>
            The complete projected schedule for this award's entire service period — not just what's elapsed
            so far. Approve it once as the record of this grant's accounting treatment; approved schedules
            across every stock option get aggregated on the{" "}
            <Link href={`/reports/stock-option-amortization?entityId=${instrument.entityId}`}>
              stock option amortization report
            </Link>
            . This is separate from "Close through today" above: closing books what's actually been earned as
            of a real date, while this table is the full plan regardless of how much time has passed.
          </p>
          {fullScheduleError && <p style={{ color: theme.danger.fg }}>{fullScheduleError}</p>}
          {fullMonthlySchedule && (
            <>
              {latestApproval ? (
                <p style={{ color: approvalIsStale ? theme.warning.fg : theme.success.fg }}>
                  Approved {latestApproval.approvedAt.toISOString().slice(0, 10)}
                  {latestApproval.approvedByUser && ` by ${latestApproval.approvedByUser.email}`}.
                  {approvalIsStale &&
                    " This instrument has been modified since — the approved table below no longer matches the current terms. Re-approve to update it."}
                </p>
              ) : (
                <p style={{ color: theme.inkMuted }}>Not yet approved — the table below is a live preview only, and is excluded from every report until approved.</p>
              )}
              {linkedPerformanceCondition && (
                <PerformanceConditionAssessmentPanel
                  entityId={instrument.entityId}
                  conditionId={linkedPerformanceCondition.id}
                  conditionCode={linkedPerformanceCondition.code}
                  linkedGrantCount={linkedPerformanceCondition._count.termVersions}
                  latestAssessment={
                    linkedPerformanceCondition.assessments[0]
                      ? {
                          effectiveDate: linkedPerformanceCondition.assessments[0].effectiveDate.toISOString().slice(0, 10),
                          probable: linkedPerformanceCondition.assessments[0].probable,
                        }
                      : null
                  }
                />
              )}
              <ApproveAmortizationScheduleButton instrumentId={instrument.id} />
              <ScheduleGridTable
                columns={[{ label: "Month" }, { label: "Amount", align: "right" }, { label: "Ending balance", align: "right" }]}
                rows={fullMonthlySchedule.map((row, i) => ({
                  key: i,
                  cells: [row.label, row.amount.toFixed(2), row.endingBalance?.toFixed(2) ?? "—"],
                  highlight: i === fullMonthlySchedule!.length - 1,
                }))}
                maxHeight={400}
              />
            </>
          )}
        </>
      )}

      <h2>Closed &amp; reported (persisted ScheduleEntry rows)</h2>
      {closedRows.length === 0 && <p>Nothing closed yet — use the button above.</p>}
      {closedRows.length > 0 && (
        <ScheduleGridTable
          columns={[
            { label: "Period" },
            { label: "Amount", align: "right" },
            { label: "Ending balance", align: "right" },
            { label: "Currency" },
            { label: "ASC ref" },
          ]}
          rows={closedRows.map((r) => ({
            key: r.id,
            cells: [r.label, r.amount.toString(), r.endingBalance?.toString() ?? "—", r.currency, r.ascReference ?? "—"],
          }))}
        />
      )}

      <h2>Journal entries booked</h2>
      {journalEntries.length === 0 && <p>None yet.</p>}
      {journalEntries.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Date</th>
              <th style={cellStyle}>Description</th>
              <th style={cellStyle}>Lines</th>
            </tr>
          </thead>
          <tbody>
            {journalEntries.map((je) => (
              <tr key={je.id}>
                <td style={cellStyle}>{je.date.toISOString().slice(0, 10)}</td>
                <td style={cellStyle}>{je.description}</td>
                <td style={cellStyle}>
                  {je.lines.map((l) => (
                    <div key={l.id}>
                      {l.account}: {l.debit ? `Dr ${l.debit.toString()}` : `Cr ${l.credit?.toString()}`}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Modification history</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Effective date</th>
            <th style={cellStyle}>Label</th>
          </tr>
        </thead>
        <tbody>
          {instrument.termVersions.map((v) => (
            <tr key={v.id}>
              <td style={cellStyle}>{v.effectiveDate.toISOString().slice(0, 10)}</td>
              <td style={cellStyle}>{v.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.5rem", textAlign: "left" };
const buttonLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.35rem 0.7rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  textDecoration: "none",
  color: "inherit",
  fontSize: "0.9rem",
};
