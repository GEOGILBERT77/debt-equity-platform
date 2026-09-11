import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  getCurrentPortalUserFromToken,
  requireStakeholderAccess,
  PortalAccessDeniedError,
  CurrentPortalUser,
  StakeholderAccessGrant,
} from "./portalAuthGuard";
import { PORTAL_SESSION_COOKIE_NAME } from "./portalSession";

/**
 * The server-component counterpart to `portalAuthGuard.ts`, mirroring
 * `pageGuard.ts`'s calling convention exactly:
 *
 *   const portalUser = await requireCurrentPortalUser();
 *   await requirePortalStakeholderAccess(portalUser.id, stakeholderId);
 *
 * `src/middleware.ts`'s portal branch already redirects any unauthenticated request
 * for a non-public `/portal/**` page to `/portal/login` before a page component ever
 * runs — re-deriving the portal user here too is the same deliberate defense-in-depth
 * as the admin side's `requireCurrentUser`.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */

export async function requireCurrentPortalUser(): Promise<CurrentPortalUser> {
  const token = cookies().get(PORTAL_SESSION_COOKIE_NAME)?.value;
  const portalUser = await getCurrentPortalUserFromToken(token);
  if (!portalUser) {
    redirect("/portal/login");
  }
  return portalUser;
}

/** Calls Next's `notFound()` on denial — never a 403 — same reasoning as the admin
 * side's `requirePageEntityAccess`. Returns the access grant (currently just
 * `boardObserver`) so the calling page can adjust what it renders without a second
 * database round trip. */
export async function requirePortalStakeholderAccess(stakeholderUserId: string, stakeholderId: string): Promise<StakeholderAccessGrant> {
  try {
    return await requireStakeholderAccess(stakeholderUserId, stakeholderId);
  } catch (err) {
    if (err instanceof PortalAccessDeniedError) {
      notFound();
    }
    throw err;
  }
}
