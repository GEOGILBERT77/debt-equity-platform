import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { StockAwardWizard } from "@/app/components/StockAwardWizard";
import { requirePageEntityAccess, requireCurrentUser } from "@/lib/auth/pageGuard";
import { theme } from "@/lib/theme";

/**
 * Server component wrapper for StockAwardWizard.tsx (v0.37.0) — the consolidated
 * "new stock award" entry point that replaced NavBar's separate "Stock option" / "RSU"
 * / "Restricted stock" links (see that file's doc comment on the "New transactions"
 * menu, and StockAwardWizard.tsx's own doc comment for the full rationale). Mirrors
 * `/instruments/new/page.tsx`'s entityId/default-entity-redirect and stakeholder-fetch
 * pattern exactly — this is a sibling entry point, not a replacement for that page,
 * which still serves every OTHER instrument type (debt, SAR, warrant, common/preferred
 * stock, etc.) unchanged.
 */
export default async function NewStockAwardPage({
  searchParams,
}: {
  searchParams: { entityId?: string; stakeholderId?: string };
}) {
  let entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    if (user.defaultEntityId) {
      const params = new URLSearchParams({ entityId: user.defaultEntityId });
      if (searchParams.stakeholderId) params.set("stakeholderId", searchParams.stakeholderId);
      redirect(`/instruments/new/stock-award?${params.toString()}`);
    }
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code>, or go to <Link href="/">the entity list</Link> and use "Add an
          instrument" from a specific entity's cap table (or set a default entity there).
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
      <p>
        <Link href={`/captable?entityId=${entityId}`}>&larr; Cap table</Link> {" · "}
        <Link href={`/stakeholders/new?entityId=${entityId}`}>Add a stakeholder instead</Link> {" · "}
        <Link href={`/instruments/new?entityId=${entityId}`}>All instrument types</Link>
      </p>
      <h1>New stock award</h1>
      <StockAwardWizard
        entityId={entityId}
        stakeholders={stakeholders.map((s) => ({ id: s.id, name: s.name, type: s.type }))}
        initialStakeholderId={searchParams.stakeholderId}
      />
    </main>
  );
}
