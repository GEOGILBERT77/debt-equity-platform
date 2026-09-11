import ExitWaterfallCalculator from "@/app/components/ExitWaterfallCalculator";
import Link from "next/link";
import { theme } from "@/lib/theme";

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
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href="/reports/cap-table-waterfall">Cap table waterfall report (real stored terms)</Link>
      </p>
      <h1>Exit / liquidation waterfall calculator</h1>
      <p style={{ color: theme.inkMuted }}>
        A standalone calculator — enter the whole cap table stack by hand below. As of v0.31.0, preferred stock CAN
        store liquidation preference, seniority, and participation terms (see the new report linked above, which
        reads them and runs the waterfall on a real entity's actual stack) — this page remains useful for modeling a
        hypothetical stack that isn't in the database at all, or for a quick what-if with numbers you don't want to
        change on a real instrument.
      </p>
      <ExitWaterfallCalculator />
    </main>
  );
}
