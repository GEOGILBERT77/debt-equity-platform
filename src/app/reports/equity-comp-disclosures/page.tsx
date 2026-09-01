import EquityCompDisclosuresCalculator from "@/app/components/EquityCompDisclosuresCalculator";
import Link from "next/link";

/**
 * ASC 718-10-50 stock compensation footnote disclosure calculator (v0.20.0) — same
 * thin server-wrapper-around-a-client-component pattern as the other calculator
 * pages. Covers two more pieces of the README's pinned "additional ASC 718 footnote
 * disclosures" gap: the award activity rollforward by count (with weighted-average
 * exercise price rolled by dollar balance, not a simple average), and intrinsic
 * value realized across a batch of exercises. See `reporting.ts`'s doc comment above
 * `buildAwardActivityRollforward`/`computeIntrinsicValueRealized` for the full
 * mechanics — unrecognized compensation cost is already covered by the financial
 * statements report's `buildStockCompDisclosure`, and cash/tax-withholding effects by
 * that report's `buildSettlementActivityDisclosure`, so neither is duplicated here.
 *
 * Same limitation as the other calculators: NOT wired to any stored `Instrument`
 * data or existing schedule — every number here is entered by hand. Still not built
 * anywhere: the fair-value assumptions rollup table, and the vested/expected-to-vest
 * table — see reporting.ts's doc comment for why.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function EquityCompDisclosuresPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Equity compensation footnote disclosures</h1>
      <p style={{ color: "#555" }}>
        Two more pieces of the standard ASC 718-10-50 disclosure package: the award activity rollforward by count,
        and intrinsic value realized across a period's exercises. Unrecognized compensation cost and its
        weighted-average remaining period are already covered by the{" "}
        <Link href="/reports/financial-statements">financial statements report</Link>; see reporting.ts for the full
        scope note, including what's deliberately out of scope.
      </p>
      <EquityCompDisclosuresCalculator />
    </main>
  );
}
