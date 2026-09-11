# Bulk Excel upload — coverage and plan

**Why this file exists:** the request was "any user input screen should also have an
excel template option that can handle one or multiple instruments of that kind" — this
tracks which of the eleven `InstrumentType`s that's actually built for, and what each
remaining one needs, since they don't all reduce to the same spreadsheet shape.

## Done (v0.23.0) — the "service condition" family

**STOCK_OPTION, RSU, RESTRICTED_STOCK** — one shared importer
(`src/lib/db/bulkUploadServiceConditionGrants.ts`), one shared page
(`/instruments/bulk-upload?type=...`), one shared API route
(`POST /api/entities/:id/instruments/bulk-upload?type=...`). These three share the
exact same underlying shape (`ServiceConditionGrant` — grantDate, quantity,
grantDateFairValuePerUnit, tranches, attributionMethod; RESTRICTED_STOCK adds one
field, `purchasePricePerShare`), so ONE ROW PER GRANTEE with a STANDARD vesting shape
(total months + cliff months, turned into real tranches by
`generateStandardMonthlyTranches` in vesting.ts) covers all three. Templates:
`public/templates/{stock-option,rsu,restricted-stock}-bulk-upload-template.xlsx`.

Linked from NavBar's "New transactions → Bulk upload grants (Excel)"; the bulk-upload
page itself lets you switch between the three types without going back to NavBar.

## Not yet covered — why these are genuinely different spreadsheets, not just new columns

The remaining eight types don't share a "standard shape" the way vesting does, so each
needs its own template design, not a copy of the service-condition one:

- **TERM_LOAN, PIK_NOTE, CONVERTIBLE_NOTE** — all need a `cashFlows` array (a real
  amortization/payment schedule with its own dates and amounts, plus an effective
  yield). There's no "standard" shortcut the way a 4-year/1-year-cliff vest is
  standard for equity — a loan's payment schedule is bespoke to its terms. The
  natural template shape here is one ROW PER CASH FLOW, grouped by a loan reference
  column (name/date), which is a materially different upload UI (parse, group by
  reference, reassemble into one `cashFlows` array per group) than the one-row-per-
  grantee pattern this file's importer uses.
- **REVOLVER** — similar cash-flow-shaped complexity (`RevolverInputs`), plus it
  isn't even fully wired into the schedule dispatcher yet for drawn-balance interest
  (see dispatch.ts's own scope note on `buildCombinedRevolverSchedule`) — bulk upload
  for this type should wait until that gap is closed, not paper over it.
- **WARRANT** — the terms shape starts with a classification test
  (`WarrantClassificationInputs`) that decides whether a periodic remeasurement
  schedule even applies; a spreadsheet row would need to carry those classification
  facts (down-round protection, settlement terms, etc.), which is a different kind of
  input than "here's a number."
- **PREFERRED_STOCK** — same shape of problem as WARRANT: a classification test
  first (`PreferredStockClassificationInputs`), then conditionally either debt-like
  terms or mezzanine accretion terms depending on what that classification resolves
  to. A bulk row can't be validated the same way until the classification branch is
  known.
- **SAR** — a discriminated union on `settlementType` (STOCK vs. CASH), each branch
  needing different fields (`equityTerms` reuses the service-condition shape;
  `cashTerms` doesn't). The STOCK branch could plausibly reuse this file's importer
  pattern; the CASH branch needs its own.
- **COMMON_STOCK** — has no periodic schedule at all (capTable.ts is the only
  consumer), so its terms shape is much simpler than any of the above — this is
  probably the next easiest one to add after the service-condition family, likely a
  genuine one-row-per-holder shape similar to this file's pattern.

## Suggested order for extending further

1. COMMON_STOCK (simplest remaining shape — no schedule, no classification branch).
2. SAR's STOCK-settled branch (can likely reuse most of
   `bulkUploadServiceConditionGrants.ts`'s machinery).
3. TERM_LOAN (one-row-per-cash-flow design — build and prove this pattern once,
   since PIK_NOTE and CONVERTIBLE_NOTE can likely follow it directly afterward).
4. WARRANT / PREFERRED_STOCK (classification-first design — genuinely the most
   involved of what's left, since the template has to represent a branching decision,
   not just a flat row of scalars).
