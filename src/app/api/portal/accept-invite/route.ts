import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/passwordHashing";
import { hashInviteToken, isInviteStillValid } from "@/lib/auth/portalInvite";
import { createPortalSessionToken, PORTAL_SESSION_COOKIE_NAME } from "@/lib/auth/portalSession";

/**
 * POST /api/portal/accept-invite { "token", "password"? } — the other end of
 * POST /api/entities/:id/stakeholders/:stakeholderId/portal-invite. Looks up the
 * invite by the HASH of the submitted token (the raw token itself is never stored —
 * see portalInvite.ts), confirms it's unexpired and unused, then:
 *
 *   1. Finds or creates the StakeholderUser for the invited Stakeholder's email.
 *      "Finds" matters because the SAME real person can be invited by more than one
 *      entity over time (an investor in several portfolio companies, etc. — see
 *      StakeholderUser's doc comment in prisma/schema.prisma) — accepting a second
 *      entity's invite should add access, not create a second, disconnected account.
 *   2. Sets a password ONLY if this StakeholderUser doesn't already have one. A
 *      person who already completed setup via an earlier invite just gets the new
 *      StakeholderAccess grant and logs straight in — `password` in the request body
 *      is REQUIRED when there's no existing password, and ignored (not used to
 *      silently change anything) when there already is one.
 *   3. Grants StakeholderAccess linking that StakeholderUser to this specific
 *      Stakeholder record — carrying the invite's `grantsBoardObserverAccess` flag
 *      onto the new grant's `boardObserver` column (v0.36.0). If a StakeholderAccess
 *      row for this pair already exists (accepting a second, later invite for a
 *      stakeholder who already has access — see the portal-invite route's doc comment
 *      on why that's harmless), this only ever UPGRADES `boardObserver` from false to
 *      true, never downgrades it — revoking board-observer access is a deliberate
 *      admin action, not a side effect of some later, unrelated invite happening to be
 *      a non-observer one.
 *   4. Marks the invite used (`usedAt`, `acceptedByUserId`) — a second attempt to
 *      accept the same token now fails at the isInviteStillValid check, same as an
 *      expired one.
 *
 * All four steps run in one transaction: a partial failure (e.g. the access grant
 * somehow violating its unique constraint) must never leave a used-up invite with no
 * actual access granted, or a password silently set with the invite still unused.
 *
 * NOT EXECUTED IN THIS SANDBOX (no @prisma/client) — see src/lib/db.ts's doc comment.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { token, password } = body ?? {};

  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Server is not configured for login (SESSION_SECRET is unset)." }, { status: 500 });
  }

  const invite = await db.portalInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { stakeholder: true },
  });

  if (!isInviteStillValid(invite)) {
    return NextResponse.json({ error: "This invite link is invalid, expired, or has already been used." }, { status: 400 });
  }
  // isInviteStillValid narrows out null, but TypeScript can't see that through the
  // helper — assert what we've already checked rather than duplicating the null check.
  const validInvite = invite!;

  const stakeholderEmail = validInvite.stakeholder.email;
  if (!stakeholderEmail) {
    // Shouldn't be reachable — the invite-creation route requires an email on file —
    // but the stakeholder's email could theoretically have been cleared since. Fail
    // clearly rather than creating a StakeholderUser with no email to match on.
    return NextResponse.json({ error: "This stakeholder no longer has an email on file — contact the company." }, { status: 409 });
  }

  const existingStakeholderUser = await db.stakeholderUser.findUnique({ where: { email: stakeholderEmail } });
  const needsPassword = !existingStakeholderUser || !existingStakeholderUser.passwordHash;

  if (needsPassword) {
    if (!password || typeof password !== "string" || password.length < 8) {
      return NextResponse.json({ error: "A password of at least 8 characters is required to finish setting up your account." }, { status: 400 });
    }
  }

  const stakeholderUser = await db.$transaction(async (tx) => {
    const passwordHash = needsPassword ? await hashPassword(password) : undefined;

    const su = existingStakeholderUser
      ? needsPassword
        ? await tx.stakeholderUser.update({ where: { id: existingStakeholderUser.id }, data: { passwordHash } })
        : existingStakeholderUser
      : await tx.stakeholderUser.create({ data: { email: stakeholderEmail, passwordHash } });

    await tx.stakeholderAccess.upsert({
      where: { stakeholderUserId_stakeholderId: { stakeholderUserId: su.id, stakeholderId: validInvite.stakeholderId } },
      create: { stakeholderUserId: su.id, stakeholderId: validInvite.stakeholderId, boardObserver: validInvite.grantsBoardObserverAccess },
      // Upgrade-only — see this function's doc comment on why an existing grant's
      // boardObserver is never flipped back to false here.
      update: validInvite.grantsBoardObserverAccess ? { boardObserver: true } : {},
    });

    await tx.portalInvite.update({
      where: { id: validInvite.id },
      data: { usedAt: new Date(), acceptedByUserId: su.id },
    });

    return su;
  });

  const sessionToken = await createPortalSessionToken(stakeholderUser.id, secret, undefined, stakeholderUser.sessionVersion);
  const res = NextResponse.json({ stakeholderUser: { id: stakeholderUser.id, email: stakeholderUser.email } });
  res.cookies.set(PORTAL_SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
