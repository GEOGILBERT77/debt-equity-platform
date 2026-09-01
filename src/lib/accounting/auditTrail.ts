import { ISODate } from "./types.js";

/**
 * Compliance / audit-trail reporting (v0.19.0) — a pure formatting/merging layer over
 * two things this codebase already persists but has never surfaced as one combined,
 * chronological view: `InstrumentTermVersion` rows (every terms change, including the
 * original grant) and `Correction` rows (every ASC 250 error correction). Neither
 * `ScheduleEntry` nor `JournalEntry` appear here directly — their own
 * supersededByCorrectionId/createdByCorrectionId pointers already ARE their audit
 * trail (see the schema's doc comments), and a reviewer wanting the restated numbers
 * themselves should go to the journal-entries report, not this one. This module
 * answers a narrower, complementary question: across an entity, WHAT changed and WHEN
 * — a timeline, not a recomputation.
 *
 * HONEST LIMITATION, stated plainly rather than glossed over: neither
 * InstrumentTermVersion nor Correction records WHO made the change — there was no
 * `createdByUserId` column on either table before this version. As of v0.19.0 both
 * models carry an optional `createdByUserId` (nullable, since every row created before
 * this migration has no such value and can never retroactively get one) — see the
 * schema's own comment on that column. This module's `AuditTrailEntry.userEmail` is
 * `undefined` for any such pre-migration row, and this function does NOT guess or
 * backfill a value; a caller building this report from real data should render that as
 * an honest "unknown" in the UI, not blank it out or attribute it to whoever's viewing.
 */

export type AuditTrailEntryKind = "TERM_VERSION" | "CORRECTION";

export interface TermVersionAuditInput {
  kind: "TERM_VERSION";
  instrumentId: string;
  instrumentType: string;
  stakeholderName: string;
  effectiveDate: ISODate;
  label: string;
  createdAt: ISODate;
  createdByUserEmail?: string;
  /** True for the very first term version an instrument ever got (its origination) —
   * lets the UI distinguish "instrument created" from "instrument amended" without
   * re-deriving it by comparing against every other row for the same instrument. */
  isOriginal: boolean;
}

export interface CorrectionAuditInput {
  kind: "CORRECTION";
  instrumentId: string;
  instrumentType: string;
  stakeholderName: string;
  correctionId: string;
  discoveredDate: ISODate;
  reason: string;
  election: "PROSPECTIVE" | "RETROSPECTIVE";
  createdAt: ISODate;
  createdByUserEmail?: string;
  /** The dollar magnitude of the correction, as already computed and stored in
   * `Correction.previewSnapshot.cumulativeDelta` at commit time — passed through
   * as a plain string (already-formatted `toFixed(2)` output) rather than re-parsed
   * into a Decimal here, since this module only arranges and labels data other engines
   * already computed and validated; see the file-level note on scope. */
  cumulativeDelta: string;
}

export type AuditTrailInput = TermVersionAuditInput | CorrectionAuditInput;

export interface AuditTrailEntry {
  kind: AuditTrailEntryKind;
  instrumentId: string;
  instrumentType: string;
  stakeholderName: string;
  /** The date the entry is sorted and displayed by — `effectiveDate` for a term
   * version (when its terms took effect), `discoveredDate` for a correction (when the
   * error was found — NOT when it was booked, which is the separate `createdAt`). */
  date: ISODate;
  createdAt: ISODate;
  userEmail?: string;
  summary: string;
}

/** Merges term-version and correction rows into one chronological timeline, sorted by
 * `date` ascending (ties broken by `createdAt`, so same-day entries still come out in
 * the order they were actually recorded). Each input row is turned into one
 * human-readable `summary` line — the whole point of this function over just handing a
 * caller two raw arrays is producing one feed a compliance reviewer can read straight
 * down without cross-referencing two tables themselves. */
export function buildAuditTrail(inputs: AuditTrailInput[]): AuditTrailEntry[] {
  const entries: AuditTrailEntry[] = inputs.map((input) => {
    if (input.kind === "TERM_VERSION") {
      return {
        kind: "TERM_VERSION",
        instrumentId: input.instrumentId,
        instrumentType: input.instrumentType,
        stakeholderName: input.stakeholderName,
        date: input.effectiveDate,
        createdAt: input.createdAt,
        userEmail: input.createdByUserEmail,
        summary: input.isOriginal
          ? `${input.instrumentType} issued to ${input.stakeholderName} (terms: "${input.label}")`
          : `${input.instrumentType} for ${input.stakeholderName} amended, effective ${input.effectiveDate} (terms: "${input.label}")`,
      };
    }
    return {
      kind: "CORRECTION",
      instrumentId: input.instrumentId,
      instrumentType: input.instrumentType,
      stakeholderName: input.stakeholderName,
      date: input.discoveredDate,
      createdAt: input.createdAt,
      userEmail: input.createdByUserEmail,
      summary: `${input.election === "RETROSPECTIVE" ? "Retrospective" : "Prospective"} correction booked for ${input.instrumentType} (${
        input.stakeholderName
      }) — ${input.reason} (cumulative delta ${input.cumulativeDelta})`,
    };
  });

  return entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return 0;
  });
}

/** Coverage summary for the "who did what" gap described above — how much of a given
 * audit trail actually has user attribution, so a reviewer relying on this report
 * knows immediately whether it's complete or partial, rather than discovering
 * `undefined` cells one row at a time. */
export interface AttributionCoverage {
  totalEntries: number;
  entriesWithKnownUser: number;
  /** 0 when totalEntries is 0 — an empty trail is trivially "fully covered," not a
   * divide-by-zero. */
  coveragePercent: number;
}

export function summarizeAttributionCoverage(entries: AuditTrailEntry[]): AttributionCoverage {
  const totalEntries = entries.length;
  const entriesWithKnownUser = entries.filter((e) => e.userEmail !== undefined).length;
  const coveragePercent = totalEntries === 0 ? 0 : (entriesWithKnownUser / totalEntries) * 100;
  return { totalEntries, entriesWithKnownUser, coveragePercent };
}
