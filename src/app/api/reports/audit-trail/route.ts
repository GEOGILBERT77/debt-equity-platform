import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildAuditTrail, summarizeAttributionCoverage, AuditTrailInput } from "@/lib/accounting/auditTrail";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { parsePagination, paginationMeta, paginateArray } from "@/lib/api/pagination";
import { conditionalJsonResponse } from "@/lib/api/caching";

/**
 * GET /api/reports/audit-trail?entityId=...
 *
 * Compliance/audit reporting (v0.19.0): every InstrumentTermVersion and Correction for
 * an entity, merged into one chronological timeline — see auditTrail.ts's doc comment
 * for exactly what this does and doesn't cover (notably: it's a "what and when," and,
 * as of this version, a partial "who" — see `attributionCoverage` below and the schema
 * comment on `createdByUserId`).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest) {
  const entityId = req.nextUrl.searchParams.get("entityId");
  if (!entityId) {
    return NextResponse.json({ error: "entityId query parameter is required" }, { status: 400 });
  }

  // Audit trail access requires at least EDITOR — this is a review artifact, and this
  // codebase's role model doesn't have a dedicated "auditor" role distinct from VIEWER,
  // but a plain VIEWER (e.g. a passive investor) shouldn't necessarily see every
  // internal correction reason string on every instrument. EDITOR-and-above (people
  // who actually work the books, or an OWNER) is the closer fit until a real
  // "auditor" role is added — see the README's access-control gaps note.
  const access = await requireApiEntityAccess(req, entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  // `select` rather than `include` (v0.20.0 — "trim over-fetched API responses"): the
  // full Stakeholder and User records were being pulled in just to read
  // `stakeholder.name` and `createdByUser.email` below — narrowing avoids pulling every
  // stakeholder's contact fields and every user's password hash into memory for what
  // is, per this route's own access-control comment above, a compliance report that
  // may be shown to someone who shouldn't necessarily see raw stakeholder PII.
  const [termVersions, corrections] = await Promise.all([
    db.instrumentTermVersion.findMany({
      where: { instrument: { entityId } },
      select: {
        instrumentId: true,
        effectiveDate: true,
        label: true,
        createdAt: true,
        instrument: { select: { type: true, stakeholder: { select: { name: true } } } },
        createdByUser: { select: { email: true } },
      },
      orderBy: [{ instrumentId: "asc" }, { effectiveDate: "asc" }],
    }),
    db.correction.findMany({
      where: { instrument: { entityId } },
      select: {
        id: true,
        instrumentId: true,
        discoveredDate: true,
        reason: true,
        election: true,
        createdAt: true,
        previewSnapshot: true,
        instrument: { select: { type: true, stakeholder: { select: { name: true } } } },
        createdByUser: { select: { email: true } },
      },
      orderBy: { discoveredDate: "asc" },
    }),
  ]);

  // Group term versions by instrument so the first one (by effectiveDate — already the
  // query's sort order within each instrument) can be flagged isOriginal.
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
    const snapshot = c.previewSnapshot as { cumulativeDelta?: string } | null;
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
  // attributionCoverage MUST be computed over the full trail, not one page of it — see
  // src/lib/api/pagination.ts's module doc comment on this exact pattern.
  const attributionCoverage = summarizeAttributionCoverage(trail);

  // PAGINATED as of v0.20.0, applied only to the entry LIST after the coverage
  // computation above.
  const pagination = parsePagination(req);

  // Conditional GET / ETag (v0.20.0 — see src/lib/api/caching.ts).
  return conditionalJsonResponse(req, {
    entries: paginateArray(trail, pagination),
    pagination: paginationMeta(trail.length, pagination),
    attributionCoverage: { ...attributionCoverage, coveragePercent: Number(attributionCoverage.coveragePercent.toFixed(1)) },
  });
}
