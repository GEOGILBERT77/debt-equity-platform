/**
 * Shared shape for "the most recent ContractAnalysis run against a document's latest
 * version" — used by every list view that shows a document alongside its analysis
 * status (documents/page.tsx, GET /api/entities/:id/documents, GET /api/stakeholders/
 * :id/documents, and the client-side StakeholderDocumentsPanel.tsx that consumes the
 * last of those).
 *
 * WHY THIS EXISTS: ContractAnalysis links to a specific DocumentVersion, not to
 * Document directly (see ContractAnalysis's own doc comment in prisma/schema.prisma —
 * an analysis is pinned to the exact version it actually read, deliberately not a
 * denormalized shortcut back onto Document, which Prisma can't express without a real
 * foreign key column). So every query that wants "this document's latest analysis"
 * has to fetch it nested under its latest DocumentVersion, then flatten it back onto
 * the document for the UI, which otherwise doesn't need to know versions exist at all.
 * `LATEST_ANALYSIS_INCLUDE` is the nested-include fragment; `withFlattenedLatestAnalysis`
 * is the flattening step, so both edits happen in exactly one place instead of being
 * hand-copied (and potentially drifting) across three call sites.
 */

export const LATEST_ANALYSIS_INCLUDE = {
  contractAnalyses: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: { id: true, status: true, identifiedInstrumentType: true },
  },
} as const;

export interface LatestAnalysisSummary {
  id: string;
  status: "PENDING" | "ANALYZING" | "ANALYZED" | "FAILED";
  identifiedInstrumentType: string | null;
}

interface DocumentWithNestedAnalysis {
  versions: Array<{ contractAnalyses: LatestAnalysisSummary[] }>;
  [key: string]: unknown;
}

/** Pulls `versions[0].contractAnalyses[0]` (if present) up to a top-level
 * `contractAnalyses: [summary] | []` field on the document — the shape the UI already
 * expects (see documents/page.tsx and StakeholderDocumentsPanel.tsx), without those
 * callers needing to know the analysis actually came from a version, not the document
 * itself. */
export function withFlattenedLatestAnalysis<T extends DocumentWithNestedAnalysis>(
  doc: T
): Omit<T, "versions"> & { versions: Array<Omit<T["versions"][number], "contractAnalyses">>; contractAnalyses: LatestAnalysisSummary[] } {
  const latest = doc.versions[0]?.contractAnalyses ?? [];
  return {
    ...doc,
    versions: doc.versions.map(({ contractAnalyses, ...rest }) => rest),
    contractAnalyses: latest,
  };
}
