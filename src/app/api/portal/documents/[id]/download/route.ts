import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentPortalUser, requireStakeholderAccess, PortalAccessDeniedError } from "@/lib/auth/portalAuthGuard";
import { createSignedDownloadUrl } from "@/lib/storage/supabaseStorage";

/**
 * GET /api/portal/documents/:documentId/download — the portal (investor self-service)
 * counterpart to `GET /api/documents/:documentId/download`. Needed as its own route
 * (not just reusing the admin one) because portal users authenticate with a completely
 * separate session system (`StakeholderUser`/`portalAuthGuard.ts`, a different cookie)
 * — see that file's own doc comment for why the portal has never shared identity with
 * the admin `User`/`EntityAccess` system. Added in v0.47.0 alongside the document
 * library: before this version, every document a portal user could see was a
 * PandaDoc/DocuSign vendor URL needing no app-side auth at all, so this gap didn't
 * exist yet — now that this app stores files itself behind a private bucket, a portal
 * user needs its own signed-URL-minting path.
 *
 * Access check: the document must be "about" a stakeholder this portal user actually
 * has a `StakeholderAccess` grant for — either directly (`Document.stakeholderId`) or
 * via the instrument it's linked to (`Document.instrument.stakeholderId`). This
 * mirrors exactly what `portal/[stakeholderId]/page.tsx` already fetches and shows —
 * this route can never expose a document that page wouldn't already have listed.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const portalUser = await getCurrentPortalUser(req.headers.get("cookie"));
  if (!portalUser) {
    return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  }

  const document = await db.document.findUnique({
    where: { id: params.id },
    include: { instrument: { select: { stakeholderId: true } } },
  });
  if (!document) {
    return NextResponse.json({ error: `No document found with id "${params.id}"` }, { status: 404 });
  }

  const owningStakeholderId = document.stakeholderId ?? document.instrument?.stakeholderId ?? null;
  if (!owningStakeholderId) {
    // An entity-wide document with no stakeholder or instrument link at all — nothing
    // ties it to any specific investor, so a portal user (who only ever has access to
    // specific stakeholders) can never legitimately reach it.
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    await requireStakeholderAccess(portalUser.id, owningStakeholderId);
  } catch (err) {
    if (err instanceof PortalAccessDeniedError) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    throw err;
  }

  const versionParam = req.nextUrl.searchParams.get("version");
  const requestedVersionNumber = versionParam ? Number(versionParam) : null;
  const version = await db.documentVersion.findFirst({
    where: { documentId: document.id, ...(requestedVersionNumber ? { versionNumber: requestedVersionNumber } : {}) },
    orderBy: { versionNumber: "desc" },
  });
  if (!version) {
    return NextResponse.json({ error: "No version found for this document." }, { status: 404 });
  }

  if (version.storagePath) {
    try {
      const signedUrl = await createSignedDownloadUrl(version.storagePath);
      return NextResponse.redirect(signedUrl);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to create a download link for this file." },
        { status: 502 }
      );
    }
  }

  if (version.storageUrl) {
    return NextResponse.redirect(version.storageUrl);
  }

  return NextResponse.json({ error: "This document version has no file or link on record." }, { status: 404 });
}
