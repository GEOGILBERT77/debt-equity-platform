import Link from "next/link";
import { redirect } from "next/navigation";
import { theme, statusPillStyle } from "@/lib/theme";
import { db } from "@/lib/db";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { ListingTable } from "@/app/components/ListingTable";
import { DocumentUploadForm } from "@/app/components/DocumentUploadForm";
import { LATEST_ANALYSIS_INCLUDE, withFlattenedLatestAnalysis } from "@/lib/documents/latestAnalysis";

const ANALYSIS_STATUS_LABELS: Record<string, string> = {
  PENDING: "Queued",
  ANALYZING: "Analyzing…",
  ANALYZED: "Analyzed",
  FAILED: "Failed",
};

/**
 * The entity-wide document library (v0.47.0) — George, verbatim: "the document
 * library needs to be set up as well — we talked about retaining all
 * contracts/agreements and linking to investors in the cap table, etc." Every document
 * on file for this entity, uploaded here or reached via a stakeholder's "+ Upload"
 * link (StakeholderDocumentsPanel.tsx), each optionally linked to an investor and/or a
 * specific instrument. See Document/DocumentVersion's doc comments in
 * prisma/schema.prisma for why this superseded the old vendor-pointer-only design.
 *
 * Uploading here only retains the file — running the AI classification/treatment
 * analysis (ContractAnalysis, see contractAnalysisPrompt.ts) is a separate, explicit
 * per-document action via the "Analyze" link into /documents/[id]/analysis, so a plain
 * "keep this on file" upload never silently spends an API call.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: { entityId?: string; stakeholderId?: string; instrumentId?: string };
}) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) redirect(`/documents?entityId=${defaultEntityId}`);
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view the document library, or go to <Link href="/">the entity list</Link>{" "}
          (or set a default entity there).
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "VIEWER");

  const { stakeholderId, instrumentId } = searchParams;

  const [documentsRaw, stakeholders, instruments] = await Promise.all([
    db.document.findMany({
      where: {
        entityId,
        ...(stakeholderId ? { stakeholderId } : {}),
        ...(instrumentId ? { instrumentId } : {}),
      },
      include: {
        versions: { orderBy: { versionNumber: "desc" }, take: 1, include: LATEST_ANALYSIS_INCLUDE },
        stakeholder: { select: { id: true, name: true } },
        instrument: { select: { id: true, type: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.stakeholder.findMany({ where: { entityId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.instrument.findMany({ where: { entityId }, orderBy: { issueDate: "desc" }, select: { id: true, type: true, stakeholderId: true } }),
  ]);
  const documents = documentsRaw.map(withFlattenedLatestAnalysis);

  const filteredStakeholderName = stakeholderId ? stakeholders.find((s) => s.id === stakeholderId)?.name : null;

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1300 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${entityId}`}>Cap table</Link>
      </p>
      <h1>Documents</h1>
      <p style={{ color: theme.inkMuted }}>
        Every contract and agreement retained for this entity — option agreements, stock purchase agreements, NDAs,
        side letters, and anything else worth keeping on file. Upload a file, optionally link it to an investor or a
        specific instrument, and run the AI-proposed accounting analysis when you're ready.
      </p>
      {filteredStakeholderName && (
        <p style={{ fontSize: "0.9rem" }}>
          Showing documents for <strong>{filteredStakeholderName}</strong> — <Link href={`/documents?entityId=${entityId}`}>clear filter</Link>
        </p>
      )}

      <DocumentUploadForm
        entityId={entityId}
        stakeholders={stakeholders}
        instruments={instruments}
        defaultStakeholderId={stakeholderId}
        defaultInstrumentId={instrumentId}
      />

      {documents.length === 0 ? (
        <p>No documents on file yet — upload one above.</p>
      ) : (
        <ListingTable
          columns={[
            { label: "Title" },
            { label: "Category" },
            { label: "Linked to" },
            { label: "Status" },
            { label: "Analysis" },
            { label: "" },
          ]}
          rows={documents.map((d) => {
            const latestVersion = d.versions[0];
            const latestAnalysis = d.contractAnalyses[0];
            return {
              key: d.id,
              cells: [
                d.title,
                d.category ?? "—",
                d.stakeholder ? (
                  <Link href={`/stakeholders/${d.stakeholder.id}`}>{d.stakeholder.name}</Link>
                ) : d.instrument ? (
                  <Link href={`/instruments/${d.instrument.id}`}>{d.instrument.type}</Link>
                ) : (
                  "—"
                ),
                latestVersion?.status ?? "—",
                latestAnalysis ? (
                  <span
                    style={statusPillStyle(
                      latestAnalysis.status === "ANALYZED" ? "success" : latestAnalysis.status === "FAILED" ? "danger" : "warning"
                    )}
                  >
                    {ANALYSIS_STATUS_LABELS[latestAnalysis.status] ?? latestAnalysis.status}
                    {latestAnalysis.identifiedInstrumentType ? ` — ${latestAnalysis.identifiedInstrumentType}` : ""}
                  </span>
                ) : (
                  <span style={{ color: theme.inkMuted, fontSize: "0.85rem" }}>Not analyzed</span>
                ),
                <>
                  {latestVersion && (
                    <a href={`/api/documents/${d.id}/download`} target="_blank" rel="noreferrer" style={{ marginRight: "0.75rem" }}>
                      Download
                    </a>
                  )}
                  <Link href={`/documents/${d.id}/analysis`}>Analyze</Link>
                </>,
              ],
            };
          })}
        />
      )}
    </main>
  );
}
