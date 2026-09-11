import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { buildAuditTrail, summarizeAttributionCoverage, AuditTrailInput } from "@/lib/accounting/auditTrail";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { theme } from "@/lib/theme";

/**
 * Compliance / audit-trail report (v0.19.0) — front-end counterpart to
 * GET /api/reports/audit-trail. See auditTrail.ts's doc comment for what this is (a
 * chronological "what and when" over InstrumentTermVersion + Correction rows) and its
 * honest limitation (partial "who," for rows recorded before createdByUserId existed).
 * Requires EDITOR — same reasoning as the API route.
 *
 * v0.36.0: added the same "fall back to the user's default entity before showing the
 * 'pass ?entityId=...' message" redirect every other entity-scoped page has had since
 * v0.21.0 (see instruments/new/page.tsx's doc comment for the original reasoning) —
 * this page predates that convention (v0.19.0) and was simply never updated when it
 * was introduced. Caught via user report, not something this sandbox could verify on
 * its own.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function AuditTrailPage({ searchParams }: { searchParams: { entityId?: string } }) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) redirect(`/reports/audit-trail?entityId=${defaultEntityId}`);
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view this report, or go to <Link href="/">the entity list</Link> (or
          set a default entity there).
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "EDITOR");

  const [termVersions, corrections] = await Promise.all([
    db.instrumentTermVersion.findMany({
      where: { instrument: { entityId } },
      include: { instrument: { include: { stakeholder: true } }, createdByUser: true },
      orderBy: [{ instrumentId: "asc" }, { effectiveDate: "asc" }],
    }),
    db.correction.findMany({
      where: { instrument: { entityId } },
      include: { instrument: { include: { stakeholder: true } }, createdByUser: true },
      orderBy: { discoveredDate: "asc" },
    }),
  ]);

  const seenInstrument = new Set<string>();
  const inputs: AuditTrailInput[] = [];
  for (const v of termVersions) {
    const isOriginal = !seenInstrument.has(v.instrumentId);
    seenInstrument.add(v.instrumentId);
    inputs.push({
      kind: "TERM_VERSION",
      instrumentId: v.instrumentId,
      instrumentType: v.instrument.type,
      stakeholderName: v.instrument.stakeholder.name,
      effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
      label: v.label,
      createdAt: v.createdAt.toISOString(),
      createdByUserEmail: v.createdByUser?.email,
      isOriginal,
    });
  }
  for (const c of corrections) {
    const snapshot = c.previewSnapshot as unknown as { cumulativeDelta?: string } | null;
    inputs.push({
      kind: "CORRECTION",
      instrumentId: c.instrumentId,
      instrumentType: c.instrument.type,
      stakeholderName: c.instrument.stakeholder.name,
      correctionId: c.id,
      discoveredDate: c.discoveredDate.toISOString().slice(0, 10),
      reason: c.reason,
      election: c.election,
      createdAt: c.createdAt.toISOString(),
      createdByUserEmail: c.createdByUser?.email,
      cumulativeDelta: snapshot?.cumulativeDelta ?? "0.00",
    });
  }

  const trail = buildAuditTrail(inputs);
  const coverage = summarizeAttributionCoverage(trail);

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/reports?entityId=${entityId}`}>Journal entries report</Link>
      </p>
      <h1>Audit trail</h1>
      <p style={{ color: theme.inkMuted }}>
        Every instrument's terms history and every correction, in one chronological feed — a "what and when," not a
        recomputation of the numbers themselves (see the journal entries / financial-statements reports for those).
      </p>
      <p style={{ color: coverage.coveragePercent < 100 ? theme.warning.fg : theme.success.fg }}>
        User attribution: {coverage.entriesWithKnownUser} of {coverage.totalEntries} entries ({coverage.coveragePercent}%) have a
        known "who." Entries from before this platform tracked who made each change will always show "unknown" — see the
        README's audit-trail note.
      </p>

      {trail.length === 0 ? (
        <p>No terms history or corrections recorded yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Date</th>
              <th style={cellStyle}>Kind</th>
              <th style={cellStyle}>Instrument</th>
              <th style={cellStyle}>Who</th>
              <th style={cellStyle}>Summary</th>
            </tr>
          </thead>
          <tbody>
            {trail.map((e, i) => (
              <tr key={i}>
                <td style={cellStyle}>{e.date}</td>
                <td style={cellStyle}>{e.kind === "TERM_VERSION" ? "Terms" : "Correction"}</td>
                <td style={cellStyle}>
                  <Link href={`/instruments/${e.instrumentId}`}>
                    {e.stakeholderName} ({e.instrumentType})
                  </Link>
                </td>
                <td style={cellStyle}>{e.userEmail ?? "unknown"}</td>
                <td style={cellStyle}>{e.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.5rem", textAlign: "left" };
