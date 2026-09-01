import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/passwordHashing";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";

/**
 * POST /api/auth/login { "email", "password" }
 *
 * Looks up the user by email, verifies the password against the stored scrypt hash
 * (see passwordHashing.ts), and on success sets a signed session cookie (session.ts) —
 * the real per-user replacement for the shared-password Basic Auth stopgap that used
 * to gate this whole app (see src/middleware.ts's doc comment and the README's
 * "Real authentication and multi-tenancy" section for that migration).
 *
 * DELIBERATELY the SAME error message and response time-shape whether the email
 * doesn't exist or the password is wrong — verifyPassword still runs against a
 * constant placeholder hash when no user is found, so a login attempt against an
 * unregistered email doesn't respond measurably faster than one against a real email
 * with a wrong password (which would otherwise leak which emails have accounts).
 *
 * NOT EXECUTED IN THIS SANDBOX (no @prisma/client) — see src/lib/db.ts's doc comment.
 */

// A fixed, valid-shaped (but not any real user's) scrypt hash, run through
// verifyPassword when no matching user exists — see the doc comment above for why.
const DUMMY_HASH = "scrypt:00000000000000000000000000000000:" + "0".repeat(128);

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { email, password } = body ?? {};

  if (!email || typeof email !== "string" || !password || typeof password !== "string") {
    return NextResponse.json({ error: "email and password are both required" }, { status: 400 });
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Fail loudly for whoever's deploying this, not silently issue an unverifiable
    // session — see DEPLOYMENT.md's env var list.
    return NextResponse.json({ error: "Server is not configured for login (SESSION_SECRET is unset)." }, { status: 500 });
  }

  const user = await db.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !passwordOk) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  // v0.20.0: pass the user's current sessionVersion so a token issued before their
  // last "log out everywhere" (POST /api/auth/logout-everywhere) can never come back
  // to life via a fresh login using stale, cached credentials somewhere — every new
  // login always carries whatever sessionVersion is current right now.
  const token = await createSessionToken(user.id, secret, undefined, user.sessionVersion);
  const res = NextResponse.json({ user: { id: user.id, email: user.email } });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days — matches session.ts's default TTL
  });
  return res;
}
