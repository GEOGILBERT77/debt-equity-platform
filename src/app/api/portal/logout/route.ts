import { NextResponse } from "next/server";
import { PORTAL_SESSION_COOKIE_NAME } from "@/lib/auth/portalSession";

/**
 * POST /api/portal/logout — clears the portal session cookie. Mirrors
 * /api/auth/logout exactly (see that file's doc comment); the only difference is which
 * cookie gets cleared.
 */
export async function POST() {
  const res = NextResponse.json({ loggedOut: true });
  res.cookies.set(PORTAL_SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
