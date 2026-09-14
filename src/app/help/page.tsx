import Link from "next/link";
import { theme } from "@/lib/theme";

/**
 * A plain-language quick-start/help page for the "Help" nav item (see NavBar.tsx) —
 * aimed at the person actually using this day to day, not a developer reading the
 * README (which stays the technical/engineering reference; this page restates only
 * the parts of it a user needs, in their own terms).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function HelpPage() {
  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 700 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Help</h1>

      <h2>Getting started</h2>
      <ol style={{ lineHeight: 1.8 }}>
        <li>
          From the home page, click <strong>+ New entity</strong> to create the client (company) you're
          working with — or use the sample entity that's already there.
        </li>
        <li>
          Click into that entity's <strong>Cap table</strong>, then <strong>+ Add a stakeholder</strong> for
          each person or entity that will hold an instrument (an employee, an investor, a lender).
        </li>
        <li>
          Use the <strong>New transactions</strong> menu at the top (grouped by Equity and Debt) to record a
          specific instrument — a stock option grant, a term loan, a SAFE, and so on — for one of those
          stakeholders.
        </li>
        <li>
          Everything you've recorded shows up on that entity's <strong>Cap table</strong> and in{" "}
          <strong>Reports</strong> — journal entries, financial statements, and the audit trail.
        </li>
        <li>
          On the cap table, click <strong>Close all instruments through today</strong> to run the accounting
          engine for every instrument at once and store the results — Reports read only from what's been
          closed this way, never from a live recomputation. You can also close one instrument at a time from
          its own page if you only need to update that one.
        </li>
        <li>
          For a stock option, RSU, or restricted stock grant, its own page also shows the complete month-by-
          month amortization table for the whole vesting period — but it isn't included in any report until
          you click <strong>Approve this schedule</strong> there. This is a real, required checkpoint before a
          grant "goes live," but it's a ONE-TIME step: once approved, nothing further is needed unless the
          grant's terms change later. Every approved stock option gets combined into one company-wide total on
          the "Stock option amortization" report under <strong>Reports → Accounting</strong>, and the "Stock option
          forecast" report there splits that into what's already recognized vs. what's still ahead, plus a
          what-if calculator for planned future grants.
        </li>
        <li>
          For several grantees at once with a standard vesting schedule (stock options, RSUs, or restricted
          stock), use <strong>New transactions → Bulk upload grants (Excel)</strong> instead of entering each
          one by hand — download the template, fill in one row per grantee, and upload it. The upload results
          screen has an <strong>Approve all uploaded grants</strong> button so approving the whole batch is one
          click, not one per grantee.
        </li>
        <li>
          To amend a grant's terms later — a repricing, an extended vesting period — use{" "}
          <strong>Modify terms</strong> on the instrument's own page. For stock options, RSUs, and restricted
          stock, it shows the dollar impact of the proposed change (current vs. proposed schedule, month by
          month) before you commit it; committing is that modification's one approval, so there's nothing
          further to do afterward. Other instrument types can be amended too, just without that dollar-impact
          preview yet.
        </li>
        <li>
          Every modification ever committed shows up on the <strong>Modification History</strong> report under{" "}
          <strong>Reports → Accounting</strong> — search it by the date a modification was actually entered (not when
          its terms take effect) to see which instruments were touched, a summary of which terms changed, and
          the dollar impact on the amortization schedule for each one.
        </li>
        <li>
          For a stock option, RSU, or restricted stock grant, expense is normally recognized straight-line
          through the last vesting tranche — but if the award's requisite SERVICE period runs longer than its
          vesting schedule (e.g. shares vest over 4 years but 6 years of service are required for the award to
          be fully earned), set <strong>Service period ends</strong> on the grant's terms; the amortization
          schedule then spreads recognition through that later date instead. Leave it blank for the ordinary
          case, where the service period and the vesting schedule are the same thing.
        </li>
        <li>
          Every grant's full terms — grant date, quantity, strike price (stock options), grant-date fair value,
          vesting, service period, and approval status — are listed by grant ID on the{" "}
          <strong>Grants report</strong> under <strong>Reports → Accounting</strong>. Strike price is disclosure-only:
          it's captured on the grant (required for a stock option) and shown on this report, but it isn't used
          anywhere in the ASC 718 expense calculation, which depends only on grant-date fair value.
        </li>
        <li>
          A stock option, RSU, or restricted stock grant that lapsed — forfeited before vesting, or a vested
          option whose exercise window ran out — should be recorded on that instrument's own page under{" "}
          <strong>Forfeitures &amp; expirations</strong>. This is what feeds the "Forfeited"/"Expired" columns
          on the <strong>ASC 718 disclosures</strong> report (under <strong>Reports → Financial Statements</strong>) —
          that report's roll-forward (beginning balance, additions, exercises/vesting, forfeitures, ending
          balance) is computed entirely from what's actually been recorded across the app, for a date range and
          award-type/vesting-class combination you choose, never typed in by hand.
        </li>
      </ol>

      <h2>New transactions vs. Reports calculators</h2>
      <p style={{ color: theme.inkMuted }}>
        <strong>New transactions</strong> permanently records an instrument against one of your entities —
        it's the real data entry. Most of what's under the <strong>Reports → ASC calculators</strong> group is a standalone
        calculator instead: you type in the terms of a scenario and get the computed accounting treatment
        (journal entries, a schedule, a disclosure) back, without it being saved anywhere. Use the
        calculators to check the math on something before — or without — entering it permanently.
      </p>

      <h2>What isn't built yet</h2>
      <p style={{ color: theme.inkMuted }}>
        The <strong>ERP feed</strong> and <strong>documents received by email</strong> sections on the home
        page, and the <strong>Communications</strong> page, are placeholders for features that need a
        vendor decision (an accounting-system sync, an inbound-email provider, an outbound-email provider)
        before they can do anything — none of that is connected yet.
      </p>

      <h2>Account</h2>
      <p style={{ color: theme.inkMuted }}>
        If you're still using the bootstrap login (<code>bootstrap@example.com</code>), change that
        password as soon as you can — it's a publicly-documented credential, not a private one.
      </p>
    </main>
  );
}
