import Link from "next/link";
import { redirect } from "next/navigation";
import { theme } from "@/lib/theme";
import { db } from "@/lib/db";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import OptionTaxComplianceReport, { InstrumentOption } from "@/app/components/OptionTaxComplianceReport";
import EntityTaxSetupForm from "@/app/components/EntityTaxSetupForm";

/**
 * Stock option tax/compliance report (v0.33.0) — George's ask, verbatim: "a user
 * should be able to pull a report each month that tells them what tax filings need to
 * be done for any options with an event that requires filing. the system should be
 * able to produce the appropriate tax and compliance filings for the associated tax
 * agency/regulator agency."
 *
 * This is the real-data, database-backed counterpart to /reports/tax's ad hoc
 * calculators (which that page's own doc comment flagged as unable to do this, since
 * "none of that data... is persisted anywhere yet" — v0.33.0 is what added it: ISO/NSO
 * designation, real exercise/disposition event logs, entity EIN, stakeholder TIN).
 *
 * See optionTaxCompliance.ts's module doc comment for the full engine (Form 3921,
 * NSO/disqualifying-disposition W-2 flags, 83(b) deadline tracking, the $100k-rule
 * allocation across real recorded exercises) and this feature's delivery README for
 * scope caveats (federal only, no actual payroll withholding computed, Form 3921 PDF
 * output is a recreated Copy B/C layout — never Copy A — since this sandbox's network
 * policy blocked fetching the official IRS PDF).
 *
 * NOT EXECUTED IN THIS SANDBOX — no Postgres, no installed Next.js/React here.
 */
export default async function OptionTaxCompliancePage({ searchParams }: { searchParams: { entityId?: string } }) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) redirect(`/reports/option-tax-compliance?entityId=${defaultEntityId}`);
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view this report, or go to <Link href="/">the entity list</Link>
          (or set a default entity there).
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "VIEWER");

  const [entity, stockOptionInstruments, stakeholdersMissingTaxId] = await Promise.all([
    db.entity.findUnique({ where: { id: entityId } }),
    db.instrument.findMany({
      where: { entityId, type: "STOCK_OPTION" },
      include: { stakeholder: { select: { name: true } } },
      orderBy: { issueDate: "desc" },
    }),
    db.stakeholder.findMany({
      where: { entityId, taxIdNumber: null, instruments: { some: { type: "STOCK_OPTION" } } },
      select: { id: true, name: true },
    }),
  ]);

  if (!entity) {
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>No entity found.</p>
      </main>
    );
  }

  const instrumentOptions: InstrumentOption[] = stockOptionInstruments.map((i) => ({
    id: i.id,
    label: `${i.stakeholder.name} — granted ${i.issueDate.toISOString().slice(0, 10)}`,
  }));

  const missingEntitySetup: string[] = [];
  if (!entity.employerIdentificationNumber) missingEntitySetup.push("EIN");
  if (!entity.address) missingEntitySetup.push("address");

  const currentMonth = new Date().toISOString().slice(0, 7);

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1100 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/reports/tax?entityId=${entityId}`}>Ad hoc tax calculators</Link>
      </p>
      <h1>Stock option tax/compliance report</h1>
      <p style={{ color: theme.inkMuted }}>
        Pulls every recorded option exercise and share disposition for this entity, works out which tax filings
        they trigger (Form 3921 for ISO exercises, W-2 flags for NSO exercises and disqualifying dispositions, and
        83(b) election deadlines for early-exercise/restricted grants), and tracks which ones you&apos;ve actually
        filed. Federal filings only — see the delivery notes for full scope.
      </p>

      {(missingEntitySetup.length > 0 || stakeholdersMissingTaxId.length > 0) && (
        <div style={{ background: theme.warning.bg, border: `1px solid ${theme.warning.fg}`, borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
          <strong>Setup needed before Form 3921 can be generated:</strong>
          <p style={{ margin: "0.5rem 0 1rem", color: theme.inkMuted }}>
            {missingEntitySetup.length > 0 &&
              `This entity is missing its ${missingEntitySetup.join(" and ")}. `}
            {stakeholdersMissingTaxId.length > 0 &&
              `${stakeholdersMissingTaxId.length} stakeholder(s) with stock options have no tax ID on file.`}
          </p>
          <EntityTaxSetupForm
            entityId={entityId}
            entityEin={entity.employerIdentificationNumber}
            entityAddress={entity.address}
            stakeholdersMissingTaxId={stakeholdersMissingTaxId}
          />
        </div>
      )}

      <OptionTaxComplianceReport entityId={entityId} instruments={instrumentOptions} initialMonth={currentMonth} />
    </main>
  );
}
