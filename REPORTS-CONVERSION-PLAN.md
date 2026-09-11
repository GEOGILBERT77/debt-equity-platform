# Converting "GAAP reports" / "Tax & compliance" from calculators to database reports

**Why this file exists:** direct feedback was "all the GAAP reports and tax/compliance
items should be reports built from the database, not calculators and input fields."
That's a real, multi-part project — the eleven items under NavBar's "GAAP reports" menu
plus the tax page are eleven/twelve genuinely different engines, each with its own
input shape, and some of them model things this database doesn't store at all yet. This
file tracks the conversion item by item so it doesn't get lost or re-litigated from
scratch each time — update it as each item moves, rather than treating this as a
one-time plan.

## Prerequisite infrastructure (done, v0.21.0)

Every report on this list reads from PERSISTED data (ScheduleEntry/JournalEntry), never
a live recomputation — that distinction already existed (see closeService.ts), but
until now the only way to actually persist an instrument's engine-computed schedule
was its own "Close through today" button, one instrument at a time. Added
`POST /api/entities/:id/close` (and a "Close all instruments through today" button on
the cap table page) to run that same close logic across every instrument in an entity
in one action — see `src/lib/db/closeInstrument.ts`'s doc comment. Every report below
depends on this having actually been run for the entity's instruments; a report that
looks empty is very likely an entity that hasn't been closed yet, not a broken report.

## Prerequisite infrastructure (done, v0.22.0) — approved amortization tables

For STOCK_OPTION (and, by the same dispatch.ts code path, RSU/RESTRICTED_STOCK), an
instrument's page now computes and previews the FULL monthly amortization table for
its entire service period (not just elapsed-to-date), and offers an "Approve this
schedule" action that persists it as a new `AmortizationScheduleApproval` — separate
from the close workflow above, which still governs what's actually been booked to the
GL. `/reports/stock-option-amortization` aggregates every approved STOCK_OPTION
schedule in an entity into one company-wide monthly total — this is effectively the
"Equity comp footnote disclosures" item further down this file, now built for
STOCK_OPTION specifically; extending it to also aggregate RSU/RESTRICTED_STOCK is a
small follow-up (same approval mechanism already works for them — see
computeFullSchedule's doc comment in dispatch.ts — the aggregate report just doesn't
query those types yet).

**v0.24.0 — bulk approval.** Confirming the requirement that this platform "track a
large number of various types of stock options and consolidate them into a single
monthly amortization schedule report" surfaced a real gap: approving was one
instrument at a time, so a large batch (especially from bulk upload) meant opening
every grant's own page individually before it would show up in the aggregate report.
Added `approveAllAmortizationSchedulesForEntity` (`src/lib/db/amortizationSchedule.ts`),
`POST /api/entities/:id/amortization-schedule/approve-all?type=...`, and an "Approve
all" button on the stock-option-amortization report itself.

**v0.25.0 (SUPERSEDED by v0.26.0 below) — a brief attempt at making approval fully
automatic.** In response to "there should only be approval on the initial upload or
input of new options... not need any additional approvals after that," this version
made every creation/amendment path silently call an auto-generate helper with no
human review step at all. Direct follow-up feedback clarified that went too far —
kept here only so the history is visible; see v0.26.0 for what's actually live.

**v0.26.0 — approval is a required one-time gate, not automatic.** Corrected
understanding of the same requirement, per: "there should be an approve function
prior to the grant 'going live' and being included in reporting." The rule is now:
every discrete data-entry EVENT (a new grant, a bulk-uploaded batch, a modification)
gets EXACTLY ONE approval checkpoint before it's live in reporting — approval is
real and required, it just never needs to happen twice for the same event.
- Manual creation: unchanged from v0.22.0 — create, then the instrument's own page
  requires an explicit "Approve this schedule" click.
- Bulk upload: creates every row unapproved; the upload UI shows one "Approve all
  uploaded grants" action covering the WHOLE batch right after upload finishes (see
  `BULK-UPLOAD-PLAN.md`).
- Modification: see the new "impacts of modifications" feature below — committing a
  previewed modification bundles that one approval, since reviewing the preview
  first is what makes the commit action itself a deliberate, informed approval.

**v0.26.0 — "preview and report on the impacts of modifications."** New feature,
tracked in detail in `MODIFICATION-IMPACT-PLAN.md`. `POST /api/instruments/:id/
modifications` existed already but had no UI; it now has one
(`/instruments/:id/modify`), and for STOCK_OPTION/RSU/RESTRICTED_STOCK it's backed by
a real before/after amortization-table diff (`previewModificationImpact` in
`amortizationSchedule.ts`) so you see the dollar impact of a proposed amendment
before committing it — the same "preview, then commit" shape corrections already use.
The other eight instrument types can now record a modification too (previously not
possible from the UI at all), just without a typed form or dollar-impact preview yet
— see the plan doc for why (debt types already have a different, purpose-built
"impact" analysis via the debt-modification report; classification-branch types need
harder work to diff a classification outcome, not just a number).

**v0.28.0 — strike price, an explicit service period, and the grants report.**
Direct follow-up to a request to actually run a hypothetical stock option grant
through the platform: doing that surfaced two real gaps in what a STOCK_OPTION grant
could record, both fixed here, plus confirmed a third thing (attribution method
choice at data entry) was already in place and didn't need new work.
- **Strike price** is now a required field on STOCK_OPTION (optional/unused for
  RSU/RESTRICTED_STOCK/SAR, which share the same underlying shape —
  `ServiceConditionGrant.strikePrice` in `vesting.ts`). It's disclosure-only: the
  ASC 718 expense schedule only ever depended on grant-date fair value, never strike,
  so this field is captured and shown, never computed with. Enforced at
  `termsValidation.ts`'s STOCK_OPTION case; exposed via a new `StockOptionGrantForm`
  (wraps the shared `ServiceConditionGrantForm`, same pattern `RestrictedStockForm`
  already used for `purchasePricePerShare`) in both "New transactions" and "Modify
  terms," and as a required "Strike price" column in the bulk-upload template.
- **An explicit service period**, independent of the vesting schedule —
  `ServiceConditionGrant.servicePeriodEndDate` (optional; blank = same as the last
  vesting tranche, the ordinary case, and existing grants are unaffected). Some
  awards' requisite ASC 718-10-35-8 service period runs longer than the vesting
  schedule implies (shares vest over 4 years, but 6 years of service are required for
  the award to be fully earned) — straight-line attribution now spreads recognition
  through the LATER of the last vest date and this field, instead of always stopping
  at the last vest date. Only affects straight-line; graded still ties each tranche's
  own recognition to its own vest date (that's the definition of graded — see
  `vesting.ts`'s module doc comment), so a grant needing an explicit service period
  layered on top of graded vesting isn't representable by this field. Exposed as an
  optional field on the shared `ServiceConditionGrantForm` (so RSU/RESTRICTED_STOCK/
  a stock-settled SAR's equityTerms all get it too, not just STOCK_OPTION — the same
  ASC 718-10-35-8 concept applies to any service-condition award), and as an optional
  "Service period end date" bulk-upload column for all three service-condition types.
- **Attribution method (straight-line vs. graded) was already a form field** at data
  entry time — `ServiceConditionGrantForm`'s "Attribution method" dropdown, present
  in "New transactions," "Modify terms," and the bulk-upload template's "Attribution
  method" column, all before this pass. Confirmed, no change needed.
- **Grants report** (`/reports/grants`, `src/lib/db/grantsReport.ts`) — "the strike
  price needs to be maintained... as part of a grants report which has all the
  salient terms of each grant by grant ID." One row per STOCK_OPTION/RSU/
  RESTRICTED_STOCK instrument's CURRENT terms (grant ID = instrument id, grantee,
  grant date, quantity, strike price, grant-date FV/unit and total, purchase price,
  attribution method, vesting tranches, service period end date when different from
  vesting, and approval status). Deliberately reads only the latest term version —
  it's a "what are this grant's terms right now" report, not a history; see
  `/reports/modification-audit` for how a grant's terms changed over time.

**v0.29.0 — performance- and market-condition STOCK_OPTION grants, actually wired
in.** Surfaced by a request for a 30-grant batch (10 service, 10 performance, 10
market) meant to exercise every engine: `vesting.ts` has always had three separate
ASC 718 condition builders — `buildServiceConditionSchedule`,
`buildPerformanceConditionSchedule` (the one genuinely stateful engine of the three;
takes an external `probableAsOf` assessment per period and does a full reversal if it
flips to improbable), and `buildMarketConditionSchedule` (fair value already prices
in probability, so it's always straight-line to a `derivedServiceEndDate` and never
reverses) — but `dispatch.ts`'s STOCK_OPTION case only ever called the first one.
Performance- and market-condition grants existed as pure functions with unit-test
callers only; there was no way to actually create one as a persisted `Instrument` and
have it show up in any report. Fixed:
- New `conditionType?: "service" | "performance" | "market"` discriminator, added
  ONLY to STOCK_OPTION's terms shape (`StockOptionInstrumentTerms` in `dispatch.ts`).
  Omitted or `"service"` behaves exactly as every STOCK_OPTION grant always has —
  every existing grant in the database is unaffected. RSU/RESTRICTED_STOCK/SAR are
  untouched; ASC 718's performance/market condition distinction is specific to awards
  with a condition beyond "keep working here," which in practice in this platform
  only comes up for options.
- `getScheduleBuilder`/`naturalScheduleEndDate` (`dispatch.ts`) now branch on
  `conditionType` for STOCK_OPTION: performance calls
  `buildPerformanceConditionSchedule` with a `probableAsOf` array derived
  positionally from a new `probabilityAssessments: {date, probable}[]` terms field
  (same "one entry per period, matched by array index" convention as WARRANT's
  `remeasurement.observations`); market calls `buildMarketConditionSchedule` and uses
  `derivedServiceEndDate` as the schedule's natural end.
- `termsValidation.ts` gained `validateStockOptionPerformanceConditionTerms` /
  `validateStockOptionMarketConditionTerms`, both reusing the existing
  `checkChronological`/`checkAfter` helpers for the new positional array.
- UI: "New transactions" now shows a "Vesting condition" selector for STOCK_OPTION
  (Service / Performance / Market), each backed by its own form
  (`ServiceConditionGrantForm` reused, plus new `PerformanceConditionGrantForm` /
  `MarketConditionGrantForm` in `TypeForms.tsx`). The performance form auto-generates
  a monthly "probable" assessment for every period through the service-end date (the
  ordinary initial-estimate case) and directs to "Modify terms" / raw JSON editing for
  the less common case of flagging specific months improbable — there's no
  month-by-month picker UI yet, a known scoped-out gap, not a bug.
- `DateField` (`FieldPrimitives.tsx`) gained the optional `hint` prop `DecimalField`
  already had, needed by the two new forms.
- Bulk upload, the grants report, and every other STOCK_OPTION-reading report were
  NOT touched — they all dispatch generically through `computeFullSchedule`/
  `getGrantsReport`'s "read this instrument's current terms" pattern, so they pick up
  all three condition types with zero code changes. Confirmed via
  `tests/dispatch.test.ts`'s new equivalence test (all three condition types tie to
  the identical 72-month/$X total for equivalent straight-line inputs) and this
  session's own end-to-end run of a real 30-grant batch through the actual engine
  (`validateInstrumentTerms` + `computeFullSchedule`, executed against a real local
  Postgres instance's output — not just unit tests).

**v0.30.0 — stock comp amortization periods now align to CALENDAR months, not
grant-date anchors.** Caught while reviewing the 30-grant demo batch's consolidated
schedule: a grant made mid-month (e.g. March 16) was recognizing expense in periods
like 3/16-4/16, 4/16-5/16, etc. — a real month's worth of days, but never lining up
with an actual calendar month, so "March's expense" and "April's expense" weren't
well-defined for that grant at all. Two distinct problems, both fixed:
- **Wrong period boundaries.** `computeFullSchedule` (dispatch.ts) built its monthly
  periods with `buildMonthlyPeriods` (dateMath.ts) — deliberately grant-date-anchored,
  correct for the debt daily-accrual demo it was built for, wrong for a report that
  needs to say "this is March's number." Added `buildCalendarMonthlyPeriods`
  (dateMath.ts): periods aligned to the 1st of each calendar month, with a stub first
  period (e.g. 3/16-4/1) and stub last period bracketing the ordinary full months in
  between. `buildMonthlyPeriods` itself is UNCHANGED (still used, on purpose, by the
  debt demo) — this is a new, separate function, not a behavior change to an existing
  one. `allocateStraightLineByElapsedTime` needed zero changes: it already recognizes
  expense by actual elapsed calendar days to each period's end, so a stub period's
  shorter day count naturally produces a smaller, correctly pro-rated amount.
- **Wrong month bucketing in two live reports.** Independent of the above,
  `/reports/stock-option-amortization` and `/reports/stock-option-forecast` (plus the
  hypothetical what-if calculator on the forecast page) grouped schedule rows into a
  "YYYY-MM" bucket using `periodEnd`. That's the EXCLUSIVE boundary into the
  following month, so once periods are calendar-aligned, keying off periodEnd shifts
  every row's expense one calendar month too late (a 4/1-5/1 period is entirely
  April, but periodEnd's own month is May) — the amortization report's own monthly
  aggregate, and the forecast page's whole recognized-vs-unrecognized split (which is
  built from that same month key), were both one month off. Fixed by bucketing on
  `periodStart` instead in all three places; `HypotheticalGrantForecast.tsx` was also
  switched from `buildMonthlyPeriods` to `buildCalendarMonthlyPeriods` so its
  what-if schedule's month keys are actually comparable to the real forecast's.
- Confirmed with a new dispatch.test.ts regression test asserting the exact stub
  period boundaries/amounts for a March-16 grant, plus a live re-run of the 30-grant
  demo batch end to end (see db/seed-condition-type-demo.sql's updated
  `probabilityAssessments` generation — period COUNT for a performance-condition
  grant now depends on whether its grant date falls on the 1st (72 periods) or
  mid-month (73, from the two stubs), so that array had to be rebuilt to match).

## Prerequisite infrastructure (done, v0.23.0) — forecast

`/reports/stock-option-forecast` splits every approved stock option schedule at
today's date into recognized-to-date vs. unrecognized/forecasted, and adds a
never-saved "what if we grant more" what-if calculator on top. See that page's doc
comment for the interpretation of "forecast" this was built against — flag it if a
different kind of forecast (headcount-driven, cash-flow) was actually meant.

## Prerequisite infrastructure (done, v0.33.0) — stock option tax/compliance

George's ask, verbatim: "start pulling together the reporting items for tax/compliance
related to stock option grants and exercises. a user should be able to pull a report
each month that tells them what tax filings need to be done for any options with an
event that requires filing. the system should be able to produce the appropriate tax
and compliance filings for the associated tax agency/regulator agency." Confirmed scope
(his own answers): output format = a filled IRS form as a real PDF; event scope = all
four of ISO exercises (Form 3921), NSO exercises (W-2 ordinary income flags), the ISO
$100k limit / disqualifying dispositions, and 83(b) election deadline tracking; and yes
to a schema change to support it.

This is the first report in this app that needed genuinely new source-of-truth data,
not just a new read over instruments/term-versions that already existed —
`/reports/tax`'s calculators were previously ad hoc precisely because "none of
that data... is persisted anywhere yet" (see that page's own pre-v0.33.0 doc comment).
v0.33.0 closes that gap for stock options specifically:

**Schema** — `Entity` gained `employerIdentificationNumber`/`address` (the Form 3921
"Transferor" box; nullable, since most entities never need a real filing); `Stakeholder`
gained `taxIdNumber` (nullable; **stored in plain text — see the SECURITY doc comment
on that column and in the delivery README before this goes anywhere near a real SSN in
production; field-level encryption is a separate, explicitly-flagged infra task, not
done here**); `StockOptionServiceConditionTerms`/`PerformanceConditionTerms`/
`MarketConditionTerms` already carried `isIncentiveStockOption?` from an earlier pass.
Three new tables: `OptionExerciseEvent` (a recorded exercise — date, quantity, strike,
FMV at exercise), `ShareDispositionEvent` (a recorded sale/transfer of exercised shares,
FK'd to the exercise it came from, `RESTRICT` on delete since a disposition's tax
treatment depends on its exercise), and `TaxFilingRecord` (one row per obligation —
type, tax year, status, optional `exerciseEventId` or `instrumentId`). Dedupe on
`TaxFilingRecord` needed two **partial** unique indexes rather than one combined
`@@unique`, because SQL never treats two NULLs as equal — see `db/schema.sql`'s
`TaxFilingRecord_exercise_dedupe_idx`/`_instrument_dedupe_idx` and the matching doc
comment on the (now intentionally imperfect) Prisma `@@unique`.

**Engine** — new `src/lib/accounting/optionTaxCompliance.ts`, built on top of the
pre-existing (previously uncalled-in-anger) `taxElections.ts` rather than re-deriving
any IRC rule: `classifyDisposition`/`computeDisqualifyingDispositionOrdinaryIncome` (the
statutory lesser-of-bargain-element-or-actual-gain test), `computeNsoExerciseOrdinaryIncome`,
`computeForm3921Data` (refuses to assemble the form — rather than filing a real tax
document with blanks — when entity EIN/address or stakeholder TIN/address is missing),
`classifyRestrictedTransferForFiling` (the 83(b) 30-day deadline), and
`classifyExerciseForFiling`/`buildMonthlyComplianceReport`, the report itself: given a
month, every recorded exercise/disposition/restricted transfer, and the
already-persisted `TaxFilingRecord`s, returns which obligations are due, overdue, or
already filed. `allocateIso100kAcrossExercises` bridges the existing tranche-level
`applyIso100kLimit` (which sorts cross-grant ties by grant date, per IRC 422(d)'s literal
"order in which granted" — not vest date, confirmed by testing against it directly) to
real recorded exercises via FIFO tranche consumption, splitting an exercise that
straddles a tranche boundary exactly proportionally. **Scope limit, surfaced to the user
via an `iso100kRuleSkipped` flag and a visible warning banner, not silently guessed at**:
performance- and market-condition ISO grants have no tranche schedule to allocate the
$100k rule against, so they're excluded from that specific check.

**Form 3921 PDF** — this sandbox's network policy blocks fetching the official IRS PDF
(`www.irs.gov` rejected at the proxy), and no PDF library is installable (npm/pip both
blocked here), so `src/lib/pdf/simplePdfWriter.ts` is a from-scratch, dependency-free
raw PDF-1.4 writer (same "hand-roll when nothing's available" call as the waterfall
sensitivity chart's inline SVG in v0.32.0), and `src/lib/pdf/form3921Pdf.ts` renders
Copy B ("For Employee") and Copy C ("For Corporation's Records") only — **never Copy A**,
which requires special IRS scannable red-ink paper and can't be self-printed for filing;
verified against the IRS's own instructions (Copy B/C are the ones explicitly "made
fillable online"). Box layout, labels, and the three filing deadlines (furnish to
employee Jan 31, paper-file with IRS Feb 28, e-file Mar 31, all of the year following
exercise) were sourced from IRS.gov via web fetch before the direct-download attempt hit
the network block.

**UI** — `/reports/option-tax-compliance` (new page, linked from NavBar's "Entity
reports" group and cross-linked from `/reports/tax`): a month picker and report table
(`OptionTaxComplianceReport.tsx`) showing every obligation due or overdue that month
with a per-row status control and, for Form 3921 rows, a PDF download link; forms to
record a new exercise or disposition against an existing STOCK_OPTION instrument; and
—added after noticing the first draft told a non-technical user to call a raw `PATCH`
API directly — `EntityTaxSetupForm.tsx`, an actual form for the two setup steps
(entity EIN/address, each stakeholder's TIN) shown only when something's missing.
`POST /api/reports/option-tax-compliance` persists newly-discovered obligations as
`PENDING` `TaxFilingRecord` rows on first computation, so later runs reconcile against
what's already been marked filed rather than re-flagging it every month.

**Not in scope** (see the delivery README for the full list): federal filings only, no
state equivalents; no actual e-file transmission to the IRS FIRE system — the PDF is
generated for the user to file themselves; no real payroll withholding-tax computation
for NSO exercises, only the ordinary-income flag; Form 3922/ESPP is out of scope since
this schema has no ESPP instrument type.

## Prerequisite infrastructure (done, v0.32.0) — waterfall breakpoint & sensitivity analysis

After v0.31.0 shipped, George asked to compare it against what Carta and Pulley ship
on their own waterfall products and to bring this report to parity. Carta's own
marketing describes three pieces: breakpoint analysis ("what exit valuation would each
share class need to participate in payouts"), sensitivity analysis ("a line graph of
payouts by share classes... across a range of exit values"), and a payout table for
one specific scenario — the last of which v0.31.0 already had (the scenario
comparison). This version adds the first two.

New `src/lib/accounting/waterfallAnalysis.ts`: `buildWaterfallSensitivity` sweeps
`buildExitWaterfall` across an evenly-spaced range of exit values (the sensitivity
curve's data); `findWaterfallBreakpoints` bisection-searches for the exact exit value
at which each class's breakeven, non-participating-conversion, or participation-cap
transition occurs. Both are deliberately built by calling the existing, already-tested
`buildExitWaterfall` repeatedly rather than deriving separate closed-form formulas —
see that file's doc comment for why a hand-derived formula risks silently drifting
from the real waterfall logic in edge cases (ties, unusual cap combinations) that a
bisection search against the source of truth never can.

`/reports/cap-table-waterfall` now renders two new sections automatically on page
load, with no user input required — the same "since your equity data is already on
Carta" posture their automatic breakpoint view takes: `WaterfallBreakpoints.tsx` (a
table) and `WaterfallSensitivityAnalysis.tsx` (a hand-rolled inline-SVG line chart,
`WaterfallSensitivityChart.tsx` — this app had zero charting library or SVG
visualization anywhere before this, so one was built from scratch using the dataviz
skill's validated colorblind-safe categorical palette rather than adding a dependency
for one feature). Both default to a server-computed range (10x the larger of the total
preference stack or total participation-cap amount) and can be widened from the client
component via `POST /api/reports/cap-table-waterfall`'s new optional `sensitivity` and
`breakpointsMax` request fields, which sit alongside the existing `scenarios` field —
all three reuse the same single server-side class derivation per request.

## Prerequisite infrastructure (done, v0.31.0) — cap table waterfall

The "Exit waterfall" schema gap flagged below (no liquidation preference, seniority,
or participation on `PREFERRED_STOCK`) is now closed. `dispatch.ts` gained an optional
`liquidationPreference?: LiquidationPreferenceTerms` field on
`PreferredStockInstrumentTerms` — `seriesName?`, `seniorityRank`,
`originalIssuePricePerShare`, `liquidationPreferenceMultiple`, `participating`,
`participationCapMultiple?` — validated in `termsValidation.ts`. It's optional and
additive: existing preferred stock instruments with no `liquidationPreference` keep
working everywhere exactly as before (they just get excluded from the new waterfall
report with a clear reason, same as any other genuinely-missing-data case this app
flags rather than guesses at).

New `src/lib/accounting/capTableWaterfall.ts` adapts the real, stored cap table (the
same `CapTableInstrumentInput[]` shape `/captable` and the cap-table-export route
already build) into `exitWaterfall.ts`'s `WaterfallClassInput[]` — grouping preferred
holders by `seriesName` into one class per series (with cross-holder consistency
checks, never silently averaged), pooling every other equity-classified instrument
(common, options, RSUs, warrants, as-converted notes) into one synthetic common class,
and excluding debt on purpose (a real liquidation pays creditors before any equity
waterfall — see that file's doc comment). `exitWaterfall.ts` itself gained
`buildExitWaterfallScenarios` — the same class stack run independently at several exit
values, for the scenario-analysis comparison.

`/reports/cap-table-waterfall` (new page, linked from NavBar.tsx's "Entity reports"
group and from the existing `/reports/exit-waterfall` standalone calculator) is the
report itself: it shows the current seniority/priority ordering derived from real
data, then hands off to `CapTableWaterfallCalculator.tsx` for the exit-value input and
the scenario comparison table, both backed by `POST /api/reports/cap-table-waterfall`
(which re-derives the class stack server-side from the database on every call, never
trusting a client-supplied stack). The pre-existing `/reports/exit-waterfall`
calculator is unchanged and still useful for a hypothetical stack that isn't in the
database at all.

## Done

- **Debt modification / extinguishment** (`/reports/debt-modification`) — v0.21.0.
  Now lists every TERM_LOAN in the entity with 2+ recorded term versions and runs the
  ASC 470-50 10% cash flow test automatically off the stored terms of the last
  modification. See that page's doc comment for the current scope limits (TERM_LOAN
  only; tests only the most recent modification per instrument; assumes annual cash
  flow spacing). Moved from the "ASC calculators" group into "Entity reports" in
  NavBar.tsx, and now requires `?entityId=` like every other real report.

## Next — confirmed convertible now (the data already exists in the schema)

These don't need any new columns or instrument types — they need the same treatment
debt-modification just got: query stored instruments/term versions for the entity,
feed them through the existing engine functions, list the results.

- **Nonemployee awards** — STOCK_OPTION/RSU instruments where the holding
  Stakeholder's `type` isn't EMPLOYEE already distinguishes these; the schedule engine
  is the same `buildServiceConditionSchedule` STOCK_OPTION/RSU already use. A report
  here is a filtered version of the same schedule computation `/instruments/[id]`
  already does per-instrument, rolled up entity-wide.
- **Equity comp footnote disclosures** — largely superseded by
  `/reports/stock-option-amortization` (see the "approved amortization tables"
  section above) for STOCK_OPTION; extend that report to also query RSU/
  RESTRICTED_STOCK/SAR approvals for the full footnote-disclosure aggregation
  (unrecognized compensation cost, weighted-average remaining term).

## Next — likely convertible, not yet verified

Named here so they're not forgotten, but I haven't opened their calculator components
yet to confirm the input shape lines up with what's actually stored:

- **Troubled debt restructuring** — `troubledDebtRestructuring.ts` classifies a
  modification from old/new cash flows, the same shape debt-modification's engine
  uses. If its input shape matches TermDebtInputs-family terms the way
  debt-modification's did, this is the next one to convert, same pattern.
- **Option exercise / RSU settlement** — plausibly triggered by an instrument's
  `status` moving to EXERCISED, which is already a real, stored transition — needs
  checking whether SettlementCalculator.tsx's inputs are otherwise already on the
  instrument/term-version record.
- **Beneficial conversion feature** — applies at issuance of a CONVERTIBLE_NOTE or
  PREFERRED_STOCK; needs checking whether the commitment-date stock FMV and
  conversion price it tests are already part of those instruments' stored terms, or
  are external inputs that would need a new field.

## Next — need new instrument types or fields before a report is possible

These calculators model something this schema doesn't have a place to store at all —
converting them means a schema change first, not just new report-page code:

- **SAFE** — there's no SAFE `InstrumentType` in prisma/schema.prisma's enum at all.
  Needs a new instrument type (and a terms shape, and dispatch.ts wiring) before any
  SAFE can be recorded as an instrument in the first place, let alone reported on.
- **ESPP** — same gap: no ESPP instrument type or terms shape exists yet.
- **Two-class EPS** — needs net income and weighted-average share count for a period,
  neither of which this schema has anywhere to record (there's no "period financial
  results" concept at all yet, only instrument-level schedules/journal entries).
- **Embedded derivative bifurcation** — needs a fair-value-of-derivative input that
  doesn't appear to be part of any instrument's stored terms today; needs review to
  confirm exactly what's missing.
- **Tax filing support (QSBS / 83(b) / ISO $100k limit)** — none of ISO-vs-NSO
  designation, grant-date FMV for tax purposes, or an 83(b) election's filed date is
  persisted anywhere on an instrument today. Needs schema additions before these can
  read real data instead of ad hoc hand-entered numbers.

## Suggested order

1. Troubled debt restructuring (same pattern as debt-modification, likely no schema
   change needed — verify first).
2. Nonemployee awards, then equity comp footnote disclosures (both aggregations over
   data already fully available).
3. Settlement and beneficial conversion feature, once their exact input gaps are
   confirmed.
4. The schema-change items (SAFE, ESPP, two-class EPS, embedded derivative
   bifurcation, tax filing support) — bundle these as one deliberate
   schema/migration pass rather than one column at a time, the same way the
   `defaultEntityId` migration (`db/migrations/2026-09-add-default-entity.sql`) had to
   be handled as a real migration against an already-live database.
