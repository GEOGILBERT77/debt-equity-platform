import ExitWaterfallCalculator from "@/app/components/ExitWaterfallCalculator";
import Link from "next/link";

/**
 * Exit / liquidation waterfall calculator (v0.19.0) — thin server wrapper around the
 * actual client component, following the same split every other interactive
 * calculator-style page in this app uses (a plain page.tsx that just renders a client
 * component, so the page itself never needs "use client"). See
 * ExitWaterfallCalculator.tsx and exitWaterfall.ts's doc comments for what this is and
 * — importantly — what it deliberately is NOT (a report over stored preferred-stock
 * terms; there's no seniority/participation data persisted anywhere yet to read).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function ExitWaterfallPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Exit / liquidation waterfall calculator</h1>
      <p style={{ color: "#555" }}>
        A standalone calculator — enter the whole cap table stack by hand below. This is NOT wired to any entity's
        stored preferred-stock terms (that data model doesn't capture liquidation preference, seniority, or
        participation yet — see the README). Useful for modeling a hypothetical exit today; not yet a one-click
        report on a real client's actual stack.
      </p>
      <ExitWaterfallCalculator />
    </main>
  );
}
