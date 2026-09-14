import Link from "next/link";
import { db } from "@/lib/db";
import { computeVisibleSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { requirePageEntityAccess } from "@/lib/auth/pageGuard";
import { InvitePortalAccessButton } from "@/app/components/InvitePortalAccessButton";
import { ScheduleGridTable } from "@/app/components/ScheduleGridTable";
import { ListingTable } from "@/app/components/ListingTable";
import { theme } from "@/lib/theme";

/**
 * Investor/stakeholder detail page (v0.21.0) — requested directly: "the interactive
 * cap table should be where all investors, balances, stock classes, contact info
 * should be held. each investor should be clickable to a specific investor screen
 * that shows the document repository items for that investor and ability to see
 * amortization schedules specific to their instruments." Linked from the cap table's
 * stakeholder name (both the "Ownership" and "All instruments (detail)" tables — see
 * captable/page.tsx) rather than replacing that page: the cap table stays the
 * ACROSS-ALL-INVESTORS rollup (balances, stock classes, ownership %), and this page is
 * the drill-down into ONE investor's own contact info, instruments, schedules, and
 * documents — the same "list view -> detail view" split every other entity in this
 * app already uses (Entity list -> cap table; cap table -> /instruments/[id]).
 *
 * DOCUMENTS SHOWN HERE are only ones tied to one of THIS stakeholder's instruments
 * (Document.instrumentId) — an entity-level document with no instrumentId (if any
 * ever exist) isn't specific to one investor, so it deliberately doesn't show up on
 * every investor's page. There's no per-stakeholder document upload UI anywhere yet
 * (Document is populated by whatever created the row — see prisma/schema.prisma's
 * design note #3 on Document being a POINTER into an e-signature vendor's storage,
 * not a store of its own) — this page only ever displays what already exists.
 *
 * SCHEDULES: reuses computeVisibleSchedule, the exact same live-preview function
 * instruments/[id]/page.tsx and captable/page.tsx already use, so "amortization
 * schedule for this investor's instrument" here is never a second, differently-
 * computed number — same caveats apply (see dispatch.ts's CORRECTNESS NOTE): one
 * instrument failing to compute doesn't take down the rest of this page, same
 * per-instrument try/catch pattern captable/page.tsx uses.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function StakeholderPage({ params }: { params: { id: string } }) {
  const stakeholder = await db.stakeholder.findUnique({
    where: { id: params.id },
    include: {
      entity: true,
      instruments: {
        include: { termVersions: { orderBy: { effectiveDate: "asc" } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!stakeholder) {
    return <p>No stakeholder found with id "{params.id}".</p>;
  }

  // Same "fetch first, gate before rendering" pattern as instruments/[id]/page.tsx —
  // the id in the URL here is a stakeholder id, not an entity id, so the entity to
  // check access against is only known after this lookup.
  await requirePageEntityAccess(stakeholder.entityId, "VIEWER");

  const instrumentIds = stakeholder.instruments.map((i) => i.id);
  const [documents, portalAccessCount] = await Promise.all([
    db.document.findMany({
      where: {
        OR: [
          ...(instrumentIds.length > 0 ? [{ instrumentId: { in: instrumentIds } }] : []),
          { stakeholderId: params.id },
        ],
      },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 }, instrument: true },
      orderBy: { createdAt: "desc" },
    }),
    db.stakeholderAccess.count({ where: { stakeholderId: stakeholder.id } }),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const schedulesByInstrument = new Map<string, { rows: ReturnType<typeof computeVisibleSchedule>; error: string | null }>();
  for (const inst of stakeholder.instruments) {
    try {
      const rows = computeVisibleSchedule(
        inst.type as InstrumentTypeForDispatch,
        inst.termVersions.map((v) => ({
          effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
          label: v.label,
          terms: v.terms,
        })),
        today
      );
      schedulesByInstrument.set(inst.id, { rows, error: null });
    } catch (err) {
      schedulesByInstrument.set(inst.id, {
        rows: [],
        error: err instanceof Error ? err.message : "Failed to compute schedule",
      });
    }
  }

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${stakeholder.entityId}`}>{stakeholder.entity.name} cap table</Link>
      </p>
      <h1>{stakeholder.name}</h1>
      <p style={{ color: theme.inkMuted }}>
        {stakeholder.type}
        {stakeholder.email && <> · {stakeholder.email}</>}
        {stakeholder.phone && <> · {stakeholder.phone}</>}
      </p>
      {stakeholder.address && <p style={{ color: theme.inkMuted }}>{stakeholder.address}</p>}

      <h2>Self-service portal</h2>
      <p style={{ color: theme.inkMuted, fontSize: "0.9rem" }}>
        Lets {stakeholder.name} log in and see their own holdings, vesting, and grant history — read-only, on{" "}
        <code>/portal</code>, completely separate from this admin login.
      </p>
      <InvitePortalAccessButton
        entityId={stakeholder.entityId}
        stakeholderId={stakeholder.id}
        hasEmail={!!stakeholder.email}
        alreadyHasAccess={portalAccessCount > 0}
      />

      <h2>Instruments</h2>
      {stakeholder.instruments.length === 0 && <p>No instruments recorded for this stakeholder yet.</p>}
      {stakeholder.instruments.map((inst) => {
        const scheduleResult = schedulesByInstrument.get(inst.id)!;
        return (
          <div key={inst.id} style={instrumentCardStyle}>
            <h3 style={{ marginBottom: "0.25rem" }}>
              <Link href={`/instruments/${inst.id}`}>
                {inst.type} ({inst.status})
              </Link>
            </h3>
            <p style={{ color: theme.inkMuted, margin: "0 0 0.5rem" }}>
              Issued {inst.issueDate.toISOString().slice(0, 10)} · Currency {inst.currency}
            </p>

            <h4 style={{ marginBottom: "0.25rem" }}>Amortization schedule (live preview as of today)</h4>
            {scheduleResult.error && <p style={{ color: theme.danger.fg }}>{scheduleResult.error}</p>}
            {!scheduleResult.error && scheduleResult.rows.length === 0 && (
              <p style={{ color: theme.inkMuted }}>No periodic schedule for this instrument type.</p>
            )}
            {!scheduleResult.error && scheduleResult.rows.length > 0 && (
              <ScheduleGridTable
                columns={[{ label: "Period" }, { label: "Amount", align: "right" }, { label: "Ending balance", align: "right" }]}
                rows={scheduleResult.rows.map((row, i) => ({
                  key: i,
                  cells: [row.label, row.amount.toFixed(2), row.endingBalance?.toFixed(2) ?? "—"],
                }))}
              />
            )}
          </div>
        );
      })}

      <h2>Document repository</h2>
      <p>
        <Link href={`/documents?entityId=${stakeholder.entityId}&stakeholderId=${params.id}`}>
          + Upload a document for {stakeholder.name}
        </Link>
      </p>
      {documents.length === 0 && (
        <p style={{ color: theme.inkMuted }}>Nothing retained for this stakeholder yet — upload one above.</p>
      )}
      {documents.length > 0 && (
        <ListingTable
          columns={[{ label: "Title" }, { label: "Instrument" }, { label: "Status" }, { label: "Link" }]}
          rows={documents.map((d) => ({
            key: d.id,
            cells: [
              <Link href={`/documents/${d.id}/analysis`}>{d.title}</Link>,
              d.instrument ? <Link href={`/instruments/${d.instrument.id}`}>{d.instrument.type}</Link> : "—",
              d.versions[0]?.status ?? "—",
              d.versions[0]?.storageUrl || d.versions[0]?.storagePath ? (
                <a href={`/api/documents/${d.id}/download`} target="_blank" rel="noreferrer">
                  Open
                </a>
              ) : (
                "—"
              ),
            ],
          }))}
        />
      )}
    </main>
  );
}

const instrumentCardStyle: React.CSSProperties = {
  border: `1px solid ${theme.border}`,
  borderRadius: 4,
  padding: "1rem",
  marginBottom: "1rem",
};
