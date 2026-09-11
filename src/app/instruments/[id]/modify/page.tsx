import Link from "next/link";
import { theme } from "@/lib/theme";
import { db } from "@/lib/db";
import { requirePageEntityAccess } from "@/lib/auth/pageGuard";
import { ModifyGrantForm } from "@/app/components/ModifyGrantForm";
import { ModifyInstrumentJsonForm } from "@/app/components/ModifyInstrumentJsonForm";

const SCHEDULE_TYPES = ["STOCK_OPTION", "RSU", "RESTRICTED_STOCK"] as const;

/**
 * "Functionality that allows us to preview and report on the impacts of
 * modifications" — server wrapper for the Modify flow: fetches the instrument's
 * current (latest) terms so the form can be pre-filled and the impact preview has
 * something to diff against, gates on EDITOR (this page exists to change data), and
 * picks which form to render. STOCK_OPTION/RSU/RESTRICTED_STOCK get ModifyGrantForm
 * (a typed form with a real dollar-impact preview); every other type gets
 * ModifyInstrumentJsonForm (raw terms JSON, no typed sub-form yet, but a preview call
 * is still made — see MODIFICATION-IMPACT-PLAN.md for the scope decision).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function ModifyInstrumentPage({ params }: { params: { id: string } }) {
  const instrument = await db.instrument.findUnique({
    where: { id: params.id },
    include: { termVersions: { orderBy: { effectiveDate: "asc" } }, stakeholder: true },
  });

  if (!instrument) {
    return <p>No instrument found with id "{params.id}".</p>;
  }

  await requirePageEntityAccess(instrument.entityId, "EDITOR");

  const latestTermVersion = instrument.termVersions[instrument.termVersions.length - 1];
  const isScheduleType = (SCHEDULE_TYPES as readonly string[]).includes(instrument.type);

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 900 }}>
      <p>
        <Link href={`/instruments/${instrument.id}`}>&larr; {instrument.type} — {instrument.stakeholder.name}</Link>
      </p>
      <h1>Modify terms</h1>
      <p style={{ color: theme.inkMuted }}>
        Records a new, dated version of this instrument's terms — the original terms stay exactly as recorded
        for everything before this modification's effective date, since they were correct at the time (see the
        term-version history on this instrument's own page). This is for a real change in terms (a repricing,
        an amendment) — to fix a data-entry MISTAKE in already-closed periods, use Corrections on the
        instrument's own page instead.
      </p>
      {isScheduleType ? (
        <ModifyGrantForm
          instrumentId={instrument.id}
          type={instrument.type as "STOCK_OPTION" | "RSU" | "RESTRICTED_STOCK"}
          currentTerms={latestTermVersion.terms}
          currentEffectiveDate={latestTermVersion.effectiveDate.toISOString().slice(0, 10)}
        />
      ) : (
        <ModifyInstrumentJsonForm
          instrumentId={instrument.id}
          currentTerms={latestTermVersion.terms}
          currentEffectiveDate={latestTermVersion.effectiveDate.toISOString().slice(0, 10)}
        />
      )}
    </main>
  );
}
