import Link from "next/link";
import { db } from "@/lib/db";
import { NewInstrumentForm } from "@/app/components/NewInstrumentForm";
import { requirePageEntityAccess } from "@/lib/auth/pageGuard";

/**
 * Server component wrapper: fetches the entity's stakeholders here (so the form's
 * dropdown has real data without a client-side fetch) and hands them to
 * NewInstrumentForm, the actual interactive piece. Requires ?entityId=... (and at
 * least EDITOR on it — this page exists to create data, not just view it); optionally
 * ?stakeholderId=... to preselect (the "add stakeholder, then add an instrument for
 * them" flow lands here with both).
 */
export default async function NewInstrumentPage({
  searchParams,
}: {
  searchParams: { entityId?: string; stakeholderId?: string };
}) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code>, or go to <Link href="/">the entity list</Link> and use "Add an
          instrument" from a specific entity's cap table.
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
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 600 }}>
      <p>
        <Link href={`/captable?entityId=${entityId}`}>&larr; Cap table</Link> {" · "}
        <Link href={`/stakeholders/new?entityId=${entityId}`}>Add a stakeholder instead</Link>
      </p>
      <h1>New instrument</h1>
      <NewInstrumentForm
        entityId={entityId}
        stakeholders={stakeholders.map((s) => ({ id: s.id, name: s.name, type: s.type }))}
        initialStakeholderId={searchParams.stakeholderId}
      />
    </main>
  );
}
