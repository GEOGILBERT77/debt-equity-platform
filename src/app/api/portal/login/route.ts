import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/passwordHashing";
import { createPortalSessionToken, PORTAL_SESSION_COOKIE_NAME } from "@/lib/auth/portalSession";

/**
 * POST /api/portal/login { "email", "password" } — the stakeholder portal's login,
 * structurally identical to /api/auth/login but against `StakeholderUser`, not `User`
 * (see that model's doc comment in prisma/schema.prisma for why these are separate
 * identity systems). Sets the `portal_session` cookie, never `session`.
 *
 * Same timing-safety note as the admin login route: `verifyPassword` always runs
 * (against a fixed dummy hash when no account matches), so a login attempt against an
 * unregistered email doesn't respond measurably faster than a wrong password against a
 * real one.
 *
 * A `StakeholderUser` with `passwordHash: null` (created by an invite but never
 * accepted) is treated exactly like "no account" here — there is no password to check
 * yet, so nothing they type can succeed; they need the invite link, not this form.
 *
 * NOT EXECUTED IN THIS SANDBOX (no @prisma/client) — see src/lib/db.ts's doc comment.
 */

const DUMMY_HASH = "scrypt:00000000000000000000000000000000:" + "0".repeat(128);

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { email, password } = body ?? {};

  if (!email || typeof email !== "string" || !password || typeof password !== "string") {
    return NextResponse.json({ error: "email and password are both required" }, { status: 400 });
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Server is not configured for login (SESSION_SECRET is unset)." }, { status: 500 });
  }

  const stakeholderUser = await db.stakeholderUser.findUnique({ where: { email: email.toLowerCase().trim() } });
  const passwordOk = await verifyPassword(password, stakeholderUser?.passwordHash ?? DUMMY_HASH);

  if (!stakeholderUser || !stakeholderUser.passwordHash || !passwordOk) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const token = await createPortalSessionToken(stakeholderUser.id, secret, undefined, stakeholderUser.sessionVersion);
  const res = NextResponse.json({ stakeholderUser: { id: stakeholderUser.id, email: stakeholderUser.email } });
  res.cookies.set(PORTAL_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days — matches portalSession.ts's default TTL
  });
  return res;
}
