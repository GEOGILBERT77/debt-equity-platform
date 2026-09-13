import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { EquityFundingWizard, ExistingPreferredSeries } from "@/app/components/EquityFundingWizard";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { theme } from "@/lib/theme";
import type { PreferredStockInstrumentTerms } from "@/lib/accounting/dispatch";

/**
 * Server component wrapper for EquityFundingWizard.tsx (v0.41.0) — the consolidated
 * "New Equity Funding" entry point that replaced NavBar's separate "Common stock" /
 * "Preferred stock" links (see NavBar.tsx's EQUITY_INSTRUMENT_TYPES and
 * EquityFundingWizard.tsx's own doc comment). Mirrors instruments/new/notes/page.tsx's
 * and instruments/new/stock-award/page.tsx's entityId/default-entity-redirect and
 * stakeholder-fetch pattern exactly — see those files' doc comments for the full
 * rationale behind the "no entity context yet" screen below, copied verbatim here for
 * the same reason.
 *
 * The one thing those two wizards' wrapper pages don't need and this one does:
 * `existingCommonClassLabels` / `existingPreferredSeries`, fetched here (server-side,
 * same "latest term version per instrument" query shape as captable/page.tsx and
 * reports/cap-table-waterfall/page.tsx) so the wizard's "issue more of an existing
 * class" path has real data to offer. See EquityFundingWizard.tsx's own doc comment
 * for exactly what "existing class" means for each kind and why preferred pre-fills
 * its liquidation-preference/conversion terms while common only pre-fills a label.
 */
export default async function NewEquityFundingPage({
  searchParams,
}: {
  searchParams: { entityId?: string; stakeholderId?: string };
}) {
  let entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) {
      const params = new URLSearchParams({ entityId: defaultEntityId });
      if (searchParams.stakeholderId) params.set("stakeholderId", searchParams.stakeholderId);
      redirect(`/instruments/new/equity-funding?${params.toString()}`);
    }

    const entities = await db.entity.findMany({
      where: { access: { some: { userId: user.id } } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    if (entities.length === 0) {
      return (
        <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
          <p>
            You don't have any entities yet — go to <Link href="/">the home page</Link> and create one first.
          </p>
        </main>
      );
    }

    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 480 }}>
        <h1>New Equity Funding</h1>
        <p style={{ color: theme.inkMuted }}>Which entity is this for?</p>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {entities.map((e) => (
            <li key={e.id} style={{ marginBottom: "0.5rem" }}>
              <Link href={`/instruments/new/equity-funding?entityId=${e.id}`} style={entityLinkStyle}>
                {e.name}
              </Link>
            </li>
          ))}
        </ul>
        <p style={{ fontSize: "0.85rem", color: theme.inkMuted }}>
          Tip: set one of these as your default entity from <Link href="/">the home page</Link> to skip this step
          next time.
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "EDITOR");

  const stakeholders = await db.stakeholder.findMany({
    where: { entityId },
    orderBy: { name: "asc" },
  });

  // COMMON_STOCK: an "existing class" is just the free-text label some other
  // COMMON_STOCK instrument on this entity already used (e.g. "Class A Common") — see
  // EquityFundingWizard.tsx's doc comment for why that's all common stock has to key
  // off of here. One entry per distinct label, in first-seen order.
  const commonInstruments = await db.instrument.findMany({
    where: { entityId, type: "COMMON_STOCK" },
    include: { termVersions: { orderBy: { effectiveDate: "desc" }, take: 1 } },
  });
  const existingCommonClassLabels: string[] = [];
  for (const inst of commonInstruments) {
    const label = inst.termVersions[0]?.label;
    if (label && !existingCommonClassLabels.includes(label)) existingCommonClassLabels.push(label);
  }

  // PREFERRED_STOCK: an "existing class" is a liquidationPreference.seriesName group —
  // see capTableWaterfall.ts's module doc comment for why that's the grouping key the
  // rest of this app already uses. One REPRESENTATIVE {seriesName, terms} per distinct
  // series (the first holder found with that series recorded) — good enough to
  // pre-fill the form with, since capTableWaterfall.ts's own inconsistency check is
  // what catches it if a later holder's terms actually diverge from this one.
  // Preferred instruments with no liquidationPreference on their latest term version
  // aren't part of any named series yet, so they're skipped here entirely.
  const preferredInstruments = await db.instrument.findMany({
    where: { entityId, type: "PREFERRED_STOCK" },
    include: { termVersions: { orderBy: { effectiveDate: "desc" }, take: 1 } },
  });
  const existingPreferredSeries: ExistingPreferredSeries[] = [];
  const seenSeriesNames = new Set<string>();
  for (const inst of preferredInstruments) {
    const terms = inst.termVersions[0]?.terms as unknown as PreferredStockInstrumentTerms | undefined;
    const seriesName = terms?.liquidationPreference?.seriesName;
    if (!seriesName || seenSeriesNames.has(seriesName)) continue;
    seenSeriesNames.add(seriesName);
    existingPreferredSeries.push({ seriesName, terms });
  }

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 640 }}>
      <EquityFundingWizard
        entityId={entityId}
        stakeholders={stakeholders.map((s) => ({ id: s.id, name: s.name, type: s.type }))}
        initialStakeholderId={searchParams.stakeholderId}
        existingCommonClassLabels={existingCommonClassLabels}
        existingPreferredSeries={existingPreferredSeries}
      />
    </main>
  );
}

const entityLinkStyle: React.CSSProperties = {
  display: "block",
  padding: "0.6rem 0.9rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  background: theme.surface,
  textDecoration: "none",
  color: "inherit",
};
