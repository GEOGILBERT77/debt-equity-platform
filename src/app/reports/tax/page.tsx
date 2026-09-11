import Link from "next/link";
import { theme } from "@/lib/theme";
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
 * v0.33.0 UPDATE: that gap this doc comment used to describe is now closed for stock
 * options specifically — /reports/option-tax-compliance is the real, database-backed
 * counterpart: real ISO/NSO designation, real recorded exercise/disposition events,
 * a real monthly report, and an actual generated Form 3921 PDF. This page's
 * calculators remain useful for QSBS/83(b)/$100k/OID/market-discount scenarios that
 * aren't tied to a specific recorded grant, but for month-to-month ISO/NSO filing
 * tracking, that new report is the one to use.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function TaxReportsPage() {
  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 900 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href="/reports/option-tax-compliance">Stock option tax/compliance report (real data)</Link>
      </p>
      <h1>Tax filing support</h1>
      <p style={{ color: theme.inkMuted }}>
        Standalone calculators over taxElections.ts's IRC tax-election engines — not tied to a specific entity's
        stored instrument data. For a real, entity-scoped monthly report of what tax filings are actually due —
        driven by recorded option exercises and dispositions, with a downloadable Form 3921 — see{" "}
        <Link href="/reports/option-tax-compliance">Stock option tax/compliance</Link> instead.
      </p>
      <TaxCalculators />
    </main>
  );
}
