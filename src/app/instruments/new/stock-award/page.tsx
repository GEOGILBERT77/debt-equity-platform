import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { StockAwardWizard } from "@/app/components/StockAwardWizard";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { theme } from "@/lib/theme";

/**
 * Server component wrapper for StockAwardWizard.tsx (v0.37.0) — the consolidated
 * "new stock award" entry point that replaced NavBar's separate "Stock option" / "RSU"
 * / "Restricted stock" links (see that file's doc comment on the "New transactions"
 * menu, and StockAwardWizard.tsx's own doc comment for the full rationale). Mirrors
 * `/instruments/new/page.tsx`'s entityId/default-entity-redirect and stakeholder-fetch
 * pattern — this is a sibling entry point, not a replacement for that page, which still
 * serves every OTHER instrument type (debt, SAR, warrant, common/preferred stock, etc.)
 * unchanged.
 *
 * NO-ENTITY-CONTEXT SCREEN (v0.37.0): every other entity-scoped page in this app falls
 * back to a bare "pass ?entityId=..., or go to the entity list" message when there's
 * no entityId in the URL and no default entity set — reasonable for a page reached
 * from deep in a specific entity's own navigation, but a real dead end for THIS page,
 * since "Stock award" is now the single, promoted way into the app's most common
 * transaction and is exactly as likely to be someone's very first click after logging
 * in (before they've ever landed on a specific entity's cap table). Reported directly:
 * clicking "Stock award" from a page with no entity context showed that same bare
 * message. Rather than just explaining that's the existing convention, this page picks
 * its own entities list right here (same query the home page and layout.tsx's entity
 * switcher use) and renders it as clickable links — so landing here with no context
 * costs one extra click, not a trip back to the home page.
 *
 * v0.38.0 — the "← Cap table · Add a stakeholder instead · All instrument types" nav
 * row and the page's own `<h1>` (both formerly rendered here, once entityId resolves)
 * were removed at George's request. The `<h1>` moved into StockAwardWizard.tsx itself,
 * since it now needs to change per award type once one's picked — a server component
 * can't react to that client-side selection.
 */
export default async function NewStockAwardPage({
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
      redirect(`/instruments/new/stock-award?${params.toString()}`);
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
        <h1>New stock award</h1>
        <p style={{ color: theme.inkMuted }}>Which entity is this award for?</p>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {entities.map((e) => (
            <li key={e.id} style={{ marginBottom: "0.5rem" }}>
              <Link href={`/instruments/new/stock-award?entityId=${e.id}`} style={entityLinkStyle}>
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

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 640 }}>
      <StockAwardWizard
        entityId={entityId}
        stakeholders={stakeholders.map((s) => ({ id: s.id, name: s.name, type: s.type }))}
        initialStakeholderId={searchParams.stakeholderId}
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
