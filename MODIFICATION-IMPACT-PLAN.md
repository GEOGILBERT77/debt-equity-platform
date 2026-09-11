# Modification impact preview — coverage and plan

**Why this file exists:** the request was "functionality that allows us to preview
and report on the impacts of modifications." `POST /api/instruments/:id/modifications`
already existed (it records a modification as a new, dated `InstrumentTermVersion`),
but had no UI at all, and no way to see what a proposed change would actually do to
the numbers before committing it. This tracks what "preview the impact" means for
each instrument type today and what's still ahead.

## Done (v0.26.0) — STOCK_OPTION / RSU / RESTRICTED_STOCK

The three types with a full, natural-end-date amortization table (see
`computeFullSchedule`'s doc comment in `dispatch.ts`) get a real dollar-impact
preview: `previewModificationImpact` (`src/lib/db/amortizationSchedule.ts`) computes
the instrument's CURRENT full schedule and a PROPOSED one (current term versions plus
the hypothetical new one, nothing persisted), and diffs them period by period plus a
total. `POST /api/instruments/:id/modifications/preview` exposes this; the "Modify
terms" page (`/instruments/:id/modify`, via `ModifyGrantForm.tsx`) reuses the exact
same typed sub-forms `NewInstrumentForm.tsx` uses for creating a grant
(`ServiceConditionGrantForm`/`RestrictedStockForm`), pre-filled with the instrument's
current terms, with a "Preview impact" step before "Commit this modification."

Committing bundles this modification's one required approval (see
`amortizationSchedule.ts`'s top-of-file doc comment on the "one approval per
data-entry event" model) — no separate step needed after commit.

## Also reachable, without a dollar-impact preview — the other eight types

`ModifyInstrumentJsonForm.tsx` makes `POST /api/instruments/:id/modifications`
reachable from the UI for every OTHER instrument type too (TERM_LOAN, PIK_NOTE,
REVOLVER, CONVERTIBLE_NOTE, WARRANT, PREFERRED_STOCK, SAR, COMMON_STOCK) — a raw
terms-JSON editor, same preview-then-commit flow, but the preview call comes back
`applicable: false` with an explanation for these, since a period-by-period
roll-forward type has no "full projected total" to diff the way a fixed-total vesting
schedule does. This is a genuine gap, not an oversight — recording a modification for
these types was previously not possible from the UI at all, so even the
no-dollar-preview version is real progress, but it's not the finished feature for
these types.

## What a real impact preview would need, per type

Not all eight remaining types need the same kind of "impact" — they split into two
groups:

- **Debt-shaped (TERM_LOAN, PIK_NOTE, CONVERTIBLE_NOTE, REVOLVER)** — these already
  have a DIFFERENT, purpose-built modification analysis: the debt-modification report
  (`/reports/debt-modification`) runs the ASC 470-50 10% cash flow test comparing old
  vs. new terms. That report only covers TERM_LOAN today (see
  `REPORTS-CONVERSION-PLAN.md`) — extending it to PIK_NOTE/CONVERTIBLE_NOTE/REVOLVER
  is the natural way to get a real "impact of a modification" answer for these types,
  rather than trying to force them through the amortization-table diff pattern built
  for equity awards, which isn't the accounting question that matters for a loan
  modification anyway (extinguishment-vs-modification classification, not a expense
  schedule delta).
- **Classification-branch types (WARRANT, PREFERRED_STOCK, SAR)** — same complication
  bulk upload hit for these (see `BULK-UPLOAD-PLAN.md`): terms include a
  classification test that decides which further shape applies, so "the" schedule to
  diff isn't well-defined the same way it is for a straight vesting schedule. A real
  impact preview here needs to handle a modification that changes the classification
  outcome itself (e.g. a repriced warrant crossing from equity- to liability-
  classified), which is a genuinely harder problem than a dollar diff.
- **COMMON_STOCK** — no periodic schedule at all (same as bulk upload's finding), so
  "impact of a modification" for this type is really about cap table effects (share
  count, ownership %), not a schedule diff — a different report entirely
  (`/captable`'s live rollup already reflects any committed modification immediately,
  since it recomputes from current terms on every load).

## Done (v0.27.0) — modification audit report

Direct follow-up: "there needs to be an audit report of all modifications made,"
searchable by date range, showing which instruments were modified, a summary of
which terms changed, and the impact on reporting/financial statements.
`/reports/modification-audit` (`src/lib/db/modificationAudit.ts`) covers every
instrument type (not just the three with a typed Modify form) — it always shows the
terms that changed via a generic field-by-field diff, and shows the dollar
amortization-table impact for STOCK_OPTION/RSU/RESTRICTED_STOCK specifically (the
same "not applicable, see the debt-modification report" message as the Modify
flow's own preview for every other type).

One deliberate, explicit choice: the date range filters on `modificationDate` — when
the modification was COMMITTED (`InstrumentTermVersion.createdAt`) — not
`effectiveDate` (when its terms take effect), per how the request specifically
defined "modification date." This is intentionally different from
`/reports/audit-trail`, which sorts by `effectiveDate`/`discoveredDate` instead — the
two reports answer different questions ("what changed and when did it take effect,"
vs. "what did we actually enter, and when did we enter it") and are kept as separate
pages rather than merged, so neither has to compromise its own sort/filter semantics.

## Suggested order for extending further

1. Extend the debt-modification report to PIK_NOTE/CONVERTIBLE_NOTE/REVOLVER — this
   is the real "impact" answer for the debt-shaped types, and mostly a matter of
   broadening that report's existing query rather than new engine work.
2. Build a typed Modify sub-form (reusing `TermDebtForm`/`PikNoteForm`/etc. from
   `TypeForms.tsx`, the same way `ModifyGrantForm.tsx` reuses the equity ones) so
   those types get a proper form instead of raw JSON, once (1) gives them something
   meaningful to preview against.
3. WARRANT/PREFERRED_STOCK/SAR impact preview — genuinely the hardest of what's left,
   since it means diffing a classification outcome, not just a number.
