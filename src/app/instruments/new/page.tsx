import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { NewInstrumentForm } from "@/app/components/NewInstrumentForm";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { theme } from "@/lib/theme";

/**
 * Server component wrapper: fetches the entity's stakeholders here (so the form's
 * dropdown has real data without a client-side fetch) and hands them to
 * NewInstrumentForm, the actual interactive piece. Requires ?entityId=... (and at
 * least EDITOR on it — this page exists to create data, not just view it); optionally
 * ?stakeholderId=... to preselect (the "add stakeholder, then add an instrument for
 * them" flow lands here with both).
 *
 * v0.21.0: when ?entityId= is missing but the current user has a defaultEntityId set
 * (see prisma/schema.prisma), redirect to the same URL with that id appended rather
 * than immediately showing the "pass ?entityId=..." message — this is what makes
 * NavBar's "New transactions" menu actually usable when you arrive here with no
 * entity in the URL at all (e.g. straight from the home page). The message below only
 * shows when there's ALSO no default entity to fall back to.
 */
export default async function NewInstrumentPage({
  searchParams,
}: {
  searchParams: { entityId?: string; stakeholderId?: string; type?: string };
}) {
  let entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) {
      const params = new URLSearchParams({ entityId: defaultEntityId });
      if (searchParams.stakeholderId) params.set("stakeholderId", searchParams.stakeholderId);
      if (searchParams.type) params.set("type", searchParams.type);
      redirect(`/instruments/new?${params.toString()}`);
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
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 600 }}>
      <p>
        <Link href={`/captable?entityId=${entityId}`}>&larr; Cap table</Link> {" · "}
        <Link href={`/stakeholders/new?entityId=${entityId}`}>Add a stakeholder instead</Link>
      </p>
      <h1>New instrument</h1>
      <NewInstrumentForm
        entityId={entityId}
        stakeholders={stakeholders.map((s) => ({ id: s.id, name: s.name, type: s.type }))}
        initialStakeholderId={searchParams.stakeholderId}
        initialType={searchParams.type}
      />
    </main>
  );
}
