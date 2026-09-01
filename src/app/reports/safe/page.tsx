import SafeCalculator from "@/app/components/SafeCalculator";
import Link from "next/link";

/**
 * SAFE (Simple Agreement for Future Equity) classification and accounting calculator
 * (v0.20.0) — same thin server-wrapper-around-a-client-component pattern as the other
 * calculator pages. See safe.ts's module doc comment for the ASC 480-10-25-14
 * classification reasoning and what's deliberately out of scope (a repayment-right
 * SAFE variant, deriving fair value itself, stacked multi-SAFE conversion waterfalls).
 *
 * Same limitation as the other calculators: NOT wired to any stored `Instrument` data
 * — every number here is entered by hand rather than looked up from a real SAFE.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function SafePage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>SAFE calculator</h1>
      <p style={{ color: "#555" }}>
        Classifies a SAFE as liability or equity under ASC 480-10-25-14 (a standard cap/discount SAFE, whose share
        count is variable and whose dollar obligation is fixed at inception, is liability-classified by default —
        this is a specific citable criterion, not a judgment call), then produces the issuance and conversion journal
        entries. A standalone calculator: enter the transaction's numbers by hand below. A liability-classified
        SAFE's ongoing fair value roll-forward reuses the same engine as a liability-classified warrant — see
        safe.ts for the full reasoning and scope notes.
      </p>
      <SafeCalculator />
    </main>
  );
}
