import Link from "next/link";
import { notFound } from "next/navigation";
import { theme } from "@/lib/theme";
import { db } from "@/lib/db";
import { requirePageEntityAccess } from "@/lib/auth/pageGuard";
import { RunContractAnalysisForm } from "@/app/components/RunContractAnalysisForm";

/**
 * The AI contract-analysis detail/run page for one Document (v0.47.0) — linked from
 * the document library (documents/page.tsx) and from StakeholderDocumentsPanel.tsx.
 * Runs analysis against the document's LATEST version only — see DocumentVersion's own
 * doc comment on why ContractAnalysis pins to a specific version rather than "whatever
 * the current one is": if you upload a corrected/re-signed version later, a fresh
 * "Analyze" run against that new version creates a new ContractAnalysis row rather
 * than overwriting history.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function DocumentAnalysisPage({ params }: { params: { id: string } }) {
  const document = await db.document.findUnique({
    where: { id: params.id },
    include: {
      versions: { orderBy: { versionNumber: "desc" }, take: 1 },
      stakeholder: { select: { id: true, name: true } },
      instrument: { select: { id: true, type: true } },
    },
  });
  if (!document) notFound();

  await requirePageEntityAccess(document.entityId, "EDITOR");

  const latestVersion = document.versions[0];

  const pastAnalysesRaw = latestVersion
    ? await db.contractAnalysis.findMany({
        where: { documentVersionId: latestVersion.id },
        orderBy: { createdAt: "desc" },
      })
    : [];

  // The Json columns (keyTerms/ascReferences/openQuestions) come back from Prisma as
  // untyped `JsonValue` — mapped here into the shapes contractAnalysisPrompt.ts's
  // validateContractAnalysisResult always normalizes them to before persisting, so
  // RunContractAnalysisForm never has to deal with Prisma's Json typing directly.
  const pastAnalyses = pastAnalysesRaw.map((a) => ({
    id: a.id,
    status: a.status,
    identifiedInstrumentType: a.identifiedInstrumentType,
    confidence: a.confidence,
    summary: a.summary,
    keyTerms: (a.keyTerms as Record<string, string> | null) ?? null,
    ascReferences: (a.ascReferences as Array<{ reference: string; relevance: string }> | null) ?? null,
    initialTreatment: a.initialTreatment,
    subsequentTreatment: a.subsequentTreatment,
    openQuestions: (a.openQuestions as string[] | null) ?? null,
    memoDraft: a.memoDraft,
    errorMessage: a.errorMessage,
  }));

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 900 }}>
      <p>
        <Link href={`/documents?entityId=${document.entityId}`}>&larr; Documents</Link>
      </p>
      <h1>{document.title}</h1>
      <p style={{ color: theme.inkMuted }}>
        {document.category ?? "Uncategorized"}
        {document.stakeholder && (
          <>
            {" · "}
            <Link href={`/stakeholders/${document.stakeholder.id}`}>{document.stakeholder.name}</Link>
          </>
        )}
        {document.instrument && (
          <>
            {" · "}
            <Link href={`/instruments/${document.instrument.id}`}>{document.instrument.type}</Link>
          </>
        )}
      </p>

      {!latestVersion ? (
        <p style={{ color: theme.danger.fg }}>This document has no file on record.</p>
      ) : !latestVersion.storagePath ? (
        <p style={{ color: theme.warning.fg }}>
          This document is a pointer to an external e-signature vendor (no file was ever uploaded to this app), so
          there's nothing for the analyzer to read.
        </p>
      ) : (
        <RunContractAnalysisForm documentVersionId={latestVersion.id} pastAnalyses={pastAnalyses} />
      )}
    </main>
  );
}
