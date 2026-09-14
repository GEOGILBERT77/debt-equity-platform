import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { downloadDocumentFile } from "@/lib/storage/supabaseStorage";
import { callAnthropicMessages, buildForcedToolRequest, extractToolInput, type AnthropicContentBlock } from "@/lib/ai/anthropicClient";
import {
  CONTRACT_ANALYSIS_TOOL,
  CONTRACT_ANALYSIS_TOOL_NAME,
  buildContractAnalysisSystemPrompt,
  buildContractAnalysisInstructionBlock,
  validateContractAnalysisResult,
} from "@/lib/ai/contractAnalysisPrompt";
import { extractDocxText } from "@/lib/documents/extractDocxText";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_ANALYZABLE_BYTES = 32 * 1024 * 1024; // 32MB — generous for a contract; guards against an accidental huge upload burning API cost.

/**
 * This route runs synchronously (upload -> Claude API call -> validate -> persist,
 * all inside the one request) rather than kicking off a background job, since this
 * codebase has no job runner anywhere (same "no vendor decision made yet" reasoning as
 * communications/page.tsx's mailto approach). A long/scanned contract can take Claude
 * a while to read — Vercel's DEFAULT serverless function timeout (10s on Hobby, 15s on
 * Pro unless raised) is too short for that. `maxDuration` below raises this specific
 * route's own limit; if you're on Vercel Hobby, this setting has no effect (Hobby caps
 * at 60s max regardless) — Pro/Enterprise can go higher. If analyses on real contracts
 * keep timing out even at 60s, the real fix is a background job (persist a PENDING
 * ContractAnalysis row immediately, run the API call from a queue/cron, and have the
 * detail page poll GET /api/contract-analyses/:id) — not implemented here since it
 * needs a job runner this app doesn't have yet.
 */
export const maxDuration = 60;

/**
 * POST /api/document-versions/:id/analyze  { "memoRequested": boolean, "additionalContext"?: string }
 *
 * George, verbatim: "the platform identifies what it is (option, debt, etc.) and
 * proposes accounting treatment and memo justification for it (user should be able to
 * select whether a memo draft is required, since not all option grants need a memo)."
 * `memoRequested` here is that per-analysis checkbox — it's a parameter of THIS route,
 * not of the upload, because a document can reasonably be re-analyzed later with a memo
 * requested even if it wasn't the first time.
 *
 * EDITOR (not VIEWER) — same bar as every other action that spends real money/does
 * real work on this app's behalf (bulk-upload, closing a period). Creates a new
 * ContractAnalysis row up front (status ANALYZING) and always returns 200 with that
 * row's final state (ANALYZED or FAILED) rather than a raw 500 on failure — errors from
 * a flaky API call or an unreadable file are exactly the kind of thing
 * ContractAnalysis.errorMessage exists to surface to the user, not hide behind a generic
 * "Internal Server Error."
 *
 * Only works against a DocumentVersion this app actually stored the bytes for
 * (`storagePath` set) — a DocumentVersion that's only a PandaDoc/DocuSign pointer
 * (`storageUrl`) has no bytes for this app to read, so that case 400s before creating
 * any ContractAnalysis row at all.
 *
 * NOT EXECUTED IN THIS SANDBOX — depends on live SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 * and ANTHROPIC_API_KEY; see supabaseStorage.ts and anthropicClient.ts.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const documentVersion = await db.documentVersion.findUnique({
    where: { id: params.id },
    include: { document: { select: { id: true, entityId: true, title: true } } },
  });
  if (!documentVersion) {
    return NextResponse.json({ error: `No document version found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, documentVersion.document.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  if (!documentVersion.storagePath) {
    return NextResponse.json(
      { error: "This document version has no file stored in this app (it's a pointer to an external e-signature vendor) — nothing for the analyzer to read." },
      { status: 400 }
    );
  }
  if (documentVersion.fileSizeBytes && documentVersion.fileSizeBytes > MAX_ANALYZABLE_BYTES) {
    return NextResponse.json({ error: "This file is too large to analyze automatically (32MB limit)." }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const memoRequested = body?.memoRequested === true;
  const additionalContext = typeof body?.additionalContext === "string" ? body.additionalContext : undefined;

  const analysis = await db.contractAnalysis.create({
    data: {
      documentVersionId: documentVersion.id,
      entityId: documentVersion.document.entityId,
      memoRequested,
      status: "ANALYZING",
      requestedByUserId: access.user.id,
    },
  });

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set — see the README's \"Document library & contract analysis\" section.");
    }
    const model = process.env.ANTHROPIC_MODEL || undefined;

    const bytes = await downloadDocumentFile(documentVersion.storagePath);
    const mimeType = documentVersion.mimeType || "application/octet-stream";

    const documentContentBlock = await buildDocumentContentBlock(bytes, mimeType, documentVersion.document.title);

    const request = buildForcedToolRequest({
      model,
      maxTokens: 4096,
      system: buildContractAnalysisSystemPrompt(),
      content: [buildContractAnalysisInstructionBlock({ memoRequested, additionalContext }), documentContentBlock],
      tool: CONTRACT_ANALYSIS_TOOL,
    });

    const responseBody = await callAnthropicMessages(request, apiKey);
    const toolInput = extractToolInput(responseBody, CONTRACT_ANALYSIS_TOOL_NAME);
    const result = validateContractAnalysisResult(toolInput);

    const updated = await db.contractAnalysis.update({
      where: { id: analysis.id },
      data: {
        status: "ANALYZED",
        identifiedInstrumentType: result.identifiedInstrumentType,
        confidence: result.confidence,
        summary: result.summary,
        keyTerms: result.keyTerms,
        ascReferences: result.ascReferences,
        initialTreatment: result.initialTreatment,
        subsequentTreatment: result.subsequentTreatment,
        openQuestions: result.openQuestions,
        memoDraft: memoRequested ? result.memoDraft : null,
        analyzedAt: new Date(),
      },
    });

    return NextResponse.json({ analysis: updated });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Analysis failed for an unknown reason.";
    const failed = await db.contractAnalysis.update({
      where: { id: analysis.id },
      data: { status: "FAILED", errorMessage, analyzedAt: new Date() },
    });
    return NextResponse.json({ analysis: failed });
  }
}

/** application/pdf -> a native Claude "document" block; images -> an "image" block;
 * .docx -> extract plain text first (Claude's document blocks don't accept .docx) and
 * send as a "text" block; anything else is rejected rather than silently sent as
 * unreadable bytes. */
async function buildDocumentContentBlock(bytes: Buffer, mimeType: string, title: string): Promise<AnthropicContentBlock> {
  if (mimeType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") }, title };
  }
  if (mimeType.startsWith("image/")) {
    return { type: "image", source: { type: "base64", media_type: mimeType, data: bytes.toString("base64") } };
  }
  if (mimeType === DOCX_MIME_TYPE) {
    const text = await extractDocxText(bytes);
    return { type: "text", text: `Contract text extracted from "${title}" (.docx):\n\n${text}` };
  }
  throw new Error(
    `Can't analyze a file of type "${mimeType}" yet — this app currently reads PDFs, images, and .docx files.`
  );
}
