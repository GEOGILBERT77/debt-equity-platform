import EsppCalculator from "@/app/components/EsppCalculator";
import Link from "next/link";

/**
 * ASC 718-50 employee stock purchase plan (ESPP) calculator (v0.20.0) — same thin
 * server-wrapper-around-a-client-component pattern as the other calculator pages.
 * See espp.ts's module doc comment for the full mechanics: the ASC 718-50-25-1
 * noncompensatory-plan test, the look-back/discount-only grant-date valuation, and
 * the purchase-date journal entry.
 *
 * Same limitation as the other calculators: NOT wired to any stored `Instrument`
 * data — every number here is entered by hand. This module also does not derive
 * the number of shares actually purchased (payroll withholding elections and the
 * IRC 423(b)(8) $25,000/year limit both affect that) — quantity is a given input.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function EsppPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>ESPP calculator</h1>
      <p style={{ color: "#555" }}>
        Runs the ASC 718-50-25-1 noncompensatory-vs-compensatory classification test, values a compensatory purchase
        right's grant-date fair value (a closed-form Black-Scholes decomposition for a look-back plan, or a simple
        discounted-forward value for a discount-only plan with no look-back), and produces the purchase-date journal
        entry. A look-back feature makes a plan compensatory regardless of the discount size — see espp.ts for the
        full ASC 718-50-25-1 test and what's deliberately out of scope (multi-period reset offerings, mid-offering
        withdrawal optionality, the IRC 423(b)(8) $25,000/year limit).
      </p>
      <EsppCalculator />
    </main>
  );
}
