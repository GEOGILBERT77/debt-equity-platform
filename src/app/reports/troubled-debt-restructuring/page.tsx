import TdrCalculator from "@/app/components/TdrCalculator";
import Link from "next/link";

/**
 * ASC 470-60 troubled debt restructuring calculator (v0.20.0) — same thin
 * server-wrapper-around-a-client-component pattern as the other calculator pages.
 * See troubledDebtRestructuring.ts's module doc comment for the full mechanics and
 * why this is a genuinely different test from the ASC 470-50 debt
 * modification/extinguishment calculator (undiscounted vs. discounted comparison).
 *
 * Same limitation as the other calculators: NOT wired to any stored `Instrument`
 * data — every number here is entered by hand. This module also does not detect
 * "financial difficulty" itself — that threshold judgment (is this actually a TDR,
 * or an ordinary renegotiation?) is assumed already made before using this
 * calculator; if it's an ordinary renegotiation, use the debt modification/
 * extinguishment calculator instead.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function TroubledDebtRestructuringPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Troubled debt restructuring calculator</h1>
      <p style={{ color: "#555" }}>
        Runs the ASC 470-60-35-5 undiscounted total-future-cash-payments test for a debt restructuring granted as a
        concession to a debtor in financial difficulty, then produces the resulting accounting — an immediate gain
        with zero further interest expense if total future payments fall below carrying value, a new effective rate
        with no gain otherwise, or full settlement via a transfer of assets/equity. Only use this when the
        restructuring is actually a TDR (a creditor concession due to financial difficulty) — an ordinary
        arm's-length renegotiation belongs in the debt modification/extinguishment calculator instead, which uses a
        different, discounted test. See troubledDebtRestructuring.ts for the full scope note.
      </p>
      <TdrCalculator />
    </main>
  );
}
