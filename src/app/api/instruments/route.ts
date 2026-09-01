import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { validateInstrumentTerms, TermsValidationError } from "@/lib/accounting/termsValidation";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { parsePagination, paginationMeta } from "@/lib/api/pagination";

const VALID_INSTRUMENT_TYPES: InstrumentTypeForDispatch[] = [
  "STOCK_OPTION",
  "RSU",
  "SAR",
  "WARRANT",
  "CONVERTIBLE_NOTE",
  "TERM_LOAN",
  "REVOLVER",
  "PIK_NOTE",
  "PREFERRED_STOCK",
  "COMMON_STOCK",
  "RESTRICTED_STOCK",
];

/**
 * GET /api/instruments?entityId=...&page=&pageSize=
 * Lists instruments for an entity, with their stakeholder and current (latest) term
 * version — this is the primary feed for the cap table view. Requires at least VIEWER
 * on `entityId`.
 *
 * PAGINATED as of v0.20.0 (`page`/`pageSize`, default 50/page, capped at 200 — see
 * `src/lib/api/pagination.ts`) — real `skip`/`take` at the database layer, not just a
 * response-size cap, since this is a true list with no aggregate that needs the full
 * set. The cap table page (`/captable`) is a server component that queries `db`
 * directly rather than calling this route, so it isn't affected by this change; any
 * client-side caller of this route now needs to page through `pagination.totalPages`
 * for a full result set instead of assuming one call returns everything.
 *
 * NOT EXECUTED IN THIS SANDBOX (no Postgres, no installed @prisma/client here) — this
 * is standard Next.js App Router route-handler shape, written to be run and verified
 * against a real Supabase/Postgres instance, not proven correct by a test in this repo.
 */
export async function GET(req: NextRequest) {
  const entityId = req.nextUrl.searchParams.get("entityId");
  if (!entityId) {
    return NextResponse.json({ error: "entityId query parameter is required" }, { status: 400 });
  }

  const access = await requireApiEntityAccess(req, entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  const pagination = parsePagination(req);

  const [instruments, totalCount] = await Promise.all([
    db.instrument.findMany({
      where: { entityId },
      include: {
        stakeholder: true,
        termVersions: { orderBy: { effectiveDate: "desc" }, take: 1 },
      },
      orderBy: { issueDate: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    db.instrument.count({ where: { entityId } }),
  ]);

  return NextResponse.json({ instruments, pagination: paginationMeta(totalCount, pagination) });
}

/**
 * POST /api/instruments
 * Creates an instrument and its original (version 1) term set in a single transaction —
 * an instrument should never exist without at least one InstrumentTermVersion row,
 * since the accounting engine has nothing to compute from otherwise. Requires at least
 * EDITOR on `entityId`.
 *
 * VALIDATES `type` (against the same InstrumentType enum dispatch.ts dispatches on)
 * and `terms` (against that type's actual expected shape, via termsValidation.ts)
 * before ever touching the database — see termsValidation.ts's doc comment for why
 * this exists and isn't a real Zod schema yet. A bad payload now gets a 400 listing
 * every problem found, instead of either a raw Postgres enum-constraint error or (for
 * `terms`) succeeding at write time and only failing later, deep inside an engine
 * function, the first time someone views this instrument's schedule.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { entityId, stakeholderId, type, issueDate, terms, label } = body ?? {};

  if (!entityId || !stakeholderId || !type || !issueDate || terms === undefined) {
    return NextResponse.json(
      { error: "entityId, stakeholderId, type, issueDate, and terms are all required" },
      { status: 400 }
    );
  }

  const access = await requireApiEntityAccess(req, entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  if (!VALID_INSTRUMENT_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `type must be one of: ${VALID_INSTRUMENT_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    validateInstrumentTerms(type as InstrumentTypeForDispatch, terms);
  } catch (err) {
    if (err instanceof TermsValidationError) {
      return NextResponse.json({ error: err.message, issues: err.issues }, { status: 400 });
    }
    throw err;
  }

  const instrument = await db.instrument.create({
    data: {
      entityId,
      stakeholderId,
      type,
      issueDate: new Date(issueDate),
      termVersions: {
        // createdByUserId (v0.19.0, for the audit-trail report — see
        // prisma/schema.prisma's doc comment on this column) — `access.user.id` is
        // always available here since requireApiEntityAccess above already resolved
        // and returned the current user.
        create: [{ effectiveDate: new Date(issueDate), label: label ?? "Original terms", terms, createdByUserId: access.user.id }],
      },
    },
    include: { termVersions: true },
  });

  return NextResponse.json({ instrument }, { status: 201 });
}
