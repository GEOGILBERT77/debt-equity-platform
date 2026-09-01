import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPreferredStock,
  buildMandatorilyRedeemablePreferredSchedule,
  buildMezzanineAccretionSchedule,
  buildCumulativeDividendAccrualSchedule,
  MezzanineAccretionGrant,
  CumulativeDividendGrant,
} from "../src/lib/accounting/preferredStock.js";
import { preferredStockAccretionEntry, debtInterestExpenseEntry } from "../src/lib/accounting/journalEntries.js";
import { TermDebtInputs } from "../src/lib/accounting/debtAmortization.js";

test("classifyPreferredStock: mandatorily redeemable always wins — liability, regardless of any other feature", () => {
  assert.equal(
    classifyPreferredStock({ mandatorilyRedeemable: true, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: false }),
    "liability"
  );
  // Even if it ALSO happens to be redeemable at holder's option — mandatory redemption is the stronger fact.
  assert.equal(
    classifyPreferredStock({ mandatorilyRedeemable: true, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: true }),
    "liability"
  );
});

test("classifyPreferredStock: redeemable at holder's option, or upon a contingent event outside the company's control, is mezzanine", () => {
  assert.equal(
    classifyPreferredStock({ mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false }),
    "mezzanine"
  );
  assert.equal(
    classifyPreferredStock({ mandatorilyRedeemable: false, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: true }),
    "mezzanine"
  );
});

test("classifyPreferredStock: none of the three redemption facts present is permanent equity", () => {
  assert.equal(
    classifyPreferredStock({ mandatorilyRedeemable: false, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: false }),
    "permanent_equity"
  );
});

/**
 * GOLDEN SCENARIO — mandatorily redeemable (liability-classified) preferred stock:
 * 1,000 shares issued at $100/share ($100,000 net proceeds), mandatorily redeemable
 * at $100,000 face value in exactly one year, with a single $7,000 dividend payment
 * at that same date (a 7% coupon, non-amortizing — same shape as debtAmortization's
 * own effective-interest tests). Since netProceeds ($100,000) equals faceValue
 * ($100,000) here (no discount), the effective annual yield should come out to
 * exactly the stated coupon rate, and the single period's interest expense should
 * exactly equal the $7,000 cash dividend paid, with a zero ending balance after
 * redemption. This is the delegation-to-buildEffectiveInterestSchedule case — no new
 * math is being tested here, just that the wrapper correctly relabels the ASC citation
 * and stamps the "liability" discriminator into meta.
 */
test("buildMandatorilyRedeemablePreferredSchedule: delegates cleanly to the effective-interest debt engine, with the ASC citation and classification relabeled", () => {
  const debtTerms: TermDebtInputs = {
    faceValue: "100000",
    netProceeds: "100000",
    effectiveAnnualYield: "0.07",
    cashFlows: [{ date: "2027-01-01", amount: "7000" }],
  };
  const periods = [{ label: "2026", start: "2026-01-01", end: "2027-01-01" }];
  const schedule = buildMandatorilyRedeemablePreferredSchedule(debtTerms, periods);

  assert.equal(schedule[0].amount.toFixed(2), "7000.00");
  assert.equal(schedule[0].endingBalance!.toFixed(2), "100000.00");
  assert.equal(schedule[0].meta!.classification, "liability");
  assert.match(schedule[0].meta!.ascReference as string, /480-10-25-4/);

  const je = debtInterestExpenseEntry(schedule[0]);
  assert.equal(je.lines.find((l) => l.account === "Interest Expense")!.debit!.toFixed(2), "7000.00");
  assert.equal(je.lines.find((l) => l.account === "Cash")!.credit!.toFixed(2), "7000.00");
});

/**
 * GOLDEN SCENARIO — mezzanine accretion: 10,000 shares issued at $10.00/share
 * ($100,000 carrying value), redeemable in exactly 2 years (2026-01-01 to 2028-01-01,
 * 730 days — neither 2026 nor 2027 is a leap year, so this is an exact day count) at
 * $13.00/share ($130,000 redemption value). Total accretion = $30,000, straight-line
 * over 730 days.
 *
 * Hand check: Year 1 (2026, 365 of 730 days elapsed) = 30,000 * 365/730 = $15,000
 * exactly. Year 2 (2027, the remaining 365 days) absorbs the rest = $15,000. Ending
 * balance after Year 1 = 100,000 + 15,000 = $115,000; after Year 2 = $130,000 exactly,
 * matching the stated redemption value with no rounding gap.
 */
const accretionGrant: MezzanineAccretionGrant = {
  issueDate: "2026-01-01",
  quantity: 10000,
  issuePricePerShare: 10,
  redemptionDate: "2028-01-01",
  redemptionValuePerShare: 13,
};
const twoYearPeriods = [
  { label: "2026", start: "2026-01-01", end: "2027-01-01" },
  { label: "2027", start: "2027-01-01", end: "2028-01-01" },
];

test("buildMezzanineAccretionSchedule: straight-line accretion from issue price to redemption value, ties out exactly with no rounding gap", () => {
  const schedule = buildMezzanineAccretionSchedule(accretionGrant, twoYearPeriods);
  assert.equal(schedule[0].amount.toFixed(2), "15000.00");
  assert.equal(schedule[0].endingBalance!.toFixed(2), "115000.00");
  assert.equal(schedule[1].amount.toFixed(2), "15000.00");
  assert.equal(schedule[1].endingBalance!.toFixed(2), "130000.00"); // exactly the redemption value
  assert.equal(schedule[0].meta!.classification, "mezzanine");
});

test("preferredStockAccretionEntry: debits Retained Earnings (deemed dividend) and credits Preferred Stock (temporary equity)", () => {
  const schedule = buildMezzanineAccretionSchedule(accretionGrant, twoYearPeriods);
  const entry = preferredStockAccretionEntry(schedule[0]);
  assert.equal(entry.lines.find((l) => l.account === "Retained Earnings (accretion — deemed dividend)")!.debit!.toFixed(2), "15000.00");
  assert.equal(entry.lines.find((l) => l.account === "Preferred Stock (temporary equity)")!.credit!.toFixed(2), "15000.00");
});

test("preferredStockAccretionEntry: a redemption value BELOW issue price (negative accretion) flips debit/credit rather than posting a negative line", () => {
  const deAccretionGrant: MezzanineAccretionGrant = { ...accretionGrant, redemptionValuePerShare: 8 }; // below the $10 issue price
  const schedule = buildMezzanineAccretionSchedule(deAccretionGrant, twoYearPeriods);
  assert.ok(schedule[0].amount.isNegative());
  const entry = preferredStockAccretionEntry(schedule[0]);
  assert.equal(entry.lines.find((l) => l.account === "Preferred Stock (temporary equity)")!.debit!.toFixed(2), "10000.00");
  assert.equal(entry.lines.find((l) => l.account === "Retained Earnings (accretion — deemed dividend)")!.credit!.toFixed(2), "10000.00");
});

/**
 * GOLDEN SCENARIO — cumulative dividend accrual (disclosure-only, no journal entry):
 * 10,000 shares at $10.00 issue price, 8% cumulative annual dividend. Full calendar
 * year period (365 days, actual/365 convention): annual dividend = 10,000 * 10.00 *
 * 0.08 = $8,000 exactly, and a full 365-day period should recognize the full $8,000
 * (365/365 = 1.0).
 */
test("buildCumulativeDividendAccrualSchedule: a full annual period accrues the full stated annual dividend, running as a cumulative 'in arrears' balance", () => {
  const grant: CumulativeDividendGrant = {
    issueDate: "2026-01-01",
    quantity: 10000,
    issuePricePerShare: 10,
    annualDividendRate: 0.08,
  };
  const schedule = buildCumulativeDividendAccrualSchedule(grant, [{ label: "2026", start: "2026-01-01", end: "2027-01-01" }]);
  assert.equal(schedule[0].amount.toFixed(2), "8000.00");
  assert.equal(schedule[0].endingBalance!.toFixed(2), "8000.00");
  assert.match(schedule[0].meta!.ascReference as string, /NOT a balance-sheet liability/);
});

test("buildCumulativeDividendAccrualSchedule: accrual runs cumulatively across periods (dividends in arrears keep building until declared)", () => {
  const grant: CumulativeDividendGrant = {
    issueDate: "2026-01-01",
    quantity: 10000,
    issuePricePerShare: 10,
    annualDividendRate: 0.08,
  };
  const schedule = buildCumulativeDividendAccrualSchedule(grant, [
    { label: "2026", start: "2026-01-01", end: "2027-01-01" },
    { label: "2027", start: "2027-01-01", end: "2028-01-01" },
  ]);
  assert.equal(schedule[1].amount.toFixed(2), "8000.00");
  assert.equal(schedule[1].endingBalance!.toFixed(2), "16000.00"); // two years of undeclared cumulative dividends
});
