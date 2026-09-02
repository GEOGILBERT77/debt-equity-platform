import Link from "next/link";

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
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 700 }}>
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
          <strong>GAAP reports</strong> — journal entries, financial statements, and the audit trail.
        </li>
      </ol>

      <h2>New transactions vs. GAAP reports calculators</h2>
      <p style={{ color: "#555" }}>
        <strong>New transactions</strong> permanently records an instrument against one of your entities —
        it's the real data entry. Most of what's under <strong>GAAP reports</strong> is a standalone
        calculator instead: you type in the terms of a scenario and get the computed accounting treatment
        (journal entries, a schedule, a disclosure) back, without it being saved anywhere. Use the
        calculators to check the math on something before — or without — entering it permanently.
      </p>

      <h2>What isn't built yet</h2>
      <p style={{ color: "#555" }}>
        The <strong>ERP feed</strong> and <strong>documents received by email</strong> sections on the home
        page, and the <strong>Communications</strong> page, are placeholders for features that need a
        vendor decision (an accounting-system sync, an inbound-email provider, an outbound-email provider)
        before they can do anything — none of that is connected yet.
      </p>

      <h2>Account</h2>
      <p style={{ color: "#555" }}>
        If you're still using the bootstrap login (<code>bootstrap@example.com</code>), change that
        password as soon as you can — it's a publicly-documented credential, not a private one.
      </p>
    </main>
  );
}
