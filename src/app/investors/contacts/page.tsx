import Link from "next/link";
import { redirect } from "next/navigation";
import { theme } from "@/lib/theme";
import { db } from "@/lib/db";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { isInviteStillValid } from "@/lib/auth/portalInvite";
import { InvestorContactsTable, InvestorContactRow } from "@/app/components/InvestorContactsTable";

const INVESTOR_TYPE_LABELS: Record<string, string> = {
  INDIVIDUAL: "Individual",
  INSTITUTION: "Institution",
};

/**
 * "Investor Contacts" (v0.44.0) — George, verbatim: a page with "at least one contact/
 * point person and all contact info (name, mailing address, investor type [individual,
 * institution], email, phone)." One row per equity-capital-providing stakeholder
 * (StakeholderType INVESTOR or ENTITY_HOLDER — "another company acting as an investor
 * or lender," see that enum's doc comment in prisma/schema.prisma) — EMPLOYEE/ADVISOR/
 * DEBT_HOLDER rows deliberately don't show up here, since this is specifically an
 * INVESTOR directory, not a general stakeholder directory (that's the cap table's "All
 * instruments (detail)" table).
 *
 * "AT LEAST ONE CONTACT/POINT PERSON": every row always shows a point-of-contact name,
 * never a blank cell — `contactName` (Stakeholder.contactName) when it's been set,
 * falling back to the stakeholder's own `name` otherwise. That fallback is exactly
 * right for an INDIVIDUAL investor (they ARE their own point of contact) and is a
 * reasonable placeholder for an INSTITUTION whose real point of contact hasn't been
 * recorded yet (shows the institution's own name until someone fills in a person's
 * name via the "Edit" control on the cap table's stakeholder table — this page is
 * read-only by design, same rationale as the cap table's other rollup views: editing
 * lives in one place, not duplicated here).
 *
 * INVESTOR TYPE is shown as "Not set" (not blank, not a guess) for any investor
 * recorded before this feature existed — see Stakeholder.investorType's own doc
 * comment for why this is nullable rather than defaulted.
 *
 * PORTAL STATUS + BULK ACTIONS (v0.45.0): "there should be a status column of whether
 * the investor is in portal: 'Invited,' 'Not invited,' or 'Integrated' ... send a
 * message and invite to portal for one or multiple investors using checkbox." Status is
 * computed here (server-side, from the same StakeholderAccess/PortalInvite rows
 * stakeholders/[id]/page.tsx already reads for one stakeholder at a time — see
 * `isInviteStillValid` in portalInvite.ts, reused as-is rather than re-implemented) and
 * handed to `InvestorContactsTable` as plain data — the checkbox selection, bulk
 * "Invite to Portal," and "Send Message" UI all need client-side state, so that part is
 * a client component (this page stays a server component, same split as
 * NewStakeholderForm/NewStakeholderPage). See that component's own doc comment for why
 * "Send Message" opens the admin's own email client (`mailto:`) rather than sending
 * anything from inside this app — this codebase has no outbound-email vendor wired up
 * anywhere (see communications/page.tsx), and faking a "Send" button that silently does
 * nothing would be worse than not having one.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function InvestorContactsPage({ searchParams }: { searchParams: { entityId?: string } }) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) redirect(`/investors/contacts?entityId=${defaultEntityId}`);
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view investor contacts, or go to <Link href="/">the entity list</Link>{" "}
          (or set a default entity there).
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "VIEWER");

  const investors = await db.stakeholder.findMany({
    where: { entityId, type: { in: ["INVESTOR", "ENTITY_HOLDER"] } },
    include: { portalAccess: true, portalInvites: true },
    orderBy: { name: "asc" },
  });

  const rows: InvestorContactRow[] = investors.map((inv) => {
    const status: InvestorContactRow["status"] =
      inv.portalAccess.length > 0
        ? "INTEGRATED"
        : inv.portalInvites.some((i) => isInviteStillValid(i))
          ? "INVITED"
          : "NOT_INVITED";
    return {
      id: inv.id,
      name: inv.name,
      contactPersonName: inv.contactName || inv.name,
      investorTypeLabel: inv.investorType ? (INVESTOR_TYPE_LABELS[inv.investorType] ?? inv.investorType) : null,
      address: inv.address,
      email: inv.email,
      phone: inv.phone,
      status,
    };
  });

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1250 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${entityId}`}>Cap table</Link>
      </p>
      <h1>Investor Contacts</h1>
      <p style={{ color: theme.inkMuted }}>
        Every INVESTOR and entity-holder stakeholder on this entity's cap table, with a point of contact, the rest
        of their contact info, and their self-service portal status in one place. To add a stakeholder or fix any
        of the contact fields below, use the cap table's "All instruments (detail)" table.
      </p>

      {rows.length === 0 ? <p>No investors recorded for this entity yet.</p> : <InvestorContactsTable entityId={entityId} investors={rows} />}
    </main>
  );
}
