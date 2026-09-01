import Link from "next/link";
import TaxCalculators from "@/app/components/TaxCalculators";

/**
 * Tax filing support (v0.19.0) — a UI surface for taxElections.ts's calculators, which
 * previously had zero callers outside their own tests. See TaxCalculators.tsx for
 * exactly which three of the five sub-modules get a form here (QSBS, 83(b), ISO
 * $100k) and which two are API-only for now.
 *
 * Deliberately NOT entity-scoped: these are ad hoc calculators (see every
 * /api/reports/tax/* route's doc comment for why — none of the underlying terms
 * shapes persist ISO/FMV/83(b)-election data yet), not a report generated from one
 * entity's stored instruments.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function TaxReportsPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 900 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Tax filing support</h1>
      <p style={{ color: "#555" }}>
        Standalone calculators over taxElections.ts's IRC tax-election engines — not tied to a specific entity's
        stored instrument data, since none of that data (ISO/NSO designation, grant-date FMV for tax purposes, an
        83(b) election's filed date) is persisted anywhere yet. See the README's tax-reporting gaps note.
      </p>
      <TaxCalculators />
    </main>
  );
}
