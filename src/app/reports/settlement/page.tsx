import SettlementCalculator from "@/app/components/SettlementCalculator";
import Link from "next/link";

/**
 * Stock option exercise / RSU settlement calculator (v0.20.0) — same thin
 * server-wrapper-around-a-client-component pattern as the exit-waterfall and tax
 * calculator pages. See optionSettlement.ts's module doc comment for the accounting
 * behind this and its flagged simplifications.
 *
 * Same limitation as the exit-waterfall calculator: NOT wired to any stored
 * `Instrument`/`ScheduleEntry` data — this platform's data model has no "exercise" or
 * "settlement" event yet, only grant terms and vesting schedules, so every number here
 * is entered by hand rather than looked up.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function SettlementPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Stock option exercise / RSU settlement calculator</h1>
      <p style={{ color: "#555" }}>
        Computes the journal entry for a cash option exercise, a net (cashless) share settlement — for either a stock
        option or an RSU, including tax withholding — or the remittance of a previously-withheld tax amount. A
        standalone calculator: enter the transaction's numbers by hand below. Not yet wired to any stored instrument's
        vesting schedule (see the README's "Open items" section on the settlement engine's own gaps: no ISO/NSO-aware
        withholding derivation, and net settlement above the maximum statutory withholding rate isn't flagged).
      </p>
      <SettlementCalculator />
    </main>
  );
}
