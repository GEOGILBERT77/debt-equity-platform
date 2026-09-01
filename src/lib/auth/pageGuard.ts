import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getCurrentUserFromToken, requireEntityAccess, AccessDeniedError, CurrentUser } from "./authGuard";
import { SESSION_COOKIE_NAME } from "./session";
import { EntityRoleName } from "./access";

/**
 * The server-component counterpart to apiGuard.ts — same reasoning, different calling
 * convention. `redirect`/`notFound` throw internally (Next's own control-flow
 * mechanism for this), so unlike apiGuard.ts's helpers these can just be `await`ed
 * directly at the top of a page component without an `instanceof NextResponse` check:
 *
 *   const { user } = await requirePageEntityAccess(entityId, "VIEWER");
 *
 * `src/middleware.ts` already redirects any unauthenticated request for a non-public
 * page to /login before a page component ever runs — `requireCurrentUser` re-deriving
 * the user here too is the same deliberate defense-in-depth as apiGuard.ts's
 * `requireApiUser`, plus pages actually need to know *who*, not just *whether*.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */

export async function requireCurrentUser(): Promise<CurrentUser> {
  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  const user = await getCurrentUserFromToken(token);
  if (!user) {
    redirect("/login");
  }
  return user;
}

/** Calls Next's `notFound()` (renders the nearest not-found UI, conceptually a 404) on
 * denial — never a 403 — for the same reason apiGuard.ts's version doesn't either. */
export async function requirePageEntityAccess(
  entityId: string,
  minRole: EntityRoleName
): Promise<{ user: CurrentUser; role: EntityRoleName }> {
  const user = await requireCurrentUser();
  try {
    const role = await requireEntityAccess(user.id, entityId, minRole);
    return { user, role };
  } catch (err) {
    if (err instanceof AccessDeniedError) {
      notFound();
    }
    throw err;
  }
}
