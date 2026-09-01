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
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/: no
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
        </Link>{" "}
        <Link href="/reports/tax" style={{ ...buttonLinkStyle, background: "#fff" }}>
          Tax filing calculators
        </Link>{" "}
        <Link href="/reports/settlement" style={{ ...buttonLinkStyle, background: "#fff" }}>
          Option/RSU settlement calculator
        </Link>{" "}
        <Link href="/reports/debt-modification" style={{ ...buttonLinkStyle, background: "#fff" }}>
          Debt modification/extinguishment calculator
        </Link>{" "}
        <Link href="/reports/beneficial-conversion-feature" style={{ ...buttonLinkStyle, background: "#fff" }}>
          Beneficial conversion feature calculator
        </Link>{" "}
        <Link href="/reports/safe" style={{ ...buttonLinkStyle, background: "#fff" }}>
          SAFE calculator
        </Link>{" "}
        <Link href="/reports/eps" style={{ ...buttonLinkStyle, background: "#fff" }}>
          Two-class EPS calculator
        </Link>{" "}
        <Link href="/reports/troubled-debt-restructuring" style={{ ...buttonLinkStyle, background: "#fff" }}>
          Troubled debt restructuring calculator
        </Link>{" "}
        <Link href="/reports/espp" style={{ ...buttonLinkStyle, background: "#fff" }}>
          ESPP calculator
        </Link>{" "}
        <Link href="/reports/nonemployee-awards" style={{ ...buttonLinkStyle, background: "#fff" }}>
          Nonemployee award calculator
        </Link>{" "}
        <Link href="/reports/equity-comp-disclosures" style={{ ...buttonLinkStyle, background: "#fff" }}>
          Equity comp footnote disclosures
        </Link>{" "}
        <Link href="/reports/embedded-derivative-bifurcation" style={{ ...buttonLinkStyle, background: "#fff" }}>
          Embedded derivative bifurcation
        </Link>
      </p>

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
