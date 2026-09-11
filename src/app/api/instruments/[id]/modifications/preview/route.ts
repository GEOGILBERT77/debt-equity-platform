import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { previewModificationImpact } from "@/lib/db/amortizationSchedule";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/instruments/:id/modifications/preview
 *   { "effectiveDate": "YYYY-MM-DD", "terms": {...}, "label": "..." (optional) }
 *
 * Computes the amortization-table impact of a PROPOSED modification without writing
 * anything to the database — mirrors corrections/preview/route.ts's role for
 * corrections: this is the "run it and view the impact" step a human uses to decide
 * whether to actually commit the change, by calling POST
 * /api/instruments/:id/modifications with the same inputs afterward. See
 * previewModificationImpact's doc comment in amortizationSchedule.ts for what "impact"
 * means here and why it's `applicable: false` (rather than an error) for instrument
 * types with no natural end date.
 *
 * EDITOR-or-above, same bar as the commit route it previews for.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const { effectiveDate, terms, label } = body ?? {};

  if (!effectiveDate || terms === undefined) {
    return NextResponse.json({ error: "effectiveDate and terms are both required" }, { status: 400 });
  }

  const instrument = await db.instrument.findUnique({ where: { id: params.id }, select: { entityId: true } });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  try {
    const preview = await previewModificationImpact(params.id, effectiveDate, terms, label);
    return NextResponse.json(preview);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute modification impact" }, { status: 400 });
  }
}
