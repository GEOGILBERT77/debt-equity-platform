import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, requireEntityAccess, AccessDeniedError, CurrentUser } from "./authGuard";
import { EntityRoleName } from "./access";

/**
 * Two small helpers so every entity-scoped API route enforces access the same way,
 * rather than each route hand-rolling its own getCurrentUser/requireEntityAccess/catch
 * dance. Both return either the thing the caller actually wanted (a CurrentUser, or a
 * `{ user, role }` pair) OR a NextResponse to send back immediately — Next's route
 * handlers don't have a clean way to "throw an HTTP response" the way a framework with
 * exception-based control flow might, so the call site does:
 *
 *   const access = await requireApiEntityAccess(req, entityId, "EDITOR");
 *   if (access instanceof NextResponse) return access;
 *   const { user } = access;
 *
 * `src/middleware.ts` already rejects any unauthenticated request to `/api/**` with a
 * blanket 401 before it ever reaches a route handler — but middleware only proves
 * *someone* is logged in, not *who*, and knowing who is required for the per-entity
 * role check below. So `requireApiUser` re-derives the user from the same cookie here
 * too. That's deliberate defense in depth (same reasoning as `requireEntityAccess`
 * itself living outside the route handlers): a route handler should never trust that
 * some other layer already did the check, even when today it always has.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file that imports
 * `next/server` or (transitively, via authGuard.ts) `db`.
 */

export async function requireApiUser(req: NextRequest): Promise<CurrentUser | NextResponse> {
  const user = await getCurrentUser(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  }
  return user;
}

/** 404, never 403, on denial — see AccessDeniedError's doc comment in authGuard.ts for
 * why leaking "this entity/instrument exists but you can't see it" is itself a leak. */
export async function requireApiEntityAccess(
  req: NextRequest,
  entityId: string,
  minRole: EntityRoleName
): Promise<{ user: CurrentUser; role: EntityRoleName } | NextResponse> {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  try {
    const role = await requireEntityAccess(user.id, entityId, minRole);
    return { user, role };
  } catch (err) {
    if (err instanceof AccessDeniedError) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    throw err;
  }
}
