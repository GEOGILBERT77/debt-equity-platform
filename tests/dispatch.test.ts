import test from "node:test";
import assert from "node:assert/strict";
import {
  getScheduleBuilder,
  journalEntryForRow,
  WarrantInstrumentTerms,
  SarInstrumentTerms,
  PreferredStockInstrumentTerms,
  RestrictedStockInstrumentTerms,
  naturalScheduleEndDate,
  computeVisibleSchedule,
  computeScheduleForInstrument,
  TermVersionRecord,
} from "../src/lib/accounting/dispatch.js";
import { buildAnnualPeriods } from "../src/lib/accounting/dateMath.js";
import { RevolverInputs } from "../src/lib/accounting/debtAmortization.js";
import { ConventionalConvertibleNoteInputs } from "../src/lib/accounting/convertibleNote.js";
import { ServiceConditionGrant } from "../src/lib/accounting/vesting.js";
import { Decimal, ScheduleRow } from "../src/lib/accounting/types.js";

function cumulativeOf(schedule: ScheduleRow[]): Decimal {
  return schedule.reduce((s, r) => s.plus(r.amount), new Decimal(0));
}

const periods = buildAnnualPeriods("2025-01-01", "2027-01-01"); // Year 1, Year 2

/**
 * These tests exercise the dispatch.ts wiring itself — the mapping from an
 * InstrumentType to the right engine and the right journal-entry mapper — rather than
 * re-testing the underlying engine math, which already has its own dedicated test
 * files (debtAmortization.test.ts, convertibleNote tests via debtAmortization's
 * effective-interest suite, fairValueRemeasurement.test.ts). What's being verified
 * here is specifically: does dispatch.ts call the right function with the right cast,
 * and does the resulting row carry what journalEntryForRow needs to book it correctly.
 */

test("dispatch: PIK_NOTE — compounds to principal, books the full accrual to the PIK payable (no cash leg)", () => {
  const builder = getScheduleBuilder("PIK_NOTE");
  const rows = builder({ initialPrincipal: "1000000", annualPikRate: "0.08" }, periods);
  assert.equal(rows.length, 2);
  // Hand check: 1,000,000 * 8% = 80,000 Year 1; carrying rolls to 1,080,000; Year 2
  // accrual = 1,080,000 * 8% = 86,400, ending 1,166,400.
  assert.equal(rows[0].amount.toFixed(2), "80000.00");
  assert.equal(rows[0].endingBalance!.toFixed(2), "1080000.00");
  assert.equal(rows[1].amount.toFixed(2), "86400.00");
  assert.equal(rows[1].endingBalance!.toFixed(2), "1166400.00");

  const je = journalEntryForRow("PIK_NOTE", rows[0]);
  assert.equal(je.lines.length, 2);
  assert.equal(je.lines[0].account, "Interest Expense");
  assert.equal(je.lines[0].debit!.toFixed(2), "80000.00");
  assert.equal(je.lines[1].account, "Notes Payable (PIK accrual)");
  assert.equal(je.lines[1].credit!.toFixed(2), "80000.00");
});

test("dispatch: REVOLVER — sums commitment fee and deferred fee amortization, books each to its own account pair", () => {
  const terms: RevolverInputs = {
    commitmentFee: { totalCommitmentFee: "20000", commitmentStart: "2025-01-01", commitmentEnd: "2027-01-01" },
    deferredFees: [{ id: "closing", amount: "60000", amortizationStart: "2025-01-01", amortizationEnd: "2027-01-01" }],
  };
  const builder = getScheduleBuilder("REVOLVER");
  const rows = builder(terms, periods);
  assert.equal(rows.length, 2);
  // Hand check: 20,000 commitment fee / 2 years = 10,000/yr; 60,000 deferred fee
  // straight-line / 2 years = 30,000/yr; combined = 40,000/yr.
  assert.equal(rows[0].amount.toFixed(2), "40000.00");
  assert.equal(rows[0].endingBalance!.toFixed(2), "30000.00"); // unamortized deferred fee after Year 1
  assert.equal(rows[1].amount.toFixed(2), "40000.00");
  assert.equal(rows[1].endingBalance!.toFixed(2), "0.00");

  const je = journalEntryForRow("REVOLVER", rows[0]);
  const byAccount = Object.fromEntries(je.lines.map((l) => [l.account, l]));
  assert.equal(byAccount["Commitment Fee Expense"].debit!.toFixed(2), "10000.00");
  assert.equal(byAccount["Cash"].credit!.toFixed(2), "10000.00");
  assert.equal(byAccount["Amortization of Deferred Financing Costs"].debit!.toFixed(2), "30000.00");
  assert.equal(byAccount["Deferred Financing Costs (contra-liability)"].credit!.toFixed(2), "30000.00");
  const totalDebit = je.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
  const totalCredit = je.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
  assert.equal(totalDebit, totalCredit);
});

test("dispatch: REVOLVER — throws if neither a commitment fee nor deferred fees are supplied", () => {
  const builder = getScheduleBuilder("REVOLVER");
  assert.throws(() => builder({} as RevolverInputs, periods), /commitmentFee or a deferredFees/);
});

test("dispatch: CONVERTIBLE_NOTE — runs the ordinary effective-interest engine and carries the conversion price through meta", () => {
  const terms: ConventionalConvertibleNoteInputs = {
    faceValue: "1000000",
    netProceeds: "950000",
    effectiveAnnualYield: "0.07",
    cashFlows: [
      { date: "2026-01-01", amount: "50000" },
      { date: "2027-01-01", amount: "50000" },
    ],
    conversionPricePerShare: "5.00",
  };
  const builder = getScheduleBuilder("CONVERTIBLE_NOTE");
  const rows = builder(terms, periods);
  // Hand check: 950,000 * 7% = 66,500 Year 1 interest; cash 50,000; discount
  // amortization (the plug) = 16,500; ending carrying = 950,000 + 66,500 - 50,000 = 966,500.
  assert.equal(rows[0].amount.toFixed(2), "66500.00");
  assert.equal(rows[0].endingBalance!.toFixed(2), "966500.00");
  assert.equal(String(rows[0].meta?.conversionPricePerShare), "5");

  const je = journalEntryForRow("CONVERTIBLE_NOTE", rows[0]);
  const byAccount = Object.fromEntries(je.lines.map((l) => [l.account, l]));
  assert.equal(byAccount["Interest Expense"].debit!.toFixed(2), "66500.00");
  assert.equal(byAccount["Cash"].credit!.toFixed(2), "50000.00");
  assert.equal(byAccount["Discount on Debt (contra-liability)"].credit!.toFixed(2), "16500.00");
});

test("dispatch: WARRANT classified equity — produces no periodic schedule", () => {
  const terms: WarrantInstrumentTerms = {
    classification: { netCashSettlementPossible: false, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
  };
  const builder = getScheduleBuilder("WARRANT");
  const rows = builder(terms, periods);
  assert.equal(rows.length, 0);
});

test("dispatch: WARRANT classified liability — marks to fair value each period using the fair-value-remeasurement engine", () => {
  const terms: WarrantInstrumentTerms = {
    classification: { netCashSettlementPossible: true, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
    remeasurement: {
      inceptionDate: "2025-01-01",
      inceptionFairValue: "100000",
      observations: [
        { date: "2026-01-01", fairValue: "120000" },
        { date: "2027-01-01", fairValue: "90000" },
      ],
    },
    instrumentAccountName: "Warrant Liability",
  };
  const builder = getScheduleBuilder("WARRANT");
  const rows = builder(terms, periods);
  assert.equal(rows.length, 2);
  // Fair value rose 100,000 -> 120,000: a $20,000 loss (liability increased).
  assert.equal(rows[0].amount.toFixed(2), "20000.00");
  // Then fell 120,000 -> 90,000: a $30,000 gain, represented as a negative amount
  // per fairValueRemeasurement.ts's sign convention.
  assert.equal(rows[1].amount.toFixed(2), "-30000.00");

  const je = journalEntryForRow("WARRANT", rows[0]);
  const byAccount = Object.fromEntries(je.lines.map((l) => [l.account, l]));
  assert.equal(byAccount["Change in Fair Value of Liability"].debit!.toFixed(2), "20000.00");
  assert.equal(byAccount["Warrant Liability"].credit!.toFixed(2), "20000.00");
});

test("dispatch: WARRANT classified 'review' (down-round protection) refuses to compute a schedule", () => {
  const terms: WarrantInstrumentTerms = {
    classification: { netCashSettlementPossible: false, indexedToOwnStockOnly: true, hasDownRoundProtection: true },
  };
  const builder = getScheduleBuilder("WARRANT");
  assert.throws(() => builder(terms, periods), /requires human review/);
});

test("dispatch: WARRANT classified liability but missing remeasurement observations gives a clear error, not an engine-internal crash", () => {
  const terms: WarrantInstrumentTerms = {
    classification: { netCashSettlementPossible: true, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
  };
  const builder = getScheduleBuilder("WARRANT");
  assert.throws(() => builder(terms, periods), /no `remeasurement` fair value observations/);
});

test("dispatch: COMMON_STOCK still correctly falls through to the 'not wired up' error (it never needed a periodic engine at all — see capTable.ts; SAR, PREFERRED_STOCK, and RESTRICTED_STOCK are all wired as of this pass — see their dedicated tests below)", () => {
  assert.throws(() => getScheduleBuilder("COMMON_STOCK"), /No schedule engine wired up yet/);
});

test("dispatch: SAR settlementType STOCK routes to the stock-settled (equity) engine, same math as a stock option", () => {
  const terms: SarInstrumentTerms = {
    settlementType: "STOCK",
    equityTerms: {
      grantDate: "2025-01-01",
      quantity: "1000",
      grantDateFairValuePerUnit: "2.50",
      tranches: [{ id: "t1", vestDate: "2026-01-01", quantity: "1000" }],
      attributionMethod: "straight-line",
    },
  };
  const builder = getScheduleBuilder("SAR");
  const onePeriod = [{ label: "2025", start: "2025-01-01", end: "2026-01-01" }];
  const rows = builder(terms, onePeriod);
  assert.equal(rows[0].amount.toFixed(2), "2500.00");
  assert.equal(rows[0].meta!.settlementType, "STOCK");

  const je = journalEntryForRow("SAR", rows[0]);
  assert.equal(je.lines.find((l) => l.account === "Stock Compensation Expense")!.debit!.toFixed(2), "2500.00");
});

test("dispatch: SAR settlementType CASH routes to the cash-settled (liability) engine, and journalEntryForRow correctly branches to the liability mapper via meta.settlementType", () => {
  const terms: SarInstrumentTerms = {
    settlementType: "CASH",
    cashTerms: {
      grantDate: "2025-01-01",
      quantity: "1000",
      strikePrice: "10",
      tranches: [{ id: "t1", vestDate: "2026-01-01", quantity: "1000" }],
      observations: [{ date: "2026-01-01", fairValuePerUnit: "5.00" }],
    },
  };
  const builder = getScheduleBuilder("SAR");
  const onePeriod = [{ label: "2025", start: "2025-01-01", end: "2026-01-01" }];
  const rows = builder(terms, onePeriod);
  assert.equal(rows[0].amount.toFixed(2), "5000.00"); // 1000 * 5.00 * 100% service (single-tranche, single-period)
  assert.equal(rows[0].meta!.settlementType, "CASH");

  const je = journalEntryForRow("SAR", rows[0]);
  assert.equal(je.lines.find((l) => l.account === "SAR Compensation Expense")!.debit!.toFixed(2), "5000.00");
  assert.equal(je.lines.find((l) => l.account === "SAR Liability")!.credit!.toFixed(2), "5000.00");
});

test("naturalScheduleEndDate: SAR returns the latest tranche vest date for STOCK settlement (same truncation hazard as a stock option), but null for CASH settlement (a period-by-period roll-forward, no fixed total to allocate)", () => {
  const stockTerms: SarInstrumentTerms = {
    settlementType: "STOCK",
    equityTerms: {
      grantDate: "2025-01-01",
      quantity: "1000",
      grantDateFairValuePerUnit: "2.50",
      tranches: [
        { id: "t1", vestDate: "2026-01-01", quantity: "500" },
        { id: "t2", vestDate: "2028-06-01", quantity: "500" }, // deliberately the later date
      ],
      attributionMethod: "straight-line",
    },
  };
  assert.equal(naturalScheduleEndDate("SAR", stockTerms), "2028-06-01");

  const cashTerms: SarInstrumentTerms = {
    settlementType: "CASH",
    cashTerms: {
      grantDate: "2025-01-01",
      quantity: "1000",
      strikePrice: "10",
      tranches: [{ id: "t1", vestDate: "2026-01-01", quantity: "1000" }],
      observations: [],
    },
  };
  assert.equal(naturalScheduleEndDate("SAR", cashTerms), null);
});

test("dispatch: PREFERRED_STOCK classified 'liability' (mandatorily redeemable) routes to the debt engine, and journalEntryForRow correctly branches via meta.classification", () => {
  const terms: PreferredStockInstrumentTerms = {
    classification: { mandatorilyRedeemable: true, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: false },
    debtTerms: { faceValue: "100000", netProceeds: "100000", effectiveAnnualYield: "0.07", cashFlows: [{ date: "2027-01-01", amount: "7000" }] },
  };
  const builder = getScheduleBuilder("PREFERRED_STOCK");
  const onePeriod = [{ label: "2026", start: "2026-01-01", end: "2027-01-01" }];
  const rows = builder(terms, onePeriod);
  assert.equal(rows[0].amount.toFixed(2), "7000.00");
  assert.equal(rows[0].meta!.classification, "liability");

  const je = journalEntryForRow("PREFERRED_STOCK", rows[0]);
  assert.equal(je.lines.find((l) => l.account === "Interest Expense")!.debit!.toFixed(2), "7000.00");
});

test("dispatch: PREFERRED_STOCK classified 'liability' but missing debtTerms gives a clear error, not an engine-internal crash", () => {
  const terms: PreferredStockInstrumentTerms = {
    classification: { mandatorilyRedeemable: true, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: false },
  };
  const builder = getScheduleBuilder("PREFERRED_STOCK");
  assert.throws(() => builder(terms, periods), /no `debtTerms`/);
});

test("dispatch: PREFERRED_STOCK classified 'mezzanine' with accretion terms routes to the accretion engine, and journalEntryForRow routes to the accretion mapper by default (anything not explicitly 'liability')", () => {
  const terms: PreferredStockInstrumentTerms = {
    classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false },
    accretion: { issueDate: "2026-01-01", quantity: "10000", issuePricePerShare: "10", redemptionDate: "2027-01-01", redemptionValuePerShare: "13" },
  };
  const builder = getScheduleBuilder("PREFERRED_STOCK");
  const onePeriod = [{ label: "2026", start: "2026-01-01", end: "2027-01-01" }];
  const rows = builder(terms, onePeriod);
  assert.equal(rows[0].amount.toFixed(2), "30000.00"); // full accretion in the single period spanning the whole window
  assert.equal(rows[0].meta!.classification, "mezzanine");

  const je = journalEntryForRow("PREFERRED_STOCK", rows[0]);
  assert.equal(je.lines.find((l) => l.account === "Retained Earnings (accretion — deemed dividend)")!.debit!.toFixed(2), "30000.00");
});

test("dispatch: PREFERRED_STOCK classified 'mezzanine' with no accretion terms, or 'permanent_equity', produces no periodic schedule at all", () => {
  const builder = getScheduleBuilder("PREFERRED_STOCK");
  const onePeriod = [{ label: "2026", start: "2026-01-01", end: "2027-01-01" }];

  const mezzanineNoAccretion: PreferredStockInstrumentTerms = {
    classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false },
  };
  assert.deepEqual(builder(mezzanineNoAccretion, onePeriod), []);

  const permanentEquity: PreferredStockInstrumentTerms = {
    classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: false },
  };
  assert.deepEqual(builder(permanentEquity, onePeriod), []);
});

test("naturalScheduleEndDate: PREFERRED_STOCK returns the accretion redemption date for mezzanine-with-accretion, null for every other classification (liability is a roll-forward, the rest have no schedule at all)", () => {
  const mezzanineWithAccretion: PreferredStockInstrumentTerms = {
    classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false },
    accretion: { issueDate: "2026-01-01", quantity: "10000", issuePricePerShare: "10", redemptionDate: "2031-06-01", redemptionValuePerShare: "13" },
  };
  assert.equal(naturalScheduleEndDate("PREFERRED_STOCK", mezzanineWithAccretion), "2031-06-01");

  const liability: PreferredStockInstrumentTerms = {
    classification: { mandatorilyRedeemable: true, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: false },
  };
  assert.equal(naturalScheduleEndDate("PREFERRED_STOCK", liability), null);
});

/**
 * GOLDEN SCENARIO — RESTRICTED_STOCK (early-exercised options / restricted stock, ASC
 * 718 expense + ASC 718-10-25-9 repurchase-right lapse): 4,000 shares granted
 * 2025-01-01 at a nominal $0.01/share purchase price, $2.00/share grant-date fair value
 * (net of the purchase price), straight-line over two annual tranches: 2,000 vesting
 * 2026-01-01, 2,000 vesting 2027-01-01. Two annual periods, exactly spanning the grant's
 * full 2-year (730-day) service period, so there's no rounding ambiguity.
 *
 * Hand check — compensation expense (buildServiceConditionSchedule, straight-line):
 *   total value = 4000 * 2.00 = $8,000 over grantDate (2025-01-01) to the LAST tranche's
 *   vest date (2027-01-01) = 730 days.
 *   Period 1 (2025, ends 2026-01-01): elapsed = 365/730 = 0.5 exactly. Cumulative =
 *     $8,000 * 0.5 = $4,000. Expense = $4,000 - $0 = $4,000.
 *   Period 2 (2026, ends 2027-01-01): elapsed = 730/730 = 1.0. Cumulative = $8,000.
 *     Expense = $8,000 - $4,000 = $4,000.
 *
 * Hand check — repurchase-right lapse (buildRepurchaseRightLapseSchedule): tranche 1
 * (2,000 sh) vests exactly AT period 1's own end (2026-01-01) — inside period 1's
 * `(start, end]` window — so its $0.01 * 2,000 = $20 purchase price reclassifies in
 * period 1, not period 2. Tranche 2 (2,000 sh) vests at period 2's end, reclassifying
 * its own $20 there. Total reclassified across both periods = $40 = 4,000 * $0.01,
 * exactly the grant's full purchase price — nothing left in the liability once both
 * tranches have vested.
 */
test("dispatch: RESTRICTED_STOCK builds both the compensation-expense and repurchase-right-lapse schedules from one shared tranches array, and stamps the reclass amount into meta for journalEntryForRow", () => {
  const terms: RestrictedStockInstrumentTerms = {
    grantDate: "2025-01-01",
    quantity: "4000",
    grantDateFairValuePerUnit: "2.00",
    purchasePricePerShare: "0.01",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2026-01-01", quantity: "2000" },
      { id: "t2", vestDate: "2027-01-01", quantity: "2000" },
    ],
  };
  const builder = getScheduleBuilder("RESTRICTED_STOCK");
  const rows = builder(terms, periods);
  assert.equal(rows.length, 2);

  assert.equal(rows[0].amount.toFixed(2), "4000.00");
  assert.equal(rows[0].meta!.repurchaseRightLapseAmount, "20");
  assert.equal(rows[0].meta!.cumulativeReclassifiedToEquity, "20");

  assert.equal(rows[1].amount.toFixed(2), "4000.00");
  assert.equal(rows[1].meta!.repurchaseRightLapseAmount, "20");
  assert.equal(rows[1].meta!.cumulativeReclassifiedToEquity, "40");

  const je = journalEntryForRow("RESTRICTED_STOCK", rows[0]);
  assert.equal(je.lines.find((l) => l.account === "Stock Compensation Expense")!.debit!.toFixed(2), "4000.00");
  assert.equal(je.lines.find((l) => l.account === "Additional Paid-In Capital")!.credit!.toFixed(2), "4000.00");
  assert.equal(
    je.lines.find((l) => l.account === "Early Exercise Liability (unvested shares subject to repurchase)")!.debit!.toFixed(2),
    "20.00"
  );
  assert.equal(je.lines.find((l) => l.account === "Common Stock / Additional Paid-In Capital")!.credit!.toFixed(2), "20.00");
});

test("naturalScheduleEndDate: RESTRICTED_STOCK returns the latest tranche vest date, same truncation-safety mechanism as STOCK_OPTION/RSU (the reclass half has no such hazard, but both halves share one periods array)", () => {
  const terms: RestrictedStockInstrumentTerms = {
    grantDate: "2025-01-01",
    quantity: "4000",
    grantDateFairValuePerUnit: "2.00",
    purchasePricePerShare: "0.01",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2026-01-01", quantity: "2000" },
      { id: "t2", vestDate: "2028-06-01", quantity: "2000" }, // deliberately the later date
    ],
  };
  assert.equal(naturalScheduleEndDate("RESTRICTED_STOCK", terms), "2028-06-01");
});

test("computeVisibleSchedule: RESTRICTED_STOCK previewed at an interim cutoff is not overstated on the expense side, and the reclass side correctly shows only what's actually vested so far", () => {
  const versions: TermVersionRecord[] = [
    {
      effectiveDate: "2025-01-01",
      label: "Original grant",
      terms: {
        grantDate: "2025-01-01",
        quantity: "4000",
        grantDateFairValuePerUnit: "2.00",
        purchasePricePerShare: "0.01",
        attributionMethod: "straight-line",
        tranches: [
          { id: "t1", vestDate: "2026-01-01", quantity: "2000" },
          { id: "t2", vestDate: "2027-01-01", quantity: "2000" },
        ],
      },
    },
  ];
  // Previewed exactly at the end of Year 1 (2026-01-01) — should show exactly the Year 1
  // row computed above ($4,000 expense, $20 reclassified), not the whole grant's $8,000/
  // $40 dumped into a truncated final period.
  const viaFix = computeVisibleSchedule("RESTRICTED_STOCK", versions, "2026-01-01");
  assert.equal(viaFix.length, 1);
  assert.equal(viaFix[0].amount.toFixed(2), "4000.00");
  assert.equal(viaFix[0].meta!.repurchaseRightLapseAmount, "20");
});

test("computeVisibleSchedule: mezzanine preferred accretion previewed at an interim cutoff is NOT overstated (same truncation-safety mechanism as STOCK_OPTION/stock-settled SAR)", () => {
  const versions: TermVersionRecord[] = [
    {
      effectiveDate: "2026-01-01",
      label: "Original terms",
      terms: {
        classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false },
        accretion: { issueDate: "2026-01-01", quantity: "10000", issuePricePerShare: "10", redemptionDate: "2028-01-01", redemptionValuePerShare: "13" },
      },
    },
  ];
  // Previewed exactly 1 year (365 days) into the 2-year (730-day) accretion window —
  // should show HALF the total $30,000 accretion ($15,000), not the whole amount
  // dumped into a truncated single period the way the pre-fix pattern would.
  const viaFix = computeVisibleSchedule("PREFERRED_STOCK", versions, "2027-01-01");
  assert.equal(viaFix.length, 1);
  assert.equal(viaFix[0].amount.toFixed(2), "15000.00");
});

test("computeVisibleSchedule: a cash-settled SAR previewed at an interim cutoff is unaffected by the remainder-allocation truncation bug (it's a roll-forward, like WARRANT's liability case)", () => {
  const cashVersions: TermVersionRecord[] = [
    {
      effectiveDate: "2025-01-01",
      label: "Original grant",
      terms: {
        settlementType: "CASH",
        cashTerms: {
          grantDate: "2025-01-01",
          quantity: "1000",
          strikePrice: "10",
          tranches: [{ id: "t1", vestDate: "2027-01-01", quantity: "1000" }],
          // naturalScheduleEndDate is null for a cash-settled SAR, so `through` below
          // (2026-01-01, an exact period boundary) is exactly the periods array's end —
          // there is no truncation to be robust against in the first place, unlike the
          // stock-settled/STOCK_OPTION case. Only ONE observation is needed here for
          // exactly that reason: computeVisibleSchedule never builds a periods array
          // reaching all the way to 2027 when `through` is 2026-01-01 and there's no
          // natural end pulling it further out (contrast with the WARRANT case, which
          // has this same "one observation per visible period" contract).
          observations: [{ date: "2026-01-01", fairValuePerUnit: "3.00" }],
        },
      },
    },
  ];
  const viaFix = computeVisibleSchedule("SAR", cashVersions, "2026-01-01");
  assert.equal(viaFix.length, 1);
  assert.equal(viaFix[0].amount.toFixed(2), "1500.00"); // 1000 * 3.00 * (365/730) — same math as the dedicated SAR engine test
});

/**
 * Tests for the visible-schedule truncation bug and its fix (naturalScheduleEndDate /
 * computeVisibleSchedule) — see the extensive doc comment above those functions in
 * dispatch.ts for the full mechanism. No pre-existing test caught this because every
 * other test in this file (and in vesting/debtAmortization's own test files) hands
 * engines the correct, untruncated periods array directly — the bug only shows up when
 * a caller builds `periods` by truncating at an interim cutoff date, which is exactly
 * what the close route, the correction routes, and the front end's live-preview pages
 * do in practice.
 */

test("naturalScheduleEndDate: STOCK_OPTION/RSU returns the latest tranche vest date", () => {
  const grant: ServiceConditionGrant = {
    grantDate: "2025-01-01",
    quantity: "24000",
    grantDateFairValuePerUnit: "1",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2026-01-01", quantity: "6000" },
      { id: "t2", vestDate: "2029-01-01", quantity: "6000" }, // deliberately out of order
      { id: "t3", vestDate: "2027-01-01", quantity: "6000" },
      { id: "t4", vestDate: "2028-01-01", quantity: "6000" },
    ],
  };
  assert.equal(naturalScheduleEndDate("STOCK_OPTION", grant), "2029-01-01");
  assert.equal(naturalScheduleEndDate("RSU", grant), "2029-01-01");
});

test("naturalScheduleEndDate: REVOLVER returns the later of the commitment fee end and every deferred fee's amortization end", () => {
  const bothPresent: RevolverInputs = {
    commitmentFee: { totalCommitmentFee: "20000", commitmentStart: "2025-01-01", commitmentEnd: "2027-01-01" },
    deferredFees: [{ id: "closing", amount: "60000", amortizationStart: "2025-01-01", amortizationEnd: "2028-06-01" }],
  };
  assert.equal(naturalScheduleEndDate("REVOLVER", bothPresent), "2028-06-01");

  const commitmentFeeOnly: RevolverInputs = {
    commitmentFee: { totalCommitmentFee: "20000", commitmentStart: "2025-01-01", commitmentEnd: "2027-01-01" },
  };
  assert.equal(naturalScheduleEndDate("REVOLVER", commitmentFeeOnly), "2027-01-01");

  assert.equal(naturalScheduleEndDate("REVOLVER", {} as RevolverInputs), null);
});

test("naturalScheduleEndDate: every other type returns null (no special truncation handling needed)", () => {
  for (const type of [
    "TERM_LOAN",
    "PIK_NOTE",
    "CONVERTIBLE_NOTE",
    "WARRANT",
    "SAR",
    "PREFERRED_STOCK",
    "COMMON_STOCK",
  ] as const) {
    assert.equal(naturalScheduleEndDate(type, {}), null);
  }
});

test("computeVisibleSchedule: fixes the severe STOCK_OPTION vesting overstatement caused by truncating periods at an interim cutoff", () => {
  // A 4-year, $24,000 straight-line grant (quantity 24000 * $1/unit — the dollar
  // amount is what matters here, not the share count), previewed 607 days into its
  // 1,461-day (4-year) service period.
  const grant: ServiceConditionGrant = {
    grantDate: "2025-01-01",
    quantity: "24000",
    grantDateFairValuePerUnit: "1",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2026-01-01", quantity: "6000" },
      { id: "t2", vestDate: "2027-01-01", quantity: "6000" },
      { id: "t3", vestDate: "2028-01-01", quantity: "6000" },
      { id: "t4", vestDate: "2029-01-01", quantity: "6000" },
    ],
  };
  const termVersions: TermVersionRecord[] = [{ effectiveDate: "2025-01-01", label: "Original terms", terms: grant }];
  const through = "2026-08-31"; // 607 days after grantDate — 2025 is not a leap year

  // THE BUG, reproduced directly: the old call pattern (used by close/route.ts, the
  // correction routes, and the front end before this fix) truncates `periods` at
  // `through` and hands that straight to computeScheduleForInstrument. Because
  // allocateStraightLineByElapsedTime dumps its whole remainder into the last period
  // of whatever array it's given, the truncated last period wrongly absorbs the
  // entire NOT-YET-EARNED remainder — showing the full $24,000 grant as recognized
  // after barely a year and a half, a ~2.4x overstatement.
  const buggyPeriods = buildAnnualPeriods("2025-01-01", through);
  const buggySchedule = computeScheduleForInstrument("STOCK_OPTION", termVersions, buggyPeriods);
  assert.equal(cumulativeOf(buggySchedule).toFixed(2), "24000.00"); // wrong — the whole grant, not ~42% of it

  // THE FIX: computeVisibleSchedule computes against the grant's true 4-year window
  // (extending periods out to naturalScheduleEndDate, splitting at `through` so the
  // elapsed slice of the current year survives), then filters back down to what's
  // actually elapsed as of `through`.
  const fixedSchedule = computeVisibleSchedule("STOCK_OPTION", termVersions, through);
  assert.equal(fixedSchedule.length, 2); // Year 1, and Year 2's elapsed-to-date slice
  assert.equal(fixedSchedule[0].label, "Year 1");
  assert.equal(fixedSchedule[0].amount.toFixed(4), "5995.8932");
  assert.equal(fixedSchedule[1].label, "Year 2 (elapsed to date)");
  assert.equal(fixedSchedule[1].amount.toFixed(4), "3975.3593");
  // Hand check: 24,000 * 607/1,461 elapsed days = 9,971.25 — independently verified
  // via a plain daysBetween('2025-01-01','2026-08-31') = 607 calculation.
  assert.equal(cumulativeOf(fixedSchedule).toFixed(2), "9971.25");
  // No row in the visible schedule should ever extend past `through`.
  for (const row of fixedSchedule) assert.ok(row.periodEnd <= through);
});

test("computeVisibleSchedule: REVOLVER captures the elapsed-to-date slice instead of dropping it — both the commitment fee AND the deferred fee are now day-weighted (v0.17.0 fix), so the elapsed slice is no longer overstated", () => {
  const terms: RevolverInputs = {
    commitmentFee: { totalCommitmentFee: "20000", commitmentStart: "2025-01-01", commitmentEnd: "2027-01-01" },
    deferredFees: [{ id: "closing", amount: "60000", amortizationStart: "2025-01-01", amortizationEnd: "2027-01-01" }],
  };
  const termVersions: TermVersionRecord[] = [{ effectiveDate: "2025-01-01", label: "Original terms", terms }];
  const through = "2026-08-31";

  const fixedSchedule = computeVisibleSchedule("REVOLVER", termVersions, through);
  assert.equal(fixedSchedule.length, 2); // Year 1, and Year 2's elapsed-to-date slice
  assert.equal(fixedSchedule[0].label, "Year 1");
  // Commitment fee (day-weighted, exactly half of a 2-year window) + deferred fee
  // (day-weighted, 365/730 elapsed) = 10,000.0000 + 30,000.0000.
  assert.equal(fixedSchedule[0].amount.toFixed(4), "40000.0000");
  assert.equal(fixedSchedule[1].label, "Year 2 (elapsed to date)");
  // Commitment fee's day-weighted slice for 2026-01-01 through 2026-08-31 (242 more
  // days, 607/730 total elapsed): 20,000 * 607/730 - 20,000 * 365/730 = 16,630.1370 -
  // 10,000.0000 = 6,630.1370. Deferred fee's slice is unchanged from before this fix
  // (it was already day-weighted): 49,890.4110 - 30,000.0000 = 19,890.4110. Total =
  // 6,630.1370 + 19,890.4110 = 26,520.5480 — no longer overstated the way the old
  // equal-by-count commitment-fee math made it (this used to be 26,557.0776).
  assert.equal(fixedSchedule[1].amount.toFixed(4), "26520.5479");
  for (const row of fixedSchedule) assert.ok(row.periodEnd <= through);
});

test("computeVisibleSchedule: extraSplitBoundaries keeps a repeat close from double-booking the overlap with the previous close", () => {
  // Same 4-year, $24,000 straight-line grant as the main fix test above.
  const grant: ServiceConditionGrant = {
    grantDate: "2025-01-01",
    quantity: "24000",
    grantDateFairValuePerUnit: "1",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2026-01-01", quantity: "6000" },
      { id: "t2", vestDate: "2027-01-01", quantity: "6000" },
      { id: "t3", vestDate: "2028-01-01", quantity: "6000" },
      { id: "t4", vestDate: "2029-01-01", quantity: "6000" },
    ],
  };
  const termVersions: TermVersionRecord[] = [{ effectiveDate: "2025-01-01", label: "Original terms", terms: grant }];

  // First close: through 2026-08-31 (607 elapsed days) — same as the fix test above,
  // cumulative 9,971.2525...
  const firstClose = computeVisibleSchedule("STOCK_OPTION", termVersions, "2026-08-31");
  const firstCloseCumulative = cumulativeOf(firstClose);
  assert.equal(firstCloseCumulative.toFixed(2), "9971.25");

  // Second close, later the same (still-open) year: through 2026-11-15, WITHOUT telling
  // it about the first close's cutoff. This reproduces the bug this test guards
  // against: splitting only at the new `through` loses the old boundary, so the
  // "current year" period now spans the whole of 2026-01-01 through 2026-11-15 —
  // which determineNewPeriods (periodEnd > cutoff only, no periodStart check) would
  // treat as entirely new, even though most of it (through 2026-08-31) was already
  // booked in the first close.
  const secondCloseWithoutBoundary = computeVisibleSchedule("STOCK_OPTION", termVersions, "2026-11-15");
  const newSinceFirstClose_withoutBoundary = secondCloseWithoutBoundary.filter((r) => r.periodEnd > "2026-08-31");
  // This "new" slice's amount is the WHOLE 2026-01-01..2026-11-15 period, not just the
  // 2026-08-31..2026-11-15 incremental slice — demonstrating the overlap bug.
  assert.equal(newSinceFirstClose_withoutBoundary.length, 1);
  assert.notEqual(newSinceFirstClose_withoutBoundary[0].periodStart, "2026-08-31");
  assert.equal(newSinceFirstClose_withoutBoundary[0].periodStart, "2026-01-01");

  // Now the fix: pass the first close's cutoff as an extra split boundary, exactly as
  // close/route.ts does with `alreadyClosedThroughPeriodEnd`.
  const secondCloseWithBoundary = computeVisibleSchedule("STOCK_OPTION", termVersions, "2026-11-15", ["2026-08-31"]);
  const newSinceFirstClose = secondCloseWithBoundary.filter((r) => r.periodEnd > "2026-08-31");
  assert.equal(newSinceFirstClose.length, 1);
  // The incremental slice now starts exactly where the first close left off.
  assert.equal(newSinceFirstClose[0].periodStart, "2026-08-31");
  assert.equal(newSinceFirstClose[0].periodEnd, "2026-11-15");

  // And the two closes' cumulative totals tie out correctly to the full elapsed amount
  // as of 2026-11-15 (whereas summing the without-boundary version would double-count
  // the 2026-01-01..2026-08-31 overlap).
  const totalThroughNov15 = firstCloseCumulative.plus(cumulativeOf(newSinceFirstClose));
  assert.equal(totalThroughNov15.toFixed(2), cumulativeOf(secondCloseWithBoundary).toFixed(2));
});

test("computeVisibleSchedule: TERM_LOAN/PIK_NOTE/CONVERTIBLE_NOTE/WARRANT are unaffected by the fix (period-by-period roll-forwards, not remainder-allocation)", () => {
  const pikTerms = { initialPrincipal: "1000000", annualPikRate: "0.08" };
  const pikVersions: TermVersionRecord[] = [{ effectiveDate: "2025-01-01", label: "Original terms", terms: pikTerms }];
  const through = "2027-01-01"; // an exact period boundary — no split needed

  // naturalScheduleEndDate is null for these types, so computeVisibleSchedule's
  // periodsEnd collapses to `through` itself — identical to the pre-fix call pattern.
  assert.equal(naturalScheduleEndDate("PIK_NOTE", pikTerms), null);

  const viaOldPattern = computeScheduleForInstrument("PIK_NOTE", pikVersions, buildAnnualPeriods("2025-01-01", through));
  const viaFix = computeVisibleSchedule("PIK_NOTE", pikVersions, through);
  assert.equal(viaFix.length, viaOldPattern.length);
  viaFix.forEach((row, i) => {
    assert.equal(row.amount.toFixed(4), viaOldPattern[i].amount.toFixed(4));
    assert.equal(row.endingBalance!.toFixed(4), viaOldPattern[i].endingBalance!.toFixed(4));
  });
});
