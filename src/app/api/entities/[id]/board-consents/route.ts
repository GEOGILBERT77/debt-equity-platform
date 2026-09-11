import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * GET /api/entities/:id/board-consents — list this entity's board consent records,
 * newest decision first, each with its linked instruments. VIEWER-or-above, same bar
 * as every other read of entity data.
 *
 * POST /api/entities/:id/board-consents { "title", "description", "consentType",
 * "decisionDate", "instrumentIds"?: string[] } — records a new board consent and
 * (optionally) links it to one or more of this entity's instruments via
 * BoardConsentInstrument. EDITOR-or-above.
 *
 * SEE BoardConsent's doc comment in prisma/schema.prisma for the load-bearing scope
 * decision this whole feature rests on: this is a governance/audit RECORD, not a
 * workflow GATE. Creating a BoardConsent here never changes an Instrument's status,
 * blocks anything, or is read by the accounting engine, cap table rollup, or close
 * workflow — it exists purely so "the board approved this on this date, in this
 * document" is on file and linkable to the specific grants/issuances it covers. If a
 * hard pre-issuance approval gate is ever wanted, that's a separate, much larger
 * change to InstrumentStatus and every call site that assumes ACTIVE means real — see
 * that same doc comment.
 *
 * Every `instrumentId` passed must belong to THIS entity — silently accepting one from
 * another entity would let a consent record misrepresent what it actually covers, a
 * worse failure mode than a clear 400.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
const VALID_CONSENT_TYPES = ["WRITTEN_CONSENT", "BOARD_MEETING"] as const;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "VIEWER");
  if (access instanceof NextResponse) return access;

  const boardConsents = await db.boardConsent.findMany({
    where: { entityId: params.id },
    include: {
      instruments: { include: { instrument: { include: { stakeholder: { select: { id: true, name: true } } } } } },
      createdByUser: { select: { id: true, email: true } },
    },
    orderBy: { decisionDate: "desc" },
  });

  return NextResponse.json({ boardConsents });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const body = await req.json().catch(() => ({}));
  const { title, description, consentType, decisionDate, instrumentIds } = body ?? {};

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (!description || typeof description !== "string" || description.trim().length === 0) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }
  if (!consentType || !VALID_CONSENT_TYPES.includes(consentType)) {
    return NextResponse.json(
      { error: `consentType is required and must be one of: ${VALID_CONSENT_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  if (!decisionDate || typeof decisionDate !== "string" || Number.isNaN(Date.parse(decisionDate))) {
    return NextResponse.json({ error: "decisionDate is required and must be a valid date (YYYY-MM-DD)" }, { status: 400 });
  }
  const ids: string[] = Array.isArray(instrumentIds) ? instrumentIds.filter((x): x is string => typeof x === "string") : [];

  if (ids.length > 0) {
    const matching = await db.instrument.count({ where: { id: { in: ids }, entityId: params.id } });
    if (matching !== ids.length) {
      return NextResponse.json(
        { error: "One or more instrumentIds don't exist on this entity." },
        { status: 400 }
      );
    }
  }

  const boardConsent = await db.boardConsent.create({
    data: {
      entityId: params.id,
      title: title.trim(),
      description: description.trim(),
      consentType,
      decisionDate: new Date(decisionDate),
      createdByUserId: access.user.id,
      instruments: ids.length > 0 ? { create: ids.map((instrumentId) => ({ instrumentId })) } : undefined,
    },
    include: {
      instruments: { include: { instrument: { include: { stakeholder: { select: { id: true, name: true } } } } } },
    },
  });

  return NextResponse.json({ boardConsent }, { status: 201 });
}
