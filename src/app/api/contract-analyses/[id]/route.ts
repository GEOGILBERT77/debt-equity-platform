import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * GET /api/contract-analyses/:id — poll/detail view for one AI contract-analysis run
 * (src/app/documents/[id]/analysis/page.tsx polls this while status is ANALYZING).
 * VIEWER. entityId is denormalized directly onto ContractAnalysis (see its doc comment
 * in prisma/schema.prisma) so this needs no join to check access.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const analysis = await db.contractAnalysis.findUnique({
    where: { id: params.id },
    include: {
      documentVersion: { include: { document: { select: { id: true, title: true, category: true } } } },
      requestedByUser: { select: { id: true, name: true } },
    },
  });
  if (!analysis) {
    return NextResponse.json({ error: `No contract analysis found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, analysis.entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  return NextResponse.json({ analysis });
}
