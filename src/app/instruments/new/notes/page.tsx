import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { NotesWizard } from "@/app/components/NotesWizard";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { theme } from "@/lib/theme";

/**
 * Server component wrapper for NotesWizard.tsx (v0.41.0) — the consolidated "new note"
 * entry point that replaced NavBar's separate "PIK note" / "Convertible note" links
 * (see NavBar.tsx's DEBT_INSTRUMENT_TYPES and NotesWizard.tsx's own doc comment).
 * Mirrors instruments/new/stock-award/page.tsx's entityId/default-entity-redirect and
 * stakeholder-fetch pattern exactly — see that file's doc comment for the full
 * rationale behind the "no entity context yet" screen below, which is copied verbatim
 * for the same reason: this is now a promoted top-level "New transactions" entry, not
 * a link reached only from deep inside a specific entity's own pages.
 */
export default async function NewNotePage({
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
      redirect(`/instruments/new/notes?${params.toString()}`);
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
        <h1>New note</h1>
        <p style={{ color: theme.inkMuted }}>Which entity is this note for?</p>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {entities.map((e) => (
            <li key={e.id} style={{ marginBottom: "0.5rem" }}>
              <Link href={`/instruments/new/notes?entityId=${e.id}`} style={entityLinkStyle}>
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
      <NotesWizard
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
