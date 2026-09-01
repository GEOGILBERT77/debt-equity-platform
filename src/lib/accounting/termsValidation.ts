import { Decimal, ISODate } from "./types.js";
import { InstrumentTypeForDispatch } from "./dispatch.js";

/**
 * Runtime shape validation for the `terms` JSON payload every instrument carries —
 * closing the gap dispatch.ts's "NO RUNTIME SHAPE VALIDATION" note has flagged since
 * REVOLVER/PIK_NOTE/CONVERTIBLE_NOTE/WARRANT were first wired into the dispatcher: a
 * malformed payload should fail here, at the API boundary, with a clear list of exactly
 * what's wrong — not deep inside an engine function as a cryptic `undefined is not a
 * function` or (worse) as a silently-wrong computed number.
 *
 * WHY THIS ISN'T ZOD: it should be. Zod (or a similar schema library) is the standard,
 * battle-tested choice for exactly this problem, and it's already listed as a
 * `package.json` dependency here for that reason. But — same story as `decimal.ts` —
 * this sandbox has no outbound access to the npm registry, so `zod` could never
 * actually be installed and exercised here. This file is a minimal, dependency-free
 * stand-in with the same job: given `(type, terms)`, either say nothing (valid) or
 * collect every problem found and throw once with all of them listed together, rather
 * than fail-fast on the first field and make the caller fix issues one at a time.
 *
 * ONCE YOU CAN RUN `npm install`: replace the validators below with real Zod schemas
 * (one per instrument type, mirroring the interfaces in vesting.ts/debtAmortization.ts/
 * convertibleNote.ts/dispatch.ts) and call `.parse()` at the same call sites listed in
 * this file's `validateInstrumentTerms` doc comment. The error-collection shape
 * (`TermsValidationError.issues`, `{ path, message }`) was deliberately kept close to
 * Zod's own `ZodError.issues` shape so that swap is mostly mechanical.
 */

export interface ValidationIssue {
  /** Dot/bracket path to the offending field, e.g. `tranches[1].vestDate`, or `""` for
   * a top-level problem (terms isn't an object at all). */
  path: string;
  message: string;
}

export class TermsValidationError extends Error {
  issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(
      `Invalid instrument terms (${issues.length} issue${issues.length === 1 ? "" : "s"}): ` +
        issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")
    );
    this.name = "TermsValidationError";
    this.issues = issues;
  }
}

// ---- Small dependency-free primitive checks -------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** YYYY-MM-DD, and an actual calendar date (rejects 2025-02-30) — not just a
 * regex-shaped string. */
function isISODate(v: unknown): v is ISODate {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A DecimalValue is only ever `number | string` coming out of parsed JSON (a
 * FixedDecimal instance can't survive a JSON round-trip) — reuses the engine's own
 * BigInt-based parser (via `new Decimal(v)`) rather than re-implementing a numeric
 * regex that could drift from what the engine actually accepts. */
function isDecimalValue(v: unknown): boolean {
  if (typeof v !== "number" && typeof v !== "string") return false;
  try {
    new Decimal(v as number | string);
    return true;
  } catch {
    return false;
  }
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

/** Accumulates issues under a path prefix — every per-type validator below builds one
 * of these and hands back `.issues` rather than throwing partway through, so a caller
 * sees every problem in the payload at once. */
class IssueCollector {
  issues: ValidationIssue[] = [];
  private prefix: string;
  constructor(prefix = "") {
    this.prefix = prefix;
  }
  private path(field: string): string {
    return this.prefix ? `${this.prefix}.${field}` : field;
  }
  add(field: string, message: string): void {
    this.issues.push({ path: this.path(field), message });
  }
  /** A sub-collector for one array element or nested object, so its issues report the
   * full path (e.g. `tranches[1].vestDate`) back to this collector. */
  child(field: string): IssueCollector {
    const c = new IssueCollector(this.path(field));
    return c;
  }
  merge(other: IssueCollector): void {
    this.issues.push(...other.issues);
  }
  requireString(obj: Record<string, unknown>, field: string): void {
    if (!isNonEmptyString(obj[field])) this.add(field, "is required and must be a non-empty string");
  }
  requireISODate(obj: Record<string, unknown>, field: string): void {
    if (!isISODate(obj[field])) this.add(field, "is required and must be a valid ISO date (YYYY-MM-DD)");
  }
  requireDecimal(obj: Record<string, unknown>, field: string): void {
    if (!isDecimalValue(obj[field])) this.add(field, "is required and must be a number or numeric string");
  }
  optionalDecimal(obj: Record<string, unknown>, field: string): void {
    if (obj[field] !== undefined && obj[field] !== null && !isDecimalValue(obj[field])) {
      this.add(field, "must be a number or numeric string when provided");
    }
  }
  requireBoolean(obj: Record<string, unknown>, field: string): void {
    if (!isBoolean(obj[field])) this.add(field, "is required and must be a boolean");
  }
}

/**
 * Checks that a list of ISO dates is strictly increasing — for arrays like
 * `cashFlows`/`observations` that the engines below (buildEffectiveInterestSchedule,
 * buildFairValueRemeasurementSchedule, buildCashSettledSarSchedule) consume strictly
 * POSITIONALLY, one entry per period, in period order (periods themselves are always
 * chronological). An out-of-order or duplicate date here is a real data-entry mistake
 * — two rows transposed, a copy-pasted row that didn't get its date updated — and
 * unlike the tranche-quantity-sum check above, it won't necessarily error out loudly at
 * compute time: `buildEffectiveInterestSchedule` never even looks at `cashFlows[i].date`
 * (it only uses `.amount`, matched to `periods[i]` by index), so a transposed pair of
 * cash flow dates would silently tie the wrong payment amount to the wrong period,
 * with no error at all. (`buildFairValueRemeasurementSchedule`/
 * `buildCashSettledSarSchedule` DO check `obs.date` against each period's own end and
 * throw on a mismatch, but only once a real periods array exists at compute time — this
 * check catches the same mistake immediately, at write time, before that.) Reports only
 * the first break found — further entries typically cascade from the same root cause,
 * and one clear message beats a wall of repeated ones.
 */
function checkChronological(c: IssueCollector, field: string, dates: ISODate[]): void {
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] <= dates[i - 1]) {
      c.add(
        field,
        `entries must be in strictly increasing chronological order — entry ${i} (${dates[i]}) is not after entry ${i - 1} (${dates[i - 1]}); these are matched positionally to periods at compute time, never resorted`
      );
      return;
    }
  }
}

/** Checks that `date` is strictly after `afterDate` — used for "the first observation
 * must come after inception" / "the first cash flow must come after grant" style
 * checks that `checkChronological` alone doesn't cover (it only compares entries to
 * each other, not to a fixed reference point before the array starts). */
function checkAfter(c: IssueCollector, field: string, date: ISODate, afterDate: ISODate, afterFieldName: string): void {
  if (date <= afterDate) {
    c.add(field, `must be after ${afterFieldName} (${afterDate})`);
  }
}

// ---- Per-type validators ----------------------------------------------------------
// Each mirrors the corresponding engine input interface exactly — see the file named
// in the comment above each one. Keeping them 1:1 with those interfaces (rather than,
// say, one shared "reasonable-looking terms object" check) is what makes a validation
// failure here a reliable predictor of an engine failure, not an approximation of one.

/** vesting.ts's ServiceConditionGrant — used by STOCK_OPTION and RSU. */
function validateServiceConditionGrant(terms: Record<string, unknown>, c: IssueCollector): void {
  c.requireISODate(terms, "grantDate");
  c.requireDecimal(terms, "quantity");
  c.requireDecimal(terms, "grantDateFairValuePerUnit");

  if (terms.attributionMethod !== "straight-line" && terms.attributionMethod !== "graded") {
    c.add("attributionMethod", 'is required and must be "straight-line" or "graded"');
  }

  if (!Array.isArray(terms.tranches) || terms.tranches.length === 0) {
    c.add("tranches", "is required and must be a non-empty array");
    return;
  }

  let allTranchesWellFormed = true;
  terms.tranches.forEach((tranche, i) => {
    const tc = c.child(`tranches[${i}]`);
    if (!isPlainObject(tranche)) {
      tc.add("", "must be an object with id, vestDate, and quantity");
      allTranchesWellFormed = false;
    } else {
      tc.requireString(tranche, "id");
      tc.requireISODate(tranche, "vestDate");
      tc.requireDecimal(tranche, "quantity");
      if (tc.issues.length > 0) allTranchesWellFormed = false;
      // A vestDate on or before the grant date isn't a shape problem, but it can never
      // be right (you can't vest before you've been granted anything) — worth catching
      // here rather than only in a much less obvious downstream computation.
      if (isISODate(terms.grantDate) && isISODate(tranche.vestDate) && tranche.vestDate <= terms.grantDate) {
        tc.add("vestDate", "must be after grantDate");
      }
    }
    c.merge(tc);
  });

  // A grant whose tranches don't add up to its total quantity is the single most
  // common real data-entry mistake in a hand-typed grant — catching it here, with the
  // exact expected-vs-actual numbers, beats it silently producing a fully-diluted
  // share count (via capTable.ts, which reads `quantity` directly) that doesn't match
  // what the schedule engine actually vests tranche by tranche.
  if (allTranchesWellFormed && isDecimalValue(terms.quantity)) {
    const trancheTotal = (terms.tranches as { quantity: unknown }[]).reduce(
      (sum, t) => sum.plus(t.quantity as string | number),
      new Decimal(0)
    );
    const grantQuantity = new Decimal(terms.quantity as string | number);
    if (!trancheTotal.equals(grantQuantity)) {
      c.add(
        "tranches",
        `quantities sum to ${trancheTotal.toString()}, which doesn't match the grant's total quantity of ${grantQuantity.toString()}`
      );
    }
  }
}

/** debtAmortization.ts's TermDebtInputs — used by TERM_LOAN, and as the base shape for
 * CONVERTIBLE_NOTE (ConventionalConvertibleNoteInputs extends it). */
function validateTermDebtInputs(terms: Record<string, unknown>, c: IssueCollector): void {
  c.requireDecimal(terms, "faceValue");
  c.requireDecimal(terms, "netProceeds");
  c.requireDecimal(terms, "effectiveAnnualYield");

  if (!Array.isArray(terms.cashFlows) || terms.cashFlows.length === 0) {
    c.add("cashFlows", "is required and must be a non-empty array of { date, amount }");
  } else {
    let allWellFormed = true;
    terms.cashFlows.forEach((cf, i) => {
      const cc = c.child(`cashFlows[${i}]`);
      if (!isPlainObject(cf)) {
        cc.add("", "must be an object with date and amount");
        allWellFormed = false;
      } else {
        cc.requireISODate(cf, "date");
        cc.requireDecimal(cf, "amount");
        if (cc.issues.length > 0) allWellFormed = false;
      }
      c.merge(cc);
    });
    if (allWellFormed) {
      checkChronological(c, "cashFlows", (terms.cashFlows as { date: ISODate }[]).map((cf) => cf.date));
    }
  }
}

/** convertibleNote.ts's ConventionalConvertibleNoteInputs — TermDebtInputs plus a
 * conversion price. */
function validateConvertibleNoteInputs(terms: Record<string, unknown>, c: IssueCollector): void {
  validateTermDebtInputs(terms, c);
  c.requireDecimal(terms, "conversionPricePerShare");
}

/** debtAmortization.ts's PikDebtInputs — used by PIK_NOTE. */
function validatePikDebtInputs(terms: Record<string, unknown>, c: IssueCollector): void {
  c.requireDecimal(terms, "initialPrincipal");
  c.requireDecimal(terms, "annualPikRate");
}

/** debtAmortization.ts's RevolverInputs — used by REVOLVER. At least one of
 * commitmentFee/deferredFees must be present, mirroring buildRevolverSchedule's own
 * runtime check (see debtAmortization.ts) so this fails with the same clear message
 * before the engine would, rather than a different one after. */
function validateRevolverInputs(terms: Record<string, unknown>, c: IssueCollector): void {
  const hasCommitmentFee = terms.commitmentFee !== undefined && terms.commitmentFee !== null;
  const hasDeferredFees = terms.deferredFees !== undefined && terms.deferredFees !== null;

  if (!hasCommitmentFee && !hasDeferredFees) {
    c.add("", "must include a commitmentFee, a deferredFees array, or both");
  }

  if (hasCommitmentFee) {
    const fc = c.child("commitmentFee");
    const commitmentFee = terms.commitmentFee;
    if (!isPlainObject(commitmentFee)) {
      fc.add("", "must be an object with totalCommitmentFee, commitmentStart, and commitmentEnd");
    } else {
      fc.requireDecimal(commitmentFee, "totalCommitmentFee");
      fc.requireISODate(commitmentFee, "commitmentStart");
      fc.requireISODate(commitmentFee, "commitmentEnd");
      // A start-on-or-after-end window isn't a shape problem, but allocateStraightLine
      // ByElapsedTime (allocation.ts) throws "serviceEnd must be after serviceStart"
      // for it — catching it here gives a clearer, field-specific message instead.
      if (
        isISODate(commitmentFee.commitmentStart) &&
        isISODate(commitmentFee.commitmentEnd) &&
        commitmentFee.commitmentEnd <= commitmentFee.commitmentStart
      ) {
        fc.add("commitmentEnd", "must be after commitmentStart");
      }
    }
    c.merge(fc);
  }

  if (hasDeferredFees) {
    const deferredFees = terms.deferredFees;
    if (!Array.isArray(deferredFees) || deferredFees.length === 0) {
      c.add("deferredFees", "must be a non-empty array of { id, amount, amortizationStart, amortizationEnd } when provided");
    } else {
      deferredFees.forEach((fee: unknown, i: number) => {
        const fc = c.child(`deferredFees[${i}]`);
        if (!isPlainObject(fee)) {
          fc.add("", "must be an object with id, amount, amortizationStart, and amortizationEnd");
        } else {
          fc.requireString(fee, "id");
          fc.requireDecimal(fee, "amount");
          fc.requireISODate(fee, "amortizationStart");
          fc.requireISODate(fee, "amortizationEnd");
          if (
            isISODate(fee.amortizationStart) &&
            isISODate(fee.amortizationEnd) &&
            fee.amortizationEnd <= fee.amortizationStart
          ) {
            fc.add("amortizationEnd", "must be after amortizationStart");
          }
        }
        c.merge(fc);
      });
    }
  }
}

/** warrantAllocation.ts's WarrantClassificationInputs, plus dispatch.ts's
 * WarrantInstrumentTerms wrapper — used by WARRANT. `remeasurement` is only checked
 * for presence/shape here (its actual requiredness depends on classifyWarrant's
 * result, which this validator deliberately doesn't run — that's dispatch.ts's job at
 * compute time, not a JSON-shape concern). */
function validateWarrantInstrumentTerms(terms: Record<string, unknown>, c: IssueCollector): void {
  const cc = c.child("classification");
  if (!isPlainObject(terms.classification)) {
    cc.add("", "is required and must be an object with netCashSettlementPossible, indexedToOwnStockOnly, and hasDownRoundProtection");
  } else {
    cc.requireBoolean(terms.classification, "netCashSettlementPossible");
    cc.requireBoolean(terms.classification, "indexedToOwnStockOnly");
    cc.requireBoolean(terms.classification, "hasDownRoundProtection");
  }
  c.merge(cc);

  if (terms.remeasurement !== undefined && terms.remeasurement !== null) {
    const rc = c.child("remeasurement");
    const remeasurement = terms.remeasurement;
    if (!isPlainObject(remeasurement)) {
      rc.add("", "must be an object with inceptionDate, inceptionFairValue, and observations when provided");
    } else {
      rc.requireISODate(remeasurement, "inceptionDate");
      rc.requireDecimal(remeasurement, "inceptionFairValue");
      const observations = remeasurement.observations;
      if (!Array.isArray(observations) || observations.length === 0) {
        rc.add("observations", "is required and must be a non-empty array of { date, fairValue }");
      } else {
        let allWellFormed = true;
        observations.forEach((obs: unknown, i: number) => {
          const oc = rc.child(`observations[${i}]`);
          if (!isPlainObject(obs)) {
            oc.add("", "must be an object with date and fairValue");
            allWellFormed = false;
          } else {
            oc.requireISODate(obs, "date");
            oc.requireDecimal(obs, "fairValue");
            if (oc.issues.length > 0) allWellFormed = false;
          }
          rc.merge(oc);
        });
        // Chronology matters here for the same reason it does for TERM_LOAN's
        // cashFlows — buildFairValueRemeasurementSchedule matches observations[i] to
        // periods[i] strictly positionally, throwing only once a real periods array
        // exists at compute time; this catches a transposed/duplicate date immediately.
        if (allWellFormed) {
          const dates = (observations as { date: ISODate }[]).map((o) => o.date);
          checkChronological(rc, "observations", dates);
          if (isISODate(remeasurement.inceptionDate)) {
            checkAfter(rc, "observations[0].date", dates[0], remeasurement.inceptionDate, "inceptionDate");
          }
        }
      }
    }
    c.merge(rc);
  }

  if (terms.instrumentAccountName !== undefined && !isNonEmptyString(terms.instrumentAccountName)) {
    c.add("instrumentAccountName", "must be a non-empty string when provided");
  }
  c.optionalDecimal(terms, "sharesIssuable");
}

/** capTable.ts's CommonStockTerms — used by COMMON_STOCK. There's no periodic engine
 * for this type (see capTable.ts's doc comment), so this is the entire shape. */
function validateCommonStockTerms(terms: Record<string, unknown>, c: IssueCollector): void {
  c.requireDecimal(terms, "quantity");
}

/** dispatch.ts's SarInstrumentTerms discriminated union — used by SAR. `settlementType`
 * decides which of the two branches gets checked; an invalid/missing value is reported
 * once and neither branch is checked further (there's no sensible "expected shape" to
 * validate against without knowing which one applies). */
function validateSarInstrumentTerms(terms: Record<string, unknown>, c: IssueCollector): void {
  if (terms.settlementType !== "STOCK" && terms.settlementType !== "CASH") {
    c.add("settlementType", 'is required and must be "STOCK" or "CASH"');
    return;
  }

  if (terms.settlementType === "STOCK") {
    if (!isPlainObject(terms.equityTerms)) {
      c.add("equityTerms", "is required and must be an object (a ServiceConditionGrant — same shape as a STOCK_OPTION/RSU grant) when settlementType is \"STOCK\"");
      return;
    }
    const ec = c.child("equityTerms");
    validateServiceConditionGrant(terms.equityTerms, ec);
    c.merge(ec);
    return;
  }

  // settlementType === "CASH"
  if (!isPlainObject(terms.cashTerms)) {
    c.add("cashTerms", 'is required and must be an object when settlementType is "CASH"');
    return;
  }
  const cc = c.child("cashTerms");
  const cashTerms = terms.cashTerms;
  cc.requireISODate(cashTerms, "grantDate");
  cc.requireDecimal(cashTerms, "quantity");
  cc.requireDecimal(cashTerms, "strikePrice");

  if (!Array.isArray(cashTerms.tranches) || cashTerms.tranches.length === 0) {
    cc.add("tranches", "is required and must be a non-empty array");
  } else {
    cashTerms.tranches.forEach((tranche: unknown, i: number) => {
      const tc = cc.child(`tranches[${i}]`);
      if (!isPlainObject(tranche)) {
        tc.add("", "must be an object with id, vestDate, and quantity");
      } else {
        tc.requireString(tranche, "id");
        tc.requireISODate(tranche, "vestDate");
        tc.requireDecimal(tranche, "quantity");
        if (isISODate(cashTerms.grantDate) && isISODate(tranche.vestDate) && tranche.vestDate <= cashTerms.grantDate) {
          tc.add("vestDate", "must be after grantDate");
        }
      }
      cc.merge(tc);
    });
  }

  // observations is validated for shape only here (each entry's `date` must look like
  // an ISO date) — checking that there's exactly one observation per VISIBLE period is
  // a compute-time concern (buildCashSettledSarSchedule's own runtime check), not a
  // write-time shape concern: how many periods are "visible" depends on `through`,
  // which doesn't exist yet when a grant is first recorded.
  if (!Array.isArray(cashTerms.observations)) {
    cc.add("observations", "is required and must be an array of { date, fairValuePerUnit } (may be empty at grant time)");
  } else {
    let allWellFormed = true;
    cashTerms.observations.forEach((obs: unknown, i: number) => {
      const oc = cc.child(`observations[${i}]`);
      if (!isPlainObject(obs)) {
        oc.add("", "must be an object with date and fairValuePerUnit");
        allWellFormed = false;
      } else {
        oc.requireISODate(obs, "date");
        oc.requireDecimal(obs, "fairValuePerUnit");
        if (oc.issues.length > 0) allWellFormed = false;
      }
      cc.merge(oc);
    });
    // Same positional-matching hazard as TERM_LOAN's cashFlows and WARRANT's
    // remeasurement.observations — buildCashSettledSarSchedule matches
    // observations[i] to periods[i] by index, not by searching for a matching date.
    if (allWellFormed && cashTerms.observations.length > 0) {
      const dates = (cashTerms.observations as { date: ISODate }[]).map((o) => o.date);
      checkChronological(cc, "observations", dates);
      if (isISODate(cashTerms.grantDate)) {
        checkAfter(cc, "observations[0].date", dates[0], cashTerms.grantDate, "grantDate");
      }
    }
  }

  c.merge(cc);
}

/** dispatch.ts's PreferredStockInstrumentTerms — used by PREFERRED_STOCK.
 * `classification` (the three ASC 480-10 booleans) is always required; `debtTerms`
 * and `accretion` are validated for shape ONLY IF PRESENT — which of them is actually
 * required depends on running `classifyPreferredStock` (a compute-time concern that
 * belongs to dispatch.ts's engine, per the same reasoning WARRANT's validator gives
 * for not running `classifyWarrant` here) not a write-time shape concern. */
function validatePreferredStockInstrumentTerms(terms: Record<string, unknown>, c: IssueCollector): void {
  const cc = c.child("classification");
  if (!isPlainObject(terms.classification)) {
    cc.add(
      "",
      "is required and must be an object with mandatorilyRedeemable, redeemableAtHolderOption, and redeemableUponContingentEventOutsideCompanyControl"
    );
  } else {
    cc.requireBoolean(terms.classification, "mandatorilyRedeemable");
    cc.requireBoolean(terms.classification, "redeemableAtHolderOption");
    cc.requireBoolean(terms.classification, "redeemableUponContingentEventOutsideCompanyControl");
  }
  c.merge(cc);

  if (terms.debtTerms !== undefined && terms.debtTerms !== null) {
    const dc = c.child("debtTerms");
    if (!isPlainObject(terms.debtTerms)) {
      dc.add("", "must be an object (a TermDebtInputs — same shape as a TERM_LOAN) when provided");
    } else {
      validateTermDebtInputs(terms.debtTerms, dc);
    }
    c.merge(dc);
  }

  if (terms.accretion !== undefined && terms.accretion !== null) {
    const ac = c.child("accretion");
    const accretion = terms.accretion;
    if (!isPlainObject(accretion)) {
      ac.add("", "must be an object with issueDate, quantity, issuePricePerShare, redemptionDate, and redemptionValuePerShare when provided");
    } else {
      ac.requireISODate(accretion, "issueDate");
      ac.requireDecimal(accretion, "quantity");
      ac.requireDecimal(accretion, "issuePricePerShare");
      ac.requireISODate(accretion, "redemptionDate");
      ac.requireDecimal(accretion, "redemptionValuePerShare");
      if (
        isISODate(accretion.issueDate) &&
        isISODate(accretion.redemptionDate) &&
        accretion.redemptionDate <= accretion.issueDate
      ) {
        ac.add("redemptionDate", "must be after issueDate");
      }
    }
    c.merge(ac);
  }

  if (terms.dividends !== undefined && terms.dividends !== null) {
    const vc = c.child("dividends");
    const dividends = terms.dividends;
    if (!isPlainObject(dividends)) {
      vc.add("", "must be an object with issueDate, quantity, issuePricePerShare, and annualDividendRate when provided");
    } else {
      vc.requireISODate(dividends, "issueDate");
      vc.requireDecimal(dividends, "quantity");
      vc.requireDecimal(dividends, "issuePricePerShare");
      vc.requireDecimal(dividends, "annualDividendRate");
    }
    c.merge(vc);
  }
}

/** dispatch.ts's RestrictedStockInstrumentTerms — used by RESTRICTED_STOCK. Exactly a
 * ServiceConditionGrant (grantDate/quantity/grantDateFairValuePerUnit/tranches/
 * attributionMethod — see validateServiceConditionGrant above, including its
 * vestDate-after-grantDate and tranche-quantities-sum-to-total checks, both equally
 * applicable here since RESTRICTED_STOCK's expense half literally IS a
 * ServiceConditionGrant) plus one additional required field: `purchasePricePerShare`,
 * which drives the repurchase-right-lapse reclassification and has no ServiceCondition
 * Grant analog. */
function validateRestrictedStockInstrumentTerms(terms: Record<string, unknown>, c: IssueCollector): void {
  validateServiceConditionGrant(terms, c);
  c.requireDecimal(terms, "purchasePricePerShare");
}

/**
 * Validates a `terms` payload against the shape the given instrument type's engine
 * (and, for COMMON_STOCK, capTable.ts) actually expects, throwing `TermsValidationError`
 * with every problem found if it doesn't match. Call this BEFORE writing `terms` to the
 * database — currently wired into `POST /api/instruments` and
 * `POST /api/instruments/:id/modifications`, the two places a `terms` payload
 * originates from a client. It is deliberately NOT called on every schedule
 * computation (dispatch.ts's `getScheduleBuilder`/`computeVisibleSchedule`) — by the
 * time terms are being read back out of the database for a compute, they already
 * passed this check once at write time, and re-validating on every read would be pure
 * overhead with no new information.
 *
 * SAR and PREFERRED_STOCK are both validated against their real discriminated-union
 * shapes now that dispatch.ts has real engines for them (see
 * validateSarInstrumentTerms / validatePreferredStockInstrumentTerms above).
 */
export function validateInstrumentTerms(type: InstrumentTypeForDispatch, terms: unknown): void {
  const root = new IssueCollector();

  if (!isPlainObject(terms)) {
    root.add("", "terms must be a JSON object");
    throw new TermsValidationError(root.issues);
  }

  switch (type) {
    case "STOCK_OPTION":
    case "RSU":
      validateServiceConditionGrant(terms, root);
      break;
    case "TERM_LOAN":
      validateTermDebtInputs(terms, root);
      break;
    case "CONVERTIBLE_NOTE":
      validateConvertibleNoteInputs(terms, root);
      break;
    case "PIK_NOTE":
      validatePikDebtInputs(terms, root);
      break;
    case "REVOLVER":
      validateRevolverInputs(terms, root);
      break;
    case "WARRANT":
      validateWarrantInstrumentTerms(terms, root);
      break;
    case "COMMON_STOCK":
      validateCommonStockTerms(terms, root);
      break;
    case "SAR":
      validateSarInstrumentTerms(terms, root);
      break;
    case "PREFERRED_STOCK":
      validatePreferredStockInstrumentTerms(terms, root);
      break;
    case "RESTRICTED_STOCK":
      validateRestrictedStockInstrumentTerms(terms, root);
      break;
  }

  if (root.issues.length > 0) {
    throw new TermsValidationError(root.issues);
  }
}
