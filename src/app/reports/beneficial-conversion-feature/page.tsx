import BcfCalculator from "@/app/components/BcfCalculator";
import Link from "next/link";

/**
 * ASC 470-20-30 beneficial conversion feature calculator (v0.20.0) — same thin
 * server-wrapper-around-a-client-component pattern as the other calculator pages.
 * See beneficialConversionFeature.ts's module doc comment for the accounting and its
 * documented scope limits (no contingent-conversion deferral, no later "additional
 * BCF" from a down-round repricing).
 *
 * Same limitation as the other calculators: NOT wired to any stored `Instrument` data
 * — every number here is entered by hand rather than looked up from a real convertible
 * note or preferred stock issuance.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function BcfPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Beneficial conversion feature calculator</h1>
      <p style={{ color: "#555" }}>
        Computes the intrinsic value that must be split out at issuance when a convertible note or convertible
        preferred stock's conversion price is below the commitment-date fair value of the underlying stock (ASC
        470-20-30), then produces the resulting journal entry — additional debt discount for a convertible note, or
        an immediate deemed dividend for convertible preferred. A standalone calculator: enter the transaction's
        numbers by hand below. Assumes the instrument is convertible from day one — a contingently convertible
        instrument needs separate handling, see beneficialConversionFeature.ts for the full scope note.
      </p>
      <BcfCalculator />
    </main>
  );
}
