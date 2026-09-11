# Build info

- **Version:** 0.36.0
- **Packaged:** 2026-09-11 14:08 UTC
- **Test suite at packaging time:** 462/462 passing (`npm test`)
- **Latest feature delivery notes:** `README-v0.36.0.md` (included at the project root
  of this package) — covers the QSBS attestation letter, Form 3922 generator, Rule 701
  tracker, board consent record-keeping, and board-observer portal access, plus install
  steps for the one pending database migration
  (`db/migrations/2026-09-board-consent-and-portal-observer.sql`).

## What this file is

This is a full snapshot of the project as of the version/timestamp above — every file
in the working codebase, not just a delta. If you're merging this into your local
clone, it's safe to overwrite everything with what's in this zip; nothing here has been
trimmed or summarized.

The main `README.md` is the original project narrative from early development (through
v0.20.0) and was not kept updated after that — treat feature-by-feature history from
v0.33.0 onward as living in each delivery's own `README-vX.Y.Z.md` instead (only the
latest one, v0.36.0, is included in this package; ask if you want earlier ones
re-sent).

## Before you deploy this snapshot

If you haven't already applied it: run
`db/migrations/2026-09-board-consent-and-portal-observer.sql` once against your live
Supabase database (see `README-v0.36.0.md` for the full steps), then
`npx prisma generate`. Every migration through this one is already folded into
`db/schema.sql` for reference / a from-scratch install, and `db/validate.sql` has been
re-run against a real local Postgres 16 instance to confirm the schema and migration
both check out.
