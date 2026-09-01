# System & filing integrations — design notes (v0.19.0)

This document is the "steps for system/filing integrations" half of the reporting
phase. It is **design and documentation only** — nothing in this file is wired to a
real vendor, and no vendor credentials, OAuth flow, or webhook receiver exists in the
codebase yet. What follows is: what this platform already exports that a real
integration would build on, which vendors are the natural candidates, what's
architecturally missing before a live connection could exist at all, and a phased plan
for closing that gap — written so whoever picks this up next isn't starting from zero.

## What already exists to integrate with

Nothing here was built for this document — these are existing pieces of the platform
that happen to be exactly what an integration needs to plug into:

- **CSV cap table export** (`GET /api/reports/cap-table-export`, v0.19.0) — a generic,
  vendor-neutral export. Every cap table vendor's bulk-upload format diverges from this
  in real ways (Carta wants separate files per security type with vendor-specific
  column names; Pulley's importer wants ISO/NSO tax treatment per option grant, which
  this platform doesn't even store yet — see the tax-reporting gap below). Treat this
  CSV as the source data an entity-specific mapping step transforms, not as something
  any vendor's importer will accept unmodified.
- **Journal entries report** (`GET /api/reports/journal-entries`, pre-existing) —
  already the right shape to feed a general-ledger sync: date, description, ASC
  reference, per-line account/debit/credit. A QuickBooks Online or Xero sync job would
  map this platform's account names to that system's chart of accounts (a mapping this
  platform doesn't maintain today) and push via each vendor's own journal-entry
  creation API.
- **`Document.storageUrl` pointer model** (schema, pre-existing) — the stack already
  made the decision to buy e-signature/redlining (PandaDoc/DocuSign) rather than build
  it; this table is already shaped to store a pointer into that vendor's storage plus a
  status string. No document CONTENT lives in this database by design — see
  `prisma/schema.prisma`'s design note #3.
- **Tax election calculators** (`taxElections.ts`, wired to `/api/reports/tax/*` in
  this version) — the computational half of what a tax-prep integration would need;
  see the gap below on why they can't yet run off this platform's own stored data.

## Candidate systems, by category

| Category | Candidates | What it's for |
|---|---|---|
| Cap table platforms | Carta, Pulley, Shareworks | Import/export cap table data; some clients will already have one of these as system of record and want this platform to reconcile against it, not replace it. |
| General ledger / accounting | QuickBooks Online, Xero, NetSuite | Push closed journal entries so the client's books reflect debt/equity activity without manual re-entry. |
| 409A valuation vendors | Carta 409A, Aduro, Scalar | Feed `grantDateFairValuePerUnit` / Black-Scholes inputs (`blackScholes.ts`) instead of manual entry — see `fairValueRemeasurement.ts`'s own doc comment, which already flags this as manual-entry-only today. |
| E-signature / redlining | PandaDoc, DocuSign | Already the assumed vendor for `Document` — not a new integration decision, just not yet actually wired to either vendor's API (today `storageUrl` is populated by hand). |
| Tax e-filing / prep | Drake, UltraTax, IRS e-file | Feed `taxElections.ts` outputs into a return. Worth flagging explicitly: an IRC 83(b) election itself is **not e-filable** — it's a paper election mailed to the IRS (and, as of the 2025 filing season, a copy is no longer required to be attached to the taxpayer's return, though many practitioners still do) — so any "83(b) integration" is a document-generation/reminder feature, not a filing-API integration. |
| Payroll | Gusto, Rippling, ADP | ISO/NSO ordinary-income and AMT-preference amounts (`taxElections.ts`) ultimately need to reach a W-2 or payroll tax filing — this is a real downstream consumer of this platform's tax calculators that hasn't been scoped at all yet. |

## What's architecturally missing before ANY live integration can exist

These are gaps in the platform itself, not in any particular vendor's API — every item
below blocks every integration in the table above, not just one:

1. **No credential storage.** This app currently has exactly one secret family (the
   Postgres connection string, via `DATABASE_URL`/`DIRECT_URL` env vars — see
   `DEPLOYMENT.md`). A real integration needs **per-entity** vendor credentials (two
   different clients using this platform will have two different QuickBooks accounts),
   which env vars can't express at all. This needs a new encrypted-at-rest credential
   store — a new `EntityIntegration` model (`entityId`, `provider`, encrypted
   token/refresh-token, `expiresAt`) at minimum, plus a real key-management decision
   (a KMS-backed encryption key, not encrypting with something derived from
   `DATABASE_URL`).
2. **No background job runner.** Every route in this app is request/response —
   there's no cron, no queue, no retry-with-backoff mechanism anywhere in the
   codebase. A one-way scheduled sync (phase 2 below) needs at least a cron trigger;
   a webhook-driven two-way sync (phase 3) needs a durable queue so a vendor's retried
   webhook delivery doesn't double-book a journal entry. Vercel Cron or a small queue
   service (this stack has no opinion yet) both work; neither is set up.
3. **No webhook receiver infrastructure.** No route in `src/app/api` accepts an
   unauthenticated inbound POST with vendor-specific signature verification — every
   existing route assumes a logged-in user via this app's own session cookie
   (`middleware.ts`). A webhook receiver is a different trust model entirely (verify a
   vendor's HMAC signature, not a session) and doesn't exist in any form yet.
4. **No conflict-resolution model for two-way sync.** This platform's core design
   principle is an append-only history (`InstrumentTermVersion`, `Correction` — see
   `prisma/schema.prisma`'s design note #2). A vendor pushing an updated valuation via
   webhook is exactly a second writer to the same data this platform already treats as
   append-only-per-writer — deciding whether an inbound vendor update becomes a new
   `InstrumentTermVersion`, a `Correction`, or something else entirely is a real
   design decision, not a mechanical one, and hasn't been made.
5. **Data the terms schemas don't capture yet.** Several integrations above need data
   this platform simply doesn't store: ISO-vs-NSO designation and grant-date FMV on
   `STOCK_OPTION` terms (needed for the ISO $100k / payroll integrations — see
   `taxElections.ts`'s own doc comment and the README's tax-reporting gaps note), an
   83(b)-election-filed-date field on `RESTRICTED_STOCK` terms, and a chart-of-accounts
   mapping table for the GL-sync category. None of these are hard to add — they're
   additive, optional JSON fields, the same pattern `RESTRICTED_STOCK` itself was added
   under — but they're schema work that hasn't been done, listed here so it isn't
   rediscovered from scratch when someone starts on a specific vendor.

## Suggested phased rollout

**Phase 1 — file-based export (done, this version).** A human downloads a CSV/report
from this platform and uploads it into the vendor's own importer by hand. Zero new
infrastructure — this is exactly what `/api/reports/cap-table-export` and the journal
entries report already are. The honest ceiling of this phase: it's manual, point-in-
time, and creates no ongoing sync relationship.

**Phase 2 — one-way scheduled push.** This platform pushes data OUT to a vendor on a
schedule (nightly journal-entry sync to QuickBooks, say), using a simple long-lived API
key per entity (no OAuth needed for most GL vendors' server-to-server APIs) — this only
needs items #1 and #2 above (credential storage + a job runner), not #3 or #4, since
there's no inbound data to reconcile against. This is the natural next phase once a
specific first vendor is chosen; a generic "push journal entries somewhere" adapter
interface (one TypeScript interface implemented per vendor, so QuickBooks and Xero
share the calling code and differ only in their own adapter) is the shape to build it
in, mirroring how `dispatch.ts` already dispatches by instrument type to a shared
interface rather than hand-rolling per-type call sites everywhere.

**Phase 3 — two-way OAuth integration with webhooks.** Needed for anything where the
vendor is itself a source of truth this platform should reflect (a 409A vendor pushing
a new valuation the moment it's finalized, a cap table platform that's the client's
real system of record). This is the expensive phase — it needs all of #1 through #4
above, including the conflict-resolution design work, and shouldn't be started until a
specific vendor and a specific client need justify it.

## Filing-specific notes worth flagging now

- **83(b) elections**: as noted above, this is a paper mail-in, not an e-file target.
  The realistic "integration" here is a document-generation feature (fill a standard
  83(b) election template from `Section83bScenario` data) plus a reminder/deadline
  tracker built on `evaluateSection83bElection`'s already-computed `deadline` field —
  both purely this platform's own UI work, no vendor integration required at all.
- **Form 3921/3922** (ISO exercise / ESPP transfer information returns): these ARE
  IRS-e-filable (or filable through a payroll/tax-prep vendor that handles the actual
  transmission) — but generating correct 3921/3922 data needs the ISO/NSO
  classification data this platform doesn't store yet (see gap #5 above), so this is
  blocked on the same schema work as the ISO $100k integration, not on any new filing
  connector.
- **QSBS (Form 8949 / Schedule D)**: `computeQsbsExclusion`'s output (excludable gain,
  taxable gain, AMT preference) is exactly the numbers a Form 8949/Schedule D
  preparation needs, but this platform has no plan to generate or e-file a tax return
  itself — the realistic integration is exporting these numbers in a shape a tax-prep
  vendor's import step accepts, once a specific vendor is chosen.
