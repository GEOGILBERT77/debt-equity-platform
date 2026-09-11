import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getCurrentUserFromToken, requireEntityAccess, AccessDeniedError, CurrentUser } from "./authGuard";
import { SESSION_COOKIE_NAME } from "./session";
import { EntityRoleName } from "./access";
import { db } from "@/lib/db";

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

/**
 * Resolves the entity every "no ?entityId= in the URL" fallback across src/app/ should
 * redirect to (see instruments/new/page.tsx, captable/page.tsx, and roughly a dozen
 * report pages, each with their own "if (!entityId) { ... if (user.defaultEntityId)
 * redirect(...) }" block). Through v0.36.0 that check was `user.defaultEntityId` alone
 * — the real database column `SetDefaultEntityButton.tsx` writes — which meant anyone
 * who never explicitly clicked "Set as default" got the bare "pass ?entityId=..."
 * fallback even with only one entity to possibly mean. Reported directly: "most users
 * will only have one entity, so the system should default to [it]" (after the
 * consolidated stock-award wizard's own no-entity screen made that friction obvious —
 * see that page's doc comment).
 *
 * `user.defaultEntityId` still wins when it's set (an explicit choice always beats an
 * inferred one, e.g. for a user who has access to several entities but usually works
 * in one of them) — this only fills in the gap when it's UNSET, by checking whether
 * the user has access to exactly one entity at all and using that. Two or more
 * entities with no explicit default still correctly falls through to whatever
 * entity-picker UI the caller shows, since there's no reasonable inference to make
 * there — this is deliberately narrower than "always pick the first/most-recent
 * entity," which would silently guess wrong for a multi-entity user.
 */
export async function resolveDefaultEntityId(user: CurrentUser): Promise<string | null> {
  if (user.defaultEntityId) return user.defaultEntityId;
  const entities = await db.entity.findMany({
    where: { access: { some: { userId: user.id } } },
    select: { id: true },
    take: 2, // only need to distinguish "exactly one" from "two or more"
  });
  return entities.length === 1 ? entities[0].id : null;
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
