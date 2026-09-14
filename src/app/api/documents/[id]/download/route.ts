import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { createSignedDownloadUrl } from "@/lib/storage/supabaseStorage";

/**
 * GET /api/documents/:documentId/download?version=N — the ONLY place this app ever
 * mints a Supabase Storage signed URL (see supabaseStorage.ts's doc comment on why:
 * these are private investor legal/financial documents, and a signed URL is
 * deliberately never stored — it's generated fresh on every actual download click and
 * expires shortly after). `version` is optional and defaults to the latest version.
 *
 * Redirects (Next's default 307) to the signed URL for an app-stored file (`storagePath` set), or
 * straight to the vendor URL for a PandaDoc/DocuSign-style pointer (`storageUrl` set) —
 * that one needs no signing, since it already points at the vendor's own access-
 * controlled page, not this app's storage. VIEWER — same bar as any other read.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const document = await db.document.findUnique({ where: { id: params.id }, select: { id: true, entityId: true } });
  if (!document) {
    return NextResponse.json({ error: `No document found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, document.entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  const versionParam = req.nextUrl.searchParams.get("version");
  const requestedVersionNumber = versionParam ? Number(versionParam) : null;
  if (versionParam && (!Number.isInteger(requestedVersionNumber) || requestedVersionNumber! <= 0)) {
    return NextResponse.json({ error: "version, if provided, must be a positive integer." }, { status: 400 });
  }

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
