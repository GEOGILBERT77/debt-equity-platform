import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/auth/logout-everywhere
 *
 * "Log out everywhere" (v0.20.0 — the session-security-hardening item in the
 * task-status spreadsheet): increments the caller's `User.sessionVersion`
 * (prisma/schema.prisma), which instantly invalidates every session token issued
 * before this call — see `session.ts`'s module doc comment and `authGuard.ts`'s
 * `resolveUserFromToken` for exactly how that check works. That includes the token
 * the CALLER used to reach this route, so this endpoint immediately issues a fresh
 * token (carrying the NEW sessionVersion) and sets it as the response cookie — the
 * device that asked for this stays logged in; every other device/browser/session
 * does not, the next time it makes any request.
 *
 * Requires an authenticated session (any entity role, or none at all — this acts on
 * the caller's own account, not any entity's data).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Server is not configured for login (SESSION_SECRET is unset)." }, { status: 500 });
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data: { sessionVersion: { increment: 1 } },
  });

  const token = await createSessionToken(updated.id, secret, undefined, updated.sessionVersion);
  const res = NextResponse.json({ user: { id: updated.id, email: updated.email } });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
  return res;
}
