import NonemployeeAwardCalculator from "@/app/components/NonemployeeAwardCalculator";
import Link from "next/link";

/**
 * ASC 718-10 nonemployee share-based payment award calculator (v0.20.0) — same thin
 * server-wrapper-around-a-client-component pattern as the other calculator pages.
 * See nonemployeeAwards.ts's module doc comment for the full mechanics: the ASC
 * 718-10-25-2C requisite service period presumption, the counterparty-dependent
 * recognition account (an ordinary expense for a vendor/consultant vs. a reduction
 * of revenue for a customer, per ASU 2019-08), and the ASC 606-10-32-27 timing floor
 * for the customer case.
 *
 * Same limitation as the other calculators: NOT wired to any stored `Instrument`
 * data — every number here is entered by hand. This module also does not run ASC
 * 606 revenue recognition itself, or determine whether a recipient IS a nonemployee
 * for accounting purposes — both are given inputs, not derived.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function NonemployeeAwardsPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Nonemployee award calculator</h1>
      <p style={{ color: "#555" }}>
        Applies ASC 718-10-25-2C's requisite-service-period presumption (an award with no explicit condition on the
        nonemployee's future performance is fully vested, and its whole grant-date fair value recognized, on the
        grant date itself), picks the correct recognition account by counterparty (an ordinary compensation-style
        expense for a vendor or consultant, or a reduction of revenue for a customer per ASU 2019-08 and ASC
        606-10-32-25), and computes the ASC 606-10-32-27 timing floor for the customer case. See
        nonemployeeAwards.ts for the full scope note, including what's deliberately out of scope.
      </p>
      <NonemployeeAwardCalculator />
    </main>
  );
}
