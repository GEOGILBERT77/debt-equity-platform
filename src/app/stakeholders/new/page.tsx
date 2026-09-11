import Link from "next/link";
import { redirect } from "next/navigation";
import { requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { NewStakeholderForm } from "@/app/components/NewStakeholderForm";
import { theme } from "@/lib/theme";

/**
 * Server component wrapper for NewStakeholderForm.tsx (v0.36.0) — this page used to be
 * a single client component that read `?entityId=` via `useSearchParams()` directly
 * and had no fallback when it was missing. Split out so it could pick up the same
 * "fall back to the user's default entity before showing the 'pass ?entityId=...'
 * message" redirect every other entity-scoped page has had since v0.21.0 (see
 * instruments/new/page.tsx's doc comment for the original pattern) — a plain client
 * component can't call the server-side `requireCurrentUser()` this needs, hence the
 * wrapper. Caught via user report (several pages were missing this), not something
 * this sandbox could verify on its own.
 *
 * Adds an investor, debt holder, employee, or advisor to an entity — see
 * src/app/api/entities/[id]/stakeholders/route.ts. Requires ?entityId=... (or a
 * default entity) since a stakeholder always belongs to exactly one entity.
 */
export default async function NewStakeholderPage({ searchParams }: { searchParams: { entityId?: string } }) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) redirect(`/stakeholders/new?entityId=${defaultEntityId}`);
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code>, or go to <Link href="/">the entity list</Link> and use "Add a
          stakeholder" from a specific entity's cap table (or set a default entity there).
        </p>
      </main>
    );
  }

  return <NewStakeholderForm entityId={entityId} />;
}
