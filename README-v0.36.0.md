# v0.36.0 — Five items from the Carta/Certent/Pulley gap list (part 1 of that build-out)

## Where this fits in

This is the first installment of "build in the gap list" — the 24-item list from the
Carta/Certent/Pulley comparison spreadsheet. It ships 5 of those items, fully built and
tested. The other ~19 are still queued (see "What's not in this delivery" below) —
several of them need a vendor decision from you first (see the message I sent
separately listing exactly what I need).

## What's in this delivery

**1. QSBS attestation letter generator.** A new tax report
(`/reports/tax` → "QSBS attestation letter") that produces a formatted PDF letter
identifying a shareholder's QSBS-qualifying stock, the company's representations (met
the $50M gross-assets test, active-business requirement, no disqualifying
redemptions), and — optionally — an illustrative Section 1202 exclusion calculation if
you give it a hypothetical sale date and price. **This is a factual letter template
populated from what you tell it, not a computed tax opinion** — the company's
gross-assets and business-activity representations are things you attest to, not
figures this app independently verifies. Not tax or legal advice; have counsel review
before it goes to a shareholder or their accountant.

**2. IRS Form 3922 generator.** Same idea as the Form 3921 generator you already have
(v0.33.0), for ESPP purchases instead of ISO exercises — the 8-box layout, Copies B
and C only (never Copy A, which needs IRS-scannable red ink — same rule as 3921).
Ad hoc calculator (`/reports/tax` → "Form 3922"), not tied to a stored instrument,
because this platform has no ESPP instrument type at all yet — you enter the grant/
exercise/FMV figures directly.

**3. SEC Rule 701 tracker.** A new report (`/reports/rule-701?entityId=...`) that reads
your actual stock option/RSU/restricted stock grants and tells you where you stand
against the two Rule 701 thresholds: the $10,000,000 rolling-12-month disclosure
trigger, and the eligibility ceiling (greater of $1,000,000 or 15% of total assets).
**One piece is deliberately left out**: the third statutory eligibility prong (15% of
outstanding shares of the class) isn't computed, because converting a share count into
a comparable dollar figure needs a specific SEC-sanctioned convention my research
couldn't confirm with confidence. If your numbers are anywhere near either threshold,
get the real figure from securities counsel — this tracker is a monitoring tool, not a
filed determination.

**4. Board consent record-keeping.** A new page (`/entities/:id/board-consents`, also
in the top nav) to record that the board approved something — a written consent or a
board meeting decision — and optionally link it to the specific grants it covers.
**This is a paper-trail record, not an approval gate**: recording a consent here (or
not recording one) has zero effect on whether an instrument can be issued or marked
active. If you eventually want a hard "nothing issues without a logged consent" rule,
that's a bigger change I'd scope separately — let me know.

**5. Board member portal access.** On a stakeholder's page, the "Invite to portal"
button now has a "Grant board-observer access" checkbox. A stakeholder invited this
way sees the entity's full cap table on their portal login, in addition to (not
instead of) their own holdings if they have any. This reuses the exact same
ownership-rollup calculation as your admin cap table page, so it's never a second,
differently-computed number.

## What's not in this delivery

Still queued from the 24-item list, roughly in the order I'd tackle them next:

- The 7 vendor-dependent items (e-signature, 409A ordering, payroll, HRIS, GL/ERP
  sync, investor communications, AML/KYC) — I need vendor picks from you first; see
  my separate message.
- Interactive offer letters, grant/option agreement and stock certificate PDF
  generation, tax election submission in the portal, forward-looking fundraise/
  new-round dilution modeling, IFRS2 reporting, 409A aging/reminder tracking.
- Secondary transactions / tender offers, full multi-currency and multi-jurisdiction
  equity rules (Large/XL items — deferred to a later phase).
- SEC public-company filings and compensation benchmarking — treating these as
  skipped (benchmarking per your "that's dumb" call; SEC filings as a judgment call on
  my end since this platform serves private companies — flag if you want it revisited).

## Installing this update

1. **Unzip this into your project**, overwriting the files it contains. Everything
   under `src/lib/pdf/qsbsAttestationPdf.ts`, `src/lib/pdf/form3922Pdf.ts`,
   `src/lib/accounting/rule701.ts`, the three new `src/app/api/reports/...` routes, the
   two new `src/app/api/entities/.../board-consents` files, and
   `src/app/components/BoardConsentForm.tsx` are brand new. Everything else in this
   zip is an edit to a file you already have.
2. **Run the database migration.** Open your Supabase project's SQL Editor and run the
   contents of `db/migrations/2026-09-board-consent-and-portal-observer.sql` once. It
   only adds two new boolean columns (both default to `false`, so nothing existing
   changes behavior) and two new tables — safe to run against your live database with
   real data in it.
3. **Regenerate the Prisma client:**
   ```
   npx prisma generate
   ```
4. **Commit and push** via GitHub Desktop as usual — Vercel will build and deploy from
   there.

No new environment variables are required.

## Testing performed in this sandbox

- 21 new unit tests across `tests/simplePdfWriter.test.ts` (word-wrap helper),
  `tests/form3922Pdf.test.ts`, and `tests/qsbsAttestationPdf.test.ts` — all passing.
- 10 new unit tests in `tests/rule701.test.ts` covering the rolling-window logic, the
  disclosure-threshold math, and both eligibility-ceiling prongs — all passing.
- Full existing suite re-run alongside these: **462 tests total, all passing** — no
  regressions.
- The new database columns and tables (`StakeholderAccess.boardObserver`,
  `PortalInvite.grantsBoardObserverAccess`, `BoardConsent`, `BoardConsentInstrument`)
  were created and round-trip tested against a real local Postgres 16 instance:
  inserts, the default values, the uniqueness rule, and every "can't delete something
  still in use" rule were verified to behave correctly (new section 9 in
  `db/validate.sql`, 9 new PASS checks).
- The standalone migration file was verified to apply cleanly, on its own, to a copy
  of the database as it existed *before* this update, and the resulting database
  passed the exact same validation suite as a from-scratch install — matching what
  running it against your real Supabase database will do.
- This was not run inside an actual Next.js dev server or deployed to Vercel (not
  possible from this sandbox) — the usual caveat that applies to every feature
  delivered this way.
