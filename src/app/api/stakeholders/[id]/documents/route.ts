import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { LATEST_ANALYSIS_INCLUDE, withFlattenedLatestAnalysis } from "@/lib/documents/latestAnalysis";

/**
 * GET /api/stakeholders/:id/documents — feeds StakeholderDocumentsPanel.tsx, the
 * slide-out right-hand panel George asked for: "ideally, we can click on an investor
 * in the cap table... and a pane on the right shows up and shows currently retained
 * documentation." VIEWER.
 *
 * Returns everything on file that's ABOUT this stakeholder: documents linked directly
 * to them (Document.stakeholderId) UNIONED with documents linked to any instrument
 * they hold (Document.instrument.stakeholderId) — a subscription agreement uploaded
 * against the stakeholder record and an option agreement uploaded against one specific
 * grant should both show up here, since from an investor's perspective both are just
 * "paperwork on file for me."
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const stakeholder = await db.stakeholder.findUnique({ where: { id: params.id }, select: { id: true, entityId: true, name: true } });
  if (!stakeholder) {
    return NextResponse.json({ error: `No stakeholder found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, stakeholder.entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  const documents = await db.document.findMany({
    where: {
      OR: [{ stakeholderId: stakeholder.id }, { instrument: { stakeholderId: stakeholder.id } }],
    },
    include: {
      versions: { orderBy: { versionNumber: "desc" }, take: 1, include: LATEST_ANALYSIS_INCLUDE },
      instrument: { select: { id: true, type: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    stakeholder: { id: stakeholder.id, name: stakeholder.name },
    documents: documents.map(withFlattenedLatestAnalysis),
  });
}
