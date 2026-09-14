import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

const FORFEITABLE_TYPES = ["STOCK_OPTION", "RSU", "RESTRICTED_STOCK"] as const;
const FORFEITURE_EVENT_TYPES = ["FORFEITED", "EXPIRED"] as const;

/**
 * POST /api/instruments/:id/forfeiture-events
 *   { "forfeitureDate", "quantityForfeited", "eventType"?, "reason"? }
 *
 * Records a real, append-only InstrumentForfeitureEvent (v0.46.0) — see that model's
 * doc comment in prisma/schema.prisma for why this exists as its own event log (an
 * unvested grant walking away, or a vested-but-unexercised option running out its
 * contractual term) rather than a value on Instrument.status. This is the write path
 * the new award activity roll-forward report (src/lib/accounting/awardRollforward.ts,
 * surfaced at /reports/asc-718-disclosures) reads from — a forfeiture/expiration is
 * only ever reflected there once it's been recorded here, same "no number the app
 * didn't actually compute or wasn't actually told" posture as OptionExerciseEvent.
 *
 * `eventType` defaults to "FORFEITED" (the far more common case — someone left before
 * vesting) if omitted; pass "EXPIRED" for a vested, in-the-money-or-not option whose
 * contractual exercise window simply ran out. Only meaningfully distinct for
 * STOCK_OPTION — RSU/RESTRICTED_STOCK forfeitures are recorded as FORFEITED in
 * practice, but this route doesn't hard-block EXPIRED for them (a company could still
 * want to model an administrative cancellation that way; the roll-forward just shows
 * whatever was recorded).
 *
 * QUANTITY VALIDATION: same best-effort posture as option-exercises/route.ts —
 * `quantityForfeited` must be positive, but this route does NOT attempt to validate it
 * against "remaining unvested/outstanding quantity" (that would mean recomputing the
 * full vesting schedule from the JSON `terms` blob on every write, for a check that a
 * CPA reviewing the roll-forward report will notice anyway if the numbers don't add
 * up — see awardRollforward.ts's own doc comment on how it surfaces exactly that kind
 * of inconsistency as a warning rather than silently producing a wrong total).
 *
 * GET /api/instruments/:id/forfeiture-events — lists every forfeiture/expiration
 * recorded against this instrument, most recent first.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const instrument = await db.instrument.findUnique({ where: { id: params.id } });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }
  const access = await requireApiEntityAccess(req, instrument.entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  const events = await db.instrumentForfeitureEvent.findMany({
    where: { instrumentId: params.id },
    orderBy: { forfeitureDate: "desc" },
  });

  return NextResponse.json({
    forfeitureEvents: events.map((e) => ({
      id: e.id,
      forfeitureDate: e.forfeitureDate.toISOString().slice(0, 10),
      quantityForfeited: e.quantityForfeited.toString(),
      eventType: e.eventType,
      reason: e.reason,
    })),
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const instrument = await db.instrument.findUnique({ where: { id: params.id } });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }
  if (!FORFEITABLE_TYPES.includes(instrument.type as (typeof FORFEITABLE_TYPES)[number])) {
    return NextResponse.json(
      {
        error: `This instrument is a ${instrument.type} — forfeitures/expirations can only be recorded against ${FORFEITABLE_TYPES.join(", ")}.`,
      },
      { status: 400 }
    );
  }

  const access = await requireApiEntityAccess(req, instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  const body = await req.json().catch(() => ({}));
  const { forfeitureDate, quantityForfeited, eventType, reason } = body ?? {};

  if (!forfeitureDate || quantityForfeited === undefined) {
    return NextResponse.json({ error: "forfeitureDate and quantityForfeited are required" }, { status: 400 });
  }
  if (Number.isNaN(Number(quantityForfeited)) || Number(quantityForfeited) <= 0) {
    return NextResponse.json({ error: "quantityForfeited must be a positive number" }, { status: 400 });
  }
  const resolvedEventType = eventType === undefined || eventType === "" ? "FORFEITED" : eventType;
  if (!FORFEITURE_EVENT_TYPES.includes(resolvedEventType)) {
    return NextResponse.json(
      { error: `eventType must be one of ${FORFEITURE_EVENT_TYPES.join(", ")} (or omitted, which defaults to FORFEITED)` },
      { status: 400 }
    );
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return NextResponse.json({ error: "reason must be a string" }, { status: 400 });
  }

  const event = await db.instrumentForfeitureEvent.create({
    data: {
      instrumentId: instrument.id,
      forfeitureDate: new Date(forfeitureDate),
      quantityForfeited: String(quantityForfeited),
      eventType: resolvedEventType,
      reason: reason || null,
      recordedByUserId: access.user.id,
    },
  });

  return NextResponse.json({
    forfeitureEvent: {
      id: event.id,
      forfeitureDate: event.forfeitureDate.toISOString().slice(0, 10),
      quantityForfeited: event.quantityForfeited.toString(),
      eventType: event.eventType,
      reason: event.reason,
    },
  });
}
