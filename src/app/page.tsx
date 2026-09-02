import Link from "next/link";
import { db } from "@/lib/db";
import { requireCurrentUser } from "@/lib/auth/pageGuard";
import { EntityRowActions } from "@/app/components/EntityRowActions";

/**
 * Home page — lists every Entity the CURRENT USER has access to (never every entity in
 * the database — see prisma/schema.prisma's User/EntityAccess note), since that's the
 * top of the data model's hierarchy (Entity -> Stakeholder -> Instrument). "New entity"
 * below (src/app/entities/new) plus "Add a stakeholder"/"Add an instrument" on each
 * entity's cap table page now cover onboarding a new client entity end to end —
 * previously the only way in was db/seed.sql or a direct SQL insert via Supabase's
 * Table Editor (DEPLOYMENT.md). As of v0.18.0, the instrument form is a bespoke,
 * per-type guided form (see NewInstrumentForm.tsx's doc comment), not the single JSON
 * textarea earlier versions used, and this table's rightmost column now offers real
 * inline rename/delete for an entity (EntityRowActions.tsx) — see that component's doc
 * comment for the access-level and foreign-key-safety reasoning.
 *
 * The row of calculator links that used to live directly on this page moved into the
 * top nav bar's "New transactions" and "GAAP reports" menus (see NavBar.tsx) once that
 * existed — this page went back to being just the entity directory plus the two
 * "coming soon" sections below, rather than duplicating navigation that's now global.
 *
 * ERP FEED / EMAIL DOCUMENTS (both "Not connected" below): these are placeholder
 * sections for two real, requested features that need a vendor decision and real
 * integration engineering before they can show anything — neither is faked with
 * sample data, since that would be more misleading than an honest empty state. See
 * INTEGRATIONS.md for the architectural gaps (no credential storage, no background
 * job runner, no webhook receiver) that block ANY vendor connection today, not just
 * these two specifically — that document is the right starting point once a specific
 * ERP vendor or an inbound-email provider (e.g. Postmark/Mailgun's inbound parse) is
 * chosen.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app: no
 * installed Next.js/React/@prisma-client here (see src/lib/db.ts).
 */
export default async function HomePage() {
  const user = await requireCurrentUser();

  const entities = await db.entity.findMany({
    where: { access: { some: { userId: user.id } } },
    include: { _count: { select: { stakeholders: true, instruments: true } } },
    orderBy: { name: "asc" },
  });

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 900 }}>
      <h1>Debt &amp; Equity Platform</h1>
      <p style={{ color: "#555" }}>
        This is a minimal, functional front end over the engines and schema built so far — not a finished
        product. It's meant for testing the real computation and persistence layer end to end against a real
        database, not for real client data yet (see the README's "not addressed" list: no auth, no
        multi-tenancy, no input validation).
      </p>

      <p>
        <Link href="/entities/new" style={{ ...buttonLinkStyle }}>
          + New entity
        </Link>
      </p>

      <div style={feedSectionStyle}>
        <h2 style={{ marginBottom: "0.25rem" }}>ERP feed</h2>
        <p style={notConnectedTextStyle}>
          Not connected. Once a general-ledger vendor (QuickBooks Online, Xero, NetSuite — see
          INTEGRATIONS.md) is chosen and wired up, new items synced from it would appear here.
        </p>
      </div>

      <div style={feedSectionStyle}>
        <h2 style={{ marginBottom: "0.25rem" }}>Documents received by email</h2>
        <p style={notConnectedTextStyle}>
          Not connected. Once an inbound-email provider is chosen and wired up, documents (signed
          agreements, 409A reports, statements) received at a dedicated address would appear here for
          review and filing.
        </p>
      </div>

      <h2>Entities</h2>
      {entities.length === 0 && (
        <p>
          No entities you have access to yet — create one above, or ask an existing OWNER on an entity to
          grant your account access (see the README's "Real authentication and multi-tenancy" section).
        </p>
      )}
      {entities.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Entity</th>
              <th style={cellStyle}>Reporting currency</th>
              <th style={cellStyle}>Stakeholders</th>
              <th style={cellStyle}>Instruments</th>
              <th style={cellStyle}></th>
            </tr>
          </thead>
          <tbody>
            {entities.map((e) => (
              <tr key={e.id}>
                <td style={cellStyle}>{e.name}</td>
                <td style={cellStyle}>{e.reportingCurrency}</td>
                <td style={cellStyle}>{e._count.stakeholders}</td>
                <td style={cellStyle}>{e._count.instruments}</td>
                <td style={cellStyle}>
                  <Link href={`/captable?entityId=${e.id}`}>Cap table</Link>
                  {" · "}
                  <Link href={`/reports?entityId=${e.id}`}>Reports</Link>
                  {" · "}
                  <EntityRowActions entityId={e.id} initialName={e.name} initialReportingCurrency={e.reportingCurrency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: "1px solid #ccc", padding: "0.5rem", textAlign: "left" };
const buttonLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.4rem 0.8rem",
  border: "1px solid #333",
  borderRadius: 4,
  background: "#f5f5f5",
  textDecoration: "none",
  color: "inherit",
};
const feedSectionStyle: React.CSSProperties = {
  border: "1px dashed #ccc",
  borderRadius: 4,
  padding: "0.75rem 1rem",
  margin: "1rem 0",
  background: "#fafafa",
};
const notConnectedTextStyle: React.CSSProperties = { color: "#888", fontSize: "0.9rem", margin: 0 };
