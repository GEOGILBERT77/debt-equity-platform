import EpsCalculator from "@/app/components/EpsCalculator";
import Link from "next/link";

/**
 * ASC 260-10-45 two-class method EPS calculator (v0.20.0) — same thin
 * server-wrapper-around-a-client-component pattern as the other calculator pages.
 * See epsTwoClass.ts's module doc comment for the full mechanics (net-loss
 * non-allocation rule, the if-converted diluted comparison, and the anti-dilution
 * rule for a loss period) and what's deliberately out of scope (multiple
 * participating classes, non-parity participation rates, full dilution sequencing).
 *
 * Same limitation as the other calculators: NOT wired to any stored `Instrument`
 * data or to a real income statement — every number here is entered by hand. The
 * participating class's as-converted share count should come from the cap table
 * rollup's PREFERRED_STOCK branch (capTable.ts), not be independently guessed here.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function EpsPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Two-class method EPS calculator</h1>
      <p style={{ color: "#555" }}>
        Allocates net income (or loss) between common stock and one participating convertible preferred class per the
        ASC 260-10-45 two-class method, then — in DILUTED mode — compares that result against the if-converted
        method and reports whichever is more dilutive. A standalone calculator: enter the period's numbers by hand
        below. See epsTwoClass.ts for the full scope note on what this does and doesn't handle.
      </p>
      <EpsCalculator />
    </main>
  );
}
