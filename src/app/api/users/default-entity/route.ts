import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiUser } from "@/lib/auth/apiGuard";
import { requireEntityAccess, AccessDeniedError } from "@/lib/auth/authGuard";

/**
 * POST /api/users/default-entity { "entityId": string | null }
 *
 * Sets (or clears, with `entityId: null`) the CALLER's own default entity — see
 * prisma/schema.prisma's doc comment on User.defaultEntityId for the full feature
 * this is part of. `POST /api/entities` sets this automatically for a user's first
 * entity; this route is what lets someone managing several entities change which one
 * NavBar/the home page/every "?entityId=..." fallback page falls back to when none is
 * in the current URL.
 *
 * Requires at least VIEWER access to the target entity — same 404-not-403 posture as
 * every other entity-scoped check in this app (see AccessDeniedError's doc comment):
 * a user can't even confirm an entity ID is real by trying to set it as their default,
 * let alone actually make it their default, without some access to it already.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { entityId } = body ?? {};

  if (entityId !== null && typeof entityId !== "string") {
    return NextResponse.json({ error: "entityId must be a string, or null to clear the default" }, { status: 400 });
  }

  if (entityId !== null) {
    try {
      await requireEntityAccess(user.id, entityId, "VIEWER");
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
      throw err;
    }
  }

  await db.user.update({ where: { id: user.id }, data: { defaultEntityId: entityId } });

  return NextResponse.json({ defaultEntityId: entityId });
}
