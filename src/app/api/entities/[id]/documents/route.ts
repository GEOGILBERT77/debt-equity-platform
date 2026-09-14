import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { buildStoragePath, uploadDocumentFile } from "@/lib/storage/supabaseStorage";

/**
 * GET /api/entities/:id/documents?stakeholderId=&instrumentId=&category= — the entity-
 * wide document library list (src/app/documents/page.tsx). All three query params are
 * optional filters; omit all three to see everything on file for the entity. VIEWER
 * (same bar as every other read in this app).
 *
 * POST /api/entities/:id/documents — multipart/form-data upload. Fields: "file"
 * (required), "title" (optional — defaults to the uploaded filename), "category"
 * (optional free text — see Document.category's doc comment), "stakeholderId"
 * (optional — who this is about) and "instrumentId" (optional — what instrument, if
 * any, this specifically concerns). EDITOR, same bar as creating an instrument.
 *
 * This is the FIRST upload for a given contract — it just retains the file (Document +
 * DocumentVersion, versionNumber 1, uploaded to this app's own Supabase Storage bucket).
 * It does NOT run the AI classification/treatment analysis — that's a separate,
 * explicit step (POST /api/document-versions/:id/analyze) so a plain "keep this on
 * file" upload never silently incurs an API call/cost nobody asked for.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/, PLUS
 * this one specifically depends on SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY being set —
 * see supabaseStorage.ts's doc comment for setup.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "VIEWER");
  if (access instanceof NextResponse) return access;

  const stakeholderId = req.nextUrl.searchParams.get("stakeholderId") || undefined;
  const instrumentId = req.nextUrl.searchParams.get("instrumentId") || undefined;
  const category = req.nextUrl.searchParams.get("category") || undefined;

  const documents = await db.document.findMany({
    where: {
      entityId: params.id,
      ...(stakeholderId ? { stakeholderId } : {}),
      ...(instrumentId ? { instrumentId } : {}),
      ...(category ? { category } : {}),
    },
    include: {
      versions: { orderBy: { versionNumber: "desc" }, take: 1 },
      stakeholder: { select: { id: true, name: true } },
      instrument: { select: { id: true, type: true } },
      uploadedByUser: { select: { id: true, name: true } },
      contractAnalyses: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, identifiedInstrumentType: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ documents });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const formData = await req.formData().catch(() => null);
  const file = formData?.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: 'Missing file — upload a single file under the field name "file".' }, { status: 400 });
  }

  const title = readOptionalStringField(formData, "title") || file.name || "Untitled document";
  const category = readOptionalStringField(formData, "category");
  const stakeholderId = readOptionalStringField(formData, "stakeholderId");
  const instrumentId = readOptionalStringField(formData, "instrumentId");

  if (stakeholderId) {
    const stakeholder = await db.stakeholder.findUnique({ where: { id: stakeholderId }, select: { entityId: true } });
    if (!stakeholder || stakeholder.entityId !== params.id) {
      return NextResponse.json({ error: `No stakeholder found with id "${stakeholderId}" on this entity` }, { status: 400 });
    }
  }
  if (instrumentId) {
    const instrument = await db.instrument.findUnique({ where: { id: instrumentId }, select: { entityId: true } });
    if (!instrument || instrument.entityId !== params.id) {
      return NextResponse.json({ error: `No instrument found with id "${instrumentId}" on this entity` }, { status: 400 });
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";

  const document = await db.document.create({
    data: {
      entityId: params.id,
      stakeholderId,
      instrumentId,
      title,
      category,
      uploadedByUserId: access.user.id,
    },
  });

  const storagePath = buildStoragePath(params.id, document.id, file.name || title);
  try {
    await uploadDocumentFile(storagePath, bytes, mimeType);
  } catch (err) {
    // Don't leave a Document row on file pointing at a file that never actually made it
    // to storage — clean up rather than silently persisting a broken record.
    await db.document.delete({ where: { id: document.id } }).catch(() => {});
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to upload the file to storage." },
      { status: 502 }
    );
  }

  const version = await db.documentVersion.create({
    data: {
      documentId: document.id,
      versionNumber: 1,
      storagePath,
      mimeType,
      fileSizeBytes: bytes.byteLength,
      status: "retained",
    },
  });

  return NextResponse.json({ document, version }, { status: 201 });
}

/** `FormData.get()` returns `File | string | null` — only ever treat a field as text
 * when it's actually a string, rather than blindly casting (a caller could send a
 * second file under any field name). Trims and turns "" into null. */
function readOptionalStringField(formData: FormData | null, field: string): string | null {
  const value = formData?.get(field);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
