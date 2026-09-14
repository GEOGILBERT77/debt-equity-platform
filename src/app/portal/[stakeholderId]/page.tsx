import Link from "next/link";
import { db } from "@/lib/db";
import { computeVisibleSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { buildCapTableRollup, aggregateByStakeholder, CapTableInstrumentInput } from "@/lib/accounting/capTable";
import { classKeyForInstrument, buildCapTableGroupings } from "@/lib/accounting/capTableGrouping";
import { requireCurrentPortalUser, requirePortalStakeholderAccess } from "@/lib/auth/portalPageGuard";
import { listAccessibleStakeholders } from "@/lib/auth/portalAuthGuard";
import { PortalLogoutButton } from "@/app/components/PortalLogoutButton";
import { ScheduleGridTable } from "@/app/components/ScheduleGridTable";
import { CapTableOwnershipTable } from "@/app/components/CapTableOwnershipTable";
import { ListingTable, spanCell } from "@/app/components/ListingTable";
import { theme } from "@/lib/theme";

/**
 * The stakeholder portal's actual "my holdings" page (v0.35.0) — v1 scope, locked in
 * with George before building: VIEW-ONLY. No exercise requests, no e-signature, no
 * tax elections here — just what this stakeholder holds, how it's vesting, and what's
 * already happened to it (exercises, dispositions), plus any documents on file. See
 * StakeholderUser's doc comment in prisma/schema.prisma for the full feature design
 * and what's explicitly deferred to a later pass.
 *
 * DELIBERATELY MIRRORS src/app/stakeholders/[id]/page.tsx's data assembly almost
 * exactly (same instruments + termVersions + computeVisibleSchedule + documents
 * query) — that page already builds precisely the view a stakeholder needs to see of
 * their OWN record; the only real differences here are the auth guard (portal session,
 * not admin) and adding exercise/disposition history for stock options, which the
 * admin page doesn't show inline. Reusing computeVisibleSchedule rather than a second,
 * differently-derived vesting number is the same "one source of truth" reasoning
 * that page's own doc comment gives.
 *
 * BOARD-OBSERVER VIEW (v0.36.0): when `requirePortalStakeholderAccess` reports this
 * grant as `boardObserver` (see StakeholderAccess.boardObserver's doc comment in
 * prisma/schema.prisma), an ADDITIONAL "Board view: full cap table" section is
 * rendered below this stakeholder's own holdings — never a REPLACEMENT of them. A
 * board member who also happens to hold equity directly still sees that first; the
 * board view is purely additive. It reuses buildCapTableRollup/aggregateByStakeholder,
 * the same functions captable/page.tsx composes for the admin-side cap table, so this
 * is never a second, differently-computed ownership number — but the query here is its
 * own (latest term version per instrument, across every stakeholder of the entity)
 * rather than a shared helper, matching this file's existing precedent of assembling
 * its own view-specific query rather than importing a page-level function from another
 * route (see the note above re: stakeholders/[id]/page.tsx).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function PortalStakeholderPage({ params }: { params: { stakeholderId: string } }) {
  const portalUser = await requireCurrentPortalUser();
  const grant = await requirePortalStakeholderAccess(portalUser.id, params.stakeholderId);

  const stakeholder = await db.stakeholder.findUnique({
    where: { id: params.stakeholderId },
    include: {
      entity: true,
      instruments: {
        include: { termVersions: { orderBy: { effectiveDate: "asc" } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  // requirePortalStakeholderAccess already confirmed a StakeholderAccess row exists
  // for this id, so the only way this is null is the stakeholder having been deleted
  // out from under a still-valid access grant — vanishingly unlikely (Stakeholder has
  // no cascade-delete path that would leave StakeholderAccess behind) but handled
  // rather than assumed away.
  if (!stakeholder) {
    return <p>This record is no longer available.</p>;
  }

  const instrumentIds = stakeholder.instruments.map((i) => i.id);

  const [documents, exerciseEvents, otherStakeholders] = await Promise.all([
    db.document.findMany({
      where: {
        OR: [
          ...(instrumentIds.length > 0 ? [{ instrumentId: { in: instrumentIds } }] : []),
          { stakeholderId: params.stakeholderId },
        ],
      },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
      orderBy: { createdAt: "desc" },
    }),
    instrumentIds.length === 0
      ? []
      : db.optionExerciseEvent.findMany({
          where: { instrumentId: { in: instrumentIds } },
          include: { dispositions: { orderBy: { dispositionDate: "asc" } } },
          orderBy: { exerciseDate: "asc" },
        }),
    listAccessibleStakeholders(portalUser.id),
  ]);

  const documentsByInstrument = new Map<string, typeof documents>();
  for (const d of documents) {
    if (!d.instrumentId) continue;
    const list = documentsByInstrument.get(d.instrumentId) ?? [];
    list.push(d);
    documentsByInstrument.set(d.instrumentId, list);
  }
  // v0.47.0 — documents linked directly to this stakeholder (not tied to any one
  // instrument, e.g. a subscription agreement or general correspondence) — see the
  // query above and Document.stakeholderId's doc comment in prisma/schema.prisma.
  // Shown in their own section below rather than folded into a per-instrument list,
  // since they aren't about any one instrument.
  const stakeholderLevelDocuments = documents.filter((d) => !d.instrumentId);
  const exercisesByInstrument = new Map<string, typeof exerciseEvents>();
  for (const e of exerciseEvents) {
    const list = exercisesByInstrument.get(e.instrumentId) ?? [];
    list.push(e);
    exercisesByInstrument.set(e.instrumentId, list);
  }

  // Board-observer view: entity-wide rollup, fetched only when this grant needs it.
  // Same "latest term version per instrument" query shape as captable/page.tsx,
  // deliberately separate from the stakeholder.instruments query above (that one
  // fetches ALL term versions, ascending, for this ONE stakeholder's own schedule
  // history — a different shape for a different purpose).
  let boardRollup: ReturnType<typeof buildCapTableRollup> | null = null;
  let boardOwnership: ReturnType<typeof aggregateByStakeholder> | null = null;
  let boardGroupings: ReturnType<typeof buildCapTableGroupings> | null = null;
  if (grant.boardObserver) {
    const allStakeholders = await db.stakeholder.findMany({
      where: { entityId: stakeholder.entityId },
      include: { instruments: { include: { termVersions: { orderBy: { effectiveDate: "desc" }, take: 1 } } } },
      orderBy: { name: "asc" },
    });
    const boardRollupInputs: CapTableInstrumentInput[] = [];
    // See classKeyForInstrument's doc comment (capTableGrouping.ts) — same "By
    // Instrument/Class" grouping the admin cap table uses, so a board observer sees
    // the identical breakdown an admin would, not a second, differently-shaped view.
    const boardClassKeyByInstrumentId = new Map<string, { key: string; displayLabel: string }>();
    for (const s of allStakeholders) {
      for (const inst of s.instruments) {
        const latestTerms = inst.termVersions[0]?.terms;
        if (latestTerms === undefined) continue;
        const type = inst.type as InstrumentTypeForDispatch;
        boardClassKeyByInstrumentId.set(inst.id, classKeyForInstrument(type, inst.termVersions[0]?.label ?? "", latestTerms));
        boardRollupInputs.push({
          instrumentId: inst.id,
          stakeholderId: s.id,
          stakeholderName: s.name,
          type,
          terms: latestTerms,
          // Deliberately omitted: live-computed outstanding debt balance. Getting that
          // right requires running computeVisibleSchedule per debt instrument (see
          // captable/page.tsx) — worth doing if debt visibility to board observers is
          // ever asked for, but the ownership rollup below (this view's actual point)
          // doesn't depend on it, so it's left out for now rather than duplicating that
          // per-instrument try/catch machinery for a field this view doesn't show.
        });
      }
    }
    boardRollup = buildCapTableRollup(boardRollupInputs);
    boardOwnership = aggregateByStakeholder(boardRollup);
    // No stakeholderHref here, deliberately — see buildCapTableGroupings's doc
    // comment: a board-observer portal user has no business being sent into the
    // ADMIN-only /stakeholders/[id] route, so investor names in this view aren't links.
    boardGroupings = buildCapTableGroupings({
      rollup: boardRollup,
      ownershipByStakeholder: boardOwnership,
      classKeyByInstrumentId: boardClassKeyByInstrumentId,
    });
  }

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
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.5rem" }}>
        <div>
          {otherStakeholders.length > 1 && (
            <p style={{ margin: "0 0 0.25rem" }}>
              <Link href="/portal">&larr; Switch company</Link>
            </p>
          )}
          <h1 style={{ fontFamily: theme.font.heading, margin: 0 }}>{stakeholder.entity.name}</h1>
          <p style={{ color: theme.inkMuted, margin: "0.25rem 0 0" }}>
            {stakeholder.name} · {stakeholder.type.replace("_", " ").toLowerCase()}
          </p>
        </div>
        <PortalLogoutButton />
      </div>

      <h2>Your holdings</h2>
      {stakeholder.instruments.length === 0 && <p style={{ color: theme.inkMuted }}>Nothing on file yet.</p>}
      {stakeholder.instruments.map((inst) => {
        const scheduleResult = schedulesByInstrument.get(inst.id)!;
        const exercises = exercisesByInstrument.get(inst.id) ?? [];
        return (
          <div key={inst.id} style={cardStyle}>
            <h3 style={{ marginBottom: "0.25rem" }}>
              {inst.type.replace(/_/g, " ")} <span style={{ color: theme.inkMuted, fontWeight: 400, fontSize: "0.85rem" }}>({inst.status})</span>
            </h3>
            <p style={{ color: theme.inkMuted, margin: "0 0 0.75rem", fontFamily: theme.font.mono, fontSize: "0.85rem" }}>
              Issued {inst.issueDate.toISOString().slice(0, 10)} · {inst.currency}
            </p>

            <h4 style={{ marginBottom: "0.25rem" }}>Vesting schedule (as of today)</h4>
            {scheduleResult.error && <p style={{ color: theme.danger.fg }}>{scheduleResult.error}</p>}
            {!scheduleResult.error && scheduleResult.rows.length === 0 && (
              <p style={{ color: theme.inkMuted }}>No periodic vesting schedule applies to this holding.</p>
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

            {inst.type === "STOCK_OPTION" && (
              <>
                <h4 style={{ margin: "0.75rem 0 0.25rem" }}>Exercise history</h4>
                {exercises.length === 0 && <p style={{ color: theme.inkMuted }}>No exercises recorded yet.</p>}
                {exercises.length > 0 && (
                  <ListingTable
                    columns={[
                      { label: "Exercise date" },
                      { label: "Quantity", align: "right" },
                      { label: "Strike price", align: "right" },
                      { label: "FMV at exercise", align: "right" },
                    ]}
                    rows={exercises.flatMap((e) => [
                      {
                        key: e.id,
                        cells: [
                          e.exerciseDate.toISOString().slice(0, 10),
                          e.quantityExercised.toString(),
                          e.exercisePricePerShare.toString(),
                          e.fairMarketValuePerShareAtExercise.toString(),
                        ],
                      },
                      ...e.dispositions.map((d) => ({
                        key: d.id,
                        cells: [
                          <span style={{ color: theme.inkMuted, paddingLeft: "1.5rem" }}>
                            ↳ sold {d.dispositionDate.toISOString().slice(0, 10)}
                          </span>,
                          <span style={{ color: theme.inkMuted }}>{d.quantitySold.toString()}</span>,
                          spanCell(
                            <span style={{ color: theme.inkMuted }}>at {d.salePricePerShare.toString()}/share</span>,
                            2
                          ),
                        ],
                      })),
                    ])}
                  />
                )}
              </>
            )}

            {(documentsByInstrument.get(inst.id)?.length ?? 0) > 0 && (
              <>
                <h4 style={{ margin: "0.75rem 0 0.25rem" }}>Documents</h4>
                <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
                  {documentsByInstrument.get(inst.id)!.map((d) => (
                    <li key={d.id}>
                      {d.versions[0]?.storageUrl || d.versions[0]?.storagePath ? (
                        <a href={`/api/portal/documents/${d.id}/download`} target="_blank" rel="noreferrer">
                          {d.title}
                        </a>
                      ) : (
                        d.title
                      )}
                      {d.versions[0]?.status && <span style={{ color: theme.inkMuted }}> — {d.versions[0].status}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        );
      })}

      {stakeholderLevelDocuments.length > 0 && (
        <>
          <h2 style={{ marginTop: "1.5rem" }}>Documents</h2>
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {stakeholderLevelDocuments.map((d) => (
              <li key={d.id}>
                {d.versions[0]?.storageUrl || d.versions[0]?.storagePath ? (
                  <a href={`/api/portal/documents/${d.id}/download`} target="_blank" rel="noreferrer">
                    {d.title}
                  </a>
                ) : (
                  d.title
                )}
                {d.versions[0]?.status && <span style={{ color: theme.inkMuted }}> — {d.versions[0].status}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {grant.boardObserver && boardRollup && boardOwnership && (
        <>
          <h2 style={{ marginTop: "1.5rem" }}>Board view: full cap table</h2>
          <p style={{ color: theme.inkMuted, fontSize: "0.85rem" }}>
            You're seeing this because you've been granted board-observer access — every stakeholder's fully
            diluted ownership in {stakeholder.entity.name}, not just your own holdings above. Computed live as
            of today, same as the admin cap table view.
          </p>
          {boardRollup.totalFullyDilutedShares.toString() === "0" || !boardGroupings ? (
            <p style={{ color: theme.inkMuted }}>No equity instruments recorded yet.</p>
          ) : (
            <CapTableOwnershipTable
              totalShares={boardRollup.totalFullyDilutedShares.toString()}
              byClass={boardGroupings.byClass}
              byInvestor={boardGroupings.byInvestor}
            />
          )}
          {boardRollup.unsupported.length > 0 && (
            <p style={{ color: theme.inkMuted, fontSize: "0.8rem" }}>
              {boardRollup.unsupported.length} instrument(s) of a type this rollup doesn't compute an ownership
              figure for are not included above.
            </p>
          )}
        </>
      )}
    </main>
  );
}

const cardStyle: React.CSSProperties = {
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  background: theme.surface,
  padding: "1.1rem",
  marginBottom: "1rem",
};
