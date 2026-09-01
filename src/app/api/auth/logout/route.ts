import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";

/**
 * POST /api/auth/logout
 * Clears the session cookie. Doesn't need to know who was logged in, or touch the
 * database at all — there's no server-side session store to invalidate (the session
 * token is self-verifying, see session.ts), just a cookie to remove from the browser.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST() {
  const res = NextResponse.json({ loggedOut: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return res;
}
