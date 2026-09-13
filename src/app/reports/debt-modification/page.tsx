import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { runDebtModificationTest, ModificationCashFlow } from "@/lib/accounting/debtModification";
import { TermDebtInputs } from "@/lib/accounting/debtAmortization";
import { money } from "@/lib/accounting/types";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { theme } from "@/lib/theme";
import { ListingTable, spanCell } from "@/app/components/ListingTable";

/**
 * ASC 470-50 debt modification / extinguishment REPORT (v0.21.0) — replaces the old
 * standalone hand-entry calculator (DebtModificationCalculator.tsx, still in the
 * codebase but no longer linked from anywhere) per direct feedback: "all the gaap
 * reports and tax/compliance items should be reports built from the database, not
 * calculators and input fields." This is the first of that conversion — see the
 * REPORTS-CONVERSION-PLAN.md at the repo root for which of the other ASC
 * calculators can follow this same pattern next, and which genuinely can't yet
 * (some model instrument types — SAFE, ESPP — this schema doesn't have at all).
 *
 * WHAT THIS AUTOMATES: for every TERM_LOAN instrument in this entity with 2+
 * InstrumentTermVersion rows (i.e. it's been modified at least once — a term
 * version IS a recorded modification event, see prisma/schema.prisma's design note
 * #2), this runs the ASC 470-50-40 10% cash flow test automatically using the
 * STORED terms of the last two versions — no numbers typed in by hand. The old
 * version's remaining cash flows (from the new version's effective date forward)
 * are the "original" stream, discounted at the OLD version's own effective yield —
 * exactly what the test requires (see debtModification.ts's module doc comment for
 * why the discount rate must be the ORIGINAL rate, never the new terms' rate).
 *
 * SCOPE OF THIS FIRST PASS, deliberately narrow rather than silently wrong:
 *  - TERM_LOAN only. PIK_NOTE/REVOLVER use different terms shapes (PikDebtInputs /
 *    RevolverInputs) that haven't been confirmed to carry the same
 *    {cashFlows, effectiveAnnualYield} shape this test needs — extending this to
 *    them means checking that first, not assuming it.
 *  - Only the MOST RECENT modification (latest two term versions) is tested per
 *    instrument. An instrument modified more than once has earlier modification
 *    events too, each of which should really be tested against ITS OWN prior
 *    version at the time — a fuller version of this report would walk the entire
 *    version history pairwise. Left as a known next step rather than attempted
 *    partially here.
 *  - PERIOD NUMBERING: cash flow dates are converted to sequential integer periods
 *    (1, 2, 3, ...) by chronological order within each stream, matching this
 *    engine's period-based (not calendar-date) discounting — see
 *    debtModification.ts's module doc comment. This assumes annual cash flows, the
 *    same assumption `buildEffectiveInterestSchedule` (debtAmortization.ts) already
 *    makes for TERM_LOAN elsewhere in this app.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function DebtModificationReportPage({
  searchParams,
}: {
  searchParams: { entityId?: string };
}) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) redirect(`/reports/debt-modification?entityId=${defaultEntityId}`);
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

  const instruments = await db.instrument.findMany({
    where: { entityId, type: "TERM_LOAN" },
    include: { stakeholder: true, termVersions: { orderBy: { effectiveDate: "asc" } } },
    orderBy: { createdAt: "asc" },
  });

  type Row = {
    instrumentId: string;
    stakeholderId: string;
    stakeholderName: string;
    modifiedOn: string;
    result?: ReturnType<typeof runDebtModificationTest>;
    error?: string;
  };

  const rows: Row[] = [];
  const notYetModified: { instrumentId: string; stakeholderName: string }[] = [];

  for (const inst of instruments) {
    if (inst.termVersions.length < 2) {
      notYetModified.push({ instrumentId: inst.id, stakeholderName: inst.stakeholder.name });
      continue;
    }
    const previous = inst.termVersions[inst.termVersions.length - 2];
    const current = inst.termVersions[inst.termVersions.length - 1];
    const modifiedOn = current.effectiveDate.toISOString().slice(0, 10);

    try {
      const previousTerms = previous.terms as unknown as TermDebtInputs;
      const currentTerms = current.terms as unknown as TermDebtInputs;

      const originalRemaining = previousTerms.cashFlows
        .filter((cf) => cf.date >= modifiedOn)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const newFlows = [...currentTerms.cashFlows].sort((a, b) => (a.date < b.date ? -1 : 1));

      if (originalRemaining.length === 0) {
        rows.push({
          instrumentId: inst.id,
          stakeholderId: inst.stakeholderId,
          stakeholderName: inst.stakeholder.name,
          modifiedOn,
          error:
            "No remaining cash flows under the prior terms on or after the modification date — nothing to test against.",
        });
        continue;
      }

      const originalCashFlows: ModificationCashFlow[] = originalRemaining.map((cf, i) => ({
        period: i + 1,
        amount: money(cf.amount),
      }));
      const newCashFlows: ModificationCashFlow[] = newFlows.map((cf, i) => ({
        period: i + 1,
        amount: money(cf.amount),
      }));

      const result = runDebtModificationTest({
        originalCashFlows,
        newCashFlows,
        originalEffectiveRatePerPeriod: previousTerms.effectiveAnnualYield,
      });

      rows.push({
        instrumentId: inst.id,
        stakeholderId: inst.stakeholderId,
        stakeholderName: inst.stakeholder.name,
        modifiedOn,
        result,
      });
    } catch (err) {
      rows.push({
        instrumentId: inst.id,
        stakeholderId: inst.stakeholderId,
        stakeholderName: inst.stakeholder.name,
        modifiedOn,
        error: err instanceof Error ? err.message : "Failed to run the modification test",
      });
    }
  }

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${entityId}`}>Cap table</Link>
      </p>
      <h1>Debt modification / extinguishment</h1>
      <p style={{ color: theme.inkMuted }}>
        ASC 470-50-40 10% cash flow test, run automatically against every term loan's stored, most recent
        modification — nothing typed in by hand. See this page's source doc comment for exactly what's in and
        out of scope for this first pass.
      </p>

      {rows.length === 0 && notYetModified.length === 0 && <p>No term loans recorded for this entity yet.</p>}

      {rows.length > 0 && (
        <div style={{ marginBottom: "1.5rem" }}>
          <ListingTable
            columns={[
              { label: "Lender" },
              { label: "Modified on" },
              { label: "PV original", align: "right" },
              { label: "PV new", align: "right" },
              { label: "% difference", align: "right" },
              { label: "Classification" },
            ]}
            rows={rows.map((r) => ({
              key: r.instrumentId,
              cells: [
                <Link href={`/stakeholders/${r.stakeholderId}`}>{r.stakeholderName}</Link>,
                r.modifiedOn,
                ...(r.error
                  ? [spanCell(<span style={{ color: theme.danger.fg }}>{r.error}</span>, 4)]
                  : [
                      r.result!.presentValueOriginal.toString(),
                      r.result!.presentValueNew.toString(),
                      `${r.result!.percentDifference.times(100).toFixed(2)}%`,
                      <span
                        style={{
                          fontWeight: 600,
                          color: r.result!.classification === "EXTINGUISHMENT" ? theme.warning.fg : theme.success.fg,
                        }}
                      >
                        {r.result!.classification}
                        <Link href={`/instruments/${r.instrumentId}`} style={{ marginLeft: "0.5rem", fontWeight: 400 }}>
                          (instrument)
                        </Link>
                      </span>,
                    ]),
              ],
            }))}
          />
        </div>
      )}

      {notYetModified.length > 0 && (
        <>
          <h2>Not yet modified</h2>
          <p style={{ color: theme.inkMuted }}>
            These term loans have only their original terms on file — nothing to test until a modification is
            recorded against them (a new term version).
          </p>
          <ul>
            {notYetModified.map((n) => (
              <li key={n.instrumentId}>
                <Link href={`/instruments/${n.instrumentId}`}>{n.stakeholderName}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
