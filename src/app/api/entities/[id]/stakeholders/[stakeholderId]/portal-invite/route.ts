import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { generateInviteToken, hashInviteToken, PORTAL_INVITE_TTL_MS } from "@/lib/auth/portalInvite";

/**
 * POST /api/entities/:id/stakeholders/:stakeholderId/portal-invite — generates a
 * one-time link for THIS stakeholder to set up their self-service portal login (v1
 * scope: view-only holdings/vesting — see StakeholderUser's doc comment in
 * prisma/schema.prisma for the full feature design). Requires EDITOR on the parent
 * entity — same bar as editing the stakeholder record itself.
 *
 * Requires the stakeholder to already have an email on file (Stakeholder.email) —
 * there's no separate "portal email" field; whatever's on the stakeholder record IS
 * who this invite is for. If it's wrong, fix it via PATCH .../stakeholders/:id first.
 *
 * ALWAYS MINTS A FRESH TOKEN. Only the token's hash is ever persisted (see
 * portalInvite.ts), so an earlier invite's raw link can't be recovered and handed back
 * on a second click — but any earlier still-unexpired, still-unused invite for this
 * stakeholder keeps working too (accepting any valid invite for a stakeholder grants
 * the same access), so clicking "invite" twice is harmless, just slightly untidy
 * (multiple valid rows for one stakeholder). Not worth guarding against for v1.
 *
 * RETURNS THE RAW TOKEN EXACTLY ONCE, in this response — nothing else ever sees it
 * again (only its SHA-256 hash is stored, see portalInvite.ts). The admin is
 * responsible for copying `inviteUrl` and sending it to the stakeholder however they
 * choose (this app has no outbound-email vendor wired up yet — see
 * communications/page.tsx). `PORTAL_APP_URL` lets a deployment set the externally-
 * reachable base URL explicitly (Vercel preview/prod URLs differ); falls back to
 * constructing it from the request itself when unset, which is fine for local dev.
 *
 * BODY (v0.36.0): optional `{ "grantsBoardObserverAccess": true }` — carries onto
 * `PortalInvite.grantsBoardObserverAccess`, which POST /api/portal/accept-invite reads
 * when the invite is accepted to mark the resulting `StakeholderAccess.boardObserver`.
 * See that column's doc comment in prisma/schema.prisma ("board member portal"
 * access — a stakeholder invited this way sees the entity's full cap table on the
 * portal, not just their own holdings). Deliberately NOT validated against whether
 * this stakeholder is actually a board member in any structured sense — this app has
 * no such field — it's an admin judgment call at invite time, same trust level as
 * every other EDITOR-gated action on this route.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string; stakeholderId: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const stakeholder = await db.stakeholder.findUnique({ where: { id: params.stakeholderId } });
  if (!stakeholder || stakeholder.entityId !== params.id) {
    return NextResponse.json({ error: `No stakeholder found with id "${params.stakeholderId}" on this entity` }, { status: 404 });
  }
  if (!stakeholder.email) {
    return NextResponse.json(
      { error: "This stakeholder has no email on file yet — add one (PATCH this stakeholder) before inviting them to the portal." },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const grantsBoardObserverAccess = body?.grantsBoardObserverAccess === true;

  const rawToken = generateInviteToken();
  const invite = await db.portalInvite.create({
    data: {
      stakeholderId: params.stakeholderId,
      tokenHash: hashInviteToken(rawToken),
      createdByUserId: access.user.id,
      expiresAt: new Date(Date.now() + PORTAL_INVITE_TTL_MS),
      grantsBoardObserverAccess,
    },
  });

  const baseUrl = process.env.PORTAL_APP_URL ?? new URL(req.url).origin;
  const inviteUrl = `${baseUrl}/portal/accept-invite?token=${rawToken}`;

  return NextResponse.json({
    inviteUrl,
    expiresAt: invite.expiresAt,
    stakeholderEmail: stakeholder.email,
    grantsBoardObserverAccess: invite.grantsBoardObserverAccess,
  });
}
