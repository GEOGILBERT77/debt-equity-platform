import DebtModificationCalculator from "@/app/components/DebtModificationCalculator";
import Link from "next/link";

/**
 * ASC 470-50 debt modification / extinguishment calculator (v0.20.0) — same thin
 * server-wrapper-around-a-client-component pattern as the settlement and
 * exit-waterfall calculator pages. See debtModification.ts's module doc comment for
 * the accounting behind this and what's deliberately out of scope (troubled debt
 * restructurings, multi-lender syndications).
 *
 * Same limitation as the other calculators: NOT wired to any stored `Instrument` data
 * — this platform's data model has no "modification event" yet, only issuance terms
 * and amortization schedules, so every number here is entered by hand rather than
 * looked up.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function DebtModificationPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Debt modification / extinguishment calculator</h1>
      <p style={{ color: "#555" }}>
        Runs the ASC 470-50-40 10% cash flow test to classify a change in a debt instrument's terms as either a
        MODIFICATION or an EXTINGUISHMENT, then produces the resulting journal entry — old debt derecognized at a
        gain/loss and new debt recorded at fair value for an extinguishment, or a lender fee capitalized as
        additional discount for a modification. A standalone calculator: enter the transaction's numbers by hand
        below. Does not cover troubled debt restructurings (ASC 470-60) or multi-lender syndications tested
        creditor-by-creditor — see debtModification.ts for the full scope note.
      </p>
      <DebtModificationCalculator />
    </main>
  );
}
