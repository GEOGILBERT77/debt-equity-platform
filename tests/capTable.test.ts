import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyInstrumentForCapTable,
  buildCapTableRollup,
  aggregateByStakeholder,
  CapTableInstrumentInput,
} from "../src/lib/accounting/capTable.js";

/**
 * GOLDEN SCENARIO, hand-computed:
 *   - Jane (EMPLOYEE): a 12,000-share stock option grant.
 *   - Founders (COMMON_STOCK): 88,000 shares.
 *   - An investor holds a WARRANT for 5,000 shares (liability-classified — shouldn't
 *     matter to the share count either way).
 *   - Total fully diluted shares = 12,000 + 88,000 + 5,000 = 105,000.
 *   - Jane's ownership = 12,000 / 105,000 = 11.428571...%
 *   - Founders' ownership = 88,000 / 105,000 = 83.809523...%
 *   - Warrant holder's ownership = 5,000 / 105,000 = 4.761904...%
 *   - A lender holds a TERM_LOAN with a $400,000 outstanding balance — debt, no shares,
 *     doesn't participate in the ownership % denominator at all.
 */
const goldenInstruments: CapTableInstrumentInput[] = [
  {
    instrumentId: "opt1",
    stakeholderId: "jane",
    stakeholderName: "Jane Doe",
    type: "STOCK_OPTION",
    terms: { grantDate: "2025-01-01", quantity: 12000, grantDateFairValuePerUnit: 2, attributionMethod: "straight-line", tranches: [] },
  },
  {
    instrumentId: "common1",
    stakeholderId: "founders",
    stakeholderName: "Founders Holdco",
    type: "COMMON_STOCK",
    terms: { quantity: 88000 },
  },
  {
    instrumentId: "warrant1",
    stakeholderId: "investor",
    stakeholderName: "Blue Sky Capital",
    type: "WARRANT",
    terms: {
      classification: { netCashSettlementPossible: true, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
      sharesIssuable: 5000,
    },
  },
  {
    instrumentId: "loan1",
    stakeholderId: "lender",
    stakeholderName: "Northgate Capital",
    type: "TERM_LOAN",
    terms: { faceValue: "500000", netProceeds: "490000", effectiveAnnualYield: "0.06", cashFlows: [] },
    outstandingBalance: "400000",
  },
];

test("classifyInstrumentForCapTable: STOCK_OPTION/RSU/COMMON_STOCK read their quantity field directly as fully-diluted shares", () => {
  const c1 = classifyInstrumentForCapTable("STOCK_OPTION", { quantity: 12000 });
  assert.equal(c1.kind, "equity");
  assert.equal((c1 as any).shares.toString(), "12000");

  const c2 = classifyInstrumentForCapTable("COMMON_STOCK", { quantity: 88000 });
  assert.equal(c2.kind, "equity");
  assert.equal((c2 as any).shares.toString(), "88000");
});

test("classifyInstrumentForCapTable: RESTRICTED_STOCK counts its full grant quantity as fully-diluted shares regardless of vesting/repurchase-right status", () => {
  const c = classifyInstrumentForCapTable("RESTRICTED_STOCK", {
    grantDate: "2026-01-01",
    quantity: 4000,
    grantDateFairValuePerUnit: 2.0,
    purchasePricePerShare: 0.01,
    attributionMethod: "straight-line",
    tranches: [{ id: "t1", vestDate: "2027-01-01", quantity: 4000 }],
  });
  assert.equal(c.kind, "equity");
  assert.equal((c as any).shares.toString(), "4000");
});

test("classifyInstrumentForCapTable: RESTRICTED_STOCK with no quantity field is flagged unsupported, not silently zero", () => {
  assert.equal(classifyInstrumentForCapTable("RESTRICTED_STOCK", {}).kind, "unsupported");
});

test("classifyInstrumentForCapTable: WARRANT counts sharesIssuable regardless of equity/liability classification", () => {
  const liability = classifyInstrumentForCapTable("WARRANT", {
    classification: { netCashSettlementPossible: true, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
    sharesIssuable: 5000,
  });
  const equity = classifyInstrumentForCapTable("WARRANT", {
    classification: { netCashSettlementPossible: false, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
    sharesIssuable: 5000,
  });
  assert.equal(liability.kind, "equity");
  assert.equal((liability as any).shares.toString(), "5000");
  assert.equal(equity.kind, "equity");
  assert.equal((equity as any).shares.toString(), "5000");
});

test("classifyInstrumentForCapTable: WARRANT missing sharesIssuable is unsupported, not silently zero", () => {
  const c = classifyInstrumentForCapTable("WARRANT", {
    classification: { netCashSettlementPossible: false, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
  });
  assert.equal(c.kind, "unsupported");
});

test("classifyInstrumentForCapTable: CONVERTIBLE_NOTE computes as-converted shares from face value / conversion price", () => {
  const c = classifyInstrumentForCapTable("CONVERTIBLE_NOTE", {
    faceValue: "1000000",
    netProceeds: "950000",
    effectiveAnnualYield: "0.07",
    cashFlows: [],
    conversionPricePerShare: "5.00",
  });
  assert.equal(c.kind, "equity");
  // 1,000,000 / 5.00 = 200,000 as-converted shares.
  assert.equal((c as any).shares.toString(), "200000");
});

test("classifyInstrumentForCapTable: TERM_LOAN/REVOLVER/PIK_NOTE are debt — no share count, just a balance", () => {
  const c = classifyInstrumentForCapTable("TERM_LOAN", {}, "400000");
  assert.equal(c.kind, "debt");
  assert.equal((c as any).outstandingBalance.toString(), "400000");
});

test("classifyInstrumentForCapTable: PREFERRED_STOCK with no classification info is flagged unsupported, not guessed at", () => {
  assert.equal(classifyInstrumentForCapTable("PREFERRED_STOCK", {}).kind, "unsupported");
});

test("classifyInstrumentForCapTable: LIABILITY-classified (mandatorily redeemable) preferred stock counts as debt, not equity", () => {
  const c = classifyInstrumentForCapTable(
    "PREFERRED_STOCK",
    { classification: { mandatorilyRedeemable: true, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: false } },
    "480000"
  );
  assert.equal(c.kind, "debt");
  assert.equal((c as any).outstandingBalance.toString(), "480000");
});

test("classifyInstrumentForCapTable: MEZZANINE-classified preferred stock with no conversionTerms is flagged unsupported, not silently counted as debt or equity", () => {
  const c = classifyInstrumentForCapTable("PREFERRED_STOCK", {
    classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false },
  });
  assert.equal(c.kind, "unsupported");
  assert.match((c as any).reason, /as-converted share count/);
});

test("classifyInstrumentForCapTable: MEZZANINE-classified preferred WITH conversionTerms computes an as-converted share count (v0.20.0)", () => {
  const c = classifyInstrumentForCapTable("PREFERRED_STOCK", {
    classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false },
    conversionTerms: { quantity: 100_000, conversionRatio: 1 },
  });
  assert.equal(c.kind, "equity");
  assert.equal((c as any).shares.toString(), "100000");
});

test("classifyInstrumentForCapTable: convertible preferred's conversion ratio other than 1:1 (a down-round anti-dilution adjustment) is applied", () => {
  const c = classifyInstrumentForCapTable("PREFERRED_STOCK", {
    classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false },
    conversionTerms: { quantity: 100_000, conversionRatio: "1.25" },
  });
  assert.equal(c.kind, "equity");
  assert.equal((c as any).shares.toString(), "125000");
});

test("classifyInstrumentForCapTable: PERMANENT_EQUITY-classified preferred WITH conversionTerms also computes an as-converted share count", () => {
  const c = classifyInstrumentForCapTable("PREFERRED_STOCK", {
    classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: false },
    conversionTerms: { quantity: 50_000, conversionRatio: 1 },
  });
  assert.equal(c.kind, "equity");
  assert.equal((c as any).shares.toString(), "50000");
});

test("classifyInstrumentForCapTable: conversionTerms present but missing conversionRatio is flagged unsupported, not treated as zero", () => {
  const c = classifyInstrumentForCapTable("PREFERRED_STOCK", {
    classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false },
    conversionTerms: { quantity: 100_000 },
  });
  assert.equal(c.kind, "unsupported");
});

test("classifyInstrumentForCapTable: a malformed/empty SAR terms payload (no settlementType) falls to the CASH branch's unsupported result, same as a genuine cash-settled SAR", () => {
  assert.equal(classifyInstrumentForCapTable("SAR", {}).kind, "unsupported");
});

test("classifyInstrumentForCapTable: a STOCK-settled SAR IS dilutive — counted the same way a stock option's quantity is", () => {
  const c = classifyInstrumentForCapTable("SAR", {
    settlementType: "STOCK",
    equityTerms: { grantDate: "2025-01-01", quantity: "2000", grantDateFairValuePerUnit: "2.50", tranches: [], attributionMethod: "straight-line" },
  });
  assert.equal(c.kind, "equity");
  assert.equal((c as any).shares.toString(), "2000");
});

test("classifyInstrumentForCapTable: a CASH-settled SAR is flagged unsupported — it's a real liability, but it never dilutes and isn't a lender-style debt balance either", () => {
  const c = classifyInstrumentForCapTable("SAR", {
    settlementType: "CASH",
    cashTerms: { grantDate: "2025-01-01", quantity: "1000", strikePrice: "10", tranches: [], observations: [] },
  });
  assert.equal(c.kind, "unsupported");
  assert.match((c as any).reason, /never dilutes/);
});

test("buildCapTableRollup: golden scenario — total fully-diluted shares, ownership percentages, and debt kept separate", () => {
  const rollup = buildCapTableRollup(goldenInstruments);

  assert.equal(rollup.totalFullyDilutedShares.toString(), "105000");
  assert.equal(rollup.equityRows.length, 3);
  assert.equal(rollup.debtRows.length, 1);
  assert.equal(rollup.unsupported.length, 0);

  const janeRow = rollup.equityRows.find((r) => r.stakeholderId === "jane")!;
  const foundersRow = rollup.equityRows.find((r) => r.stakeholderId === "founders")!;
  const warrantRow = rollup.equityRows.find((r) => r.stakeholderId === "investor")!;

  // Hand check: 12,000 / 105,000 * 100 = 11.428571...%
  assert.ok(Math.abs(Number(janeRow.ownershipPercent!.toString()) - 11.428571428571429) < 1e-6);
  // 88,000 / 105,000 * 100 = 83.809523...%
  assert.ok(Math.abs(Number(foundersRow.ownershipPercent!.toString()) - 83.80952380952381) < 1e-6);
  // 5,000 / 105,000 * 100 = 4.761904...%
  assert.ok(Math.abs(Number(warrantRow.ownershipPercent!.toString()) - 4.761904761904762) < 1e-6);

  // The three equity percentages must sum to exactly 100% (they're all drawn from the
  // same total, so this isn't a rounding coincidence — it's the whole point of
  // computing ownership as shares / totalFullyDilutedShares rather than any other way).
  const sum = rollup.equityRows.reduce((s, r) => s + Number(r.ownershipPercent!.toString()), 0);
  assert.ok(Math.abs(sum - 100) < 1e-9);

  const loanRow = rollup.debtRows[0];
  assert.equal(loanRow.outstandingBalance!.toString(), "400000");
  assert.equal(loanRow.ownershipPercent, undefined); // debt never gets an ownership %
});

test("buildCapTableRollup: an unsupported instrument is surfaced, not silently dropped from the totals", () => {
  const withUnsupported: CapTableInstrumentInput[] = [
    ...goldenInstruments,
    { instrumentId: "pref1", stakeholderId: "vc1", stakeholderName: "VC Fund I", type: "PREFERRED_STOCK", terms: {} },
  ];
  const rollup = buildCapTableRollup(withUnsupported);
  assert.equal(rollup.unsupported.length, 1);
  assert.equal(rollup.unsupported[0].stakeholderName, "VC Fund I");
  // The unsupported row must not sneak into the share total.
  assert.equal(rollup.totalFullyDilutedShares.toString(), "105000");
});

test("buildCapTableRollup: zero equity instruments leaves ownershipPercent undefined rather than dividing by zero", () => {
  const debtOnly: CapTableInstrumentInput[] = [
    {
      instrumentId: "loan1",
      stakeholderId: "lender",
      stakeholderName: "Northgate Capital",
      type: "TERM_LOAN",
      terms: {},
      outstandingBalance: "400000",
    },
  ];
  const rollup = buildCapTableRollup(debtOnly);
  assert.equal(rollup.totalFullyDilutedShares.toString(), "0");
  assert.equal(rollup.equityRows.length, 0);
  assert.equal(rollup.debtRows.length, 1);
});

test("aggregateByStakeholder: sums multiple instruments for the same stakeholder into one ownership figure", () => {
  const twoGrantsSameEmployee: CapTableInstrumentInput[] = [
    { instrumentId: "opt1", stakeholderId: "jane", stakeholderName: "Jane Doe", type: "STOCK_OPTION", terms: { quantity: 12000 } },
    { instrumentId: "opt2", stakeholderId: "jane", stakeholderName: "Jane Doe", type: "RSU", terms: { quantity: 3000 } },
    { instrumentId: "common1", stakeholderId: "founders", stakeholderName: "Founders Holdco", type: "COMMON_STOCK", terms: { quantity: 85000 } },
  ];
  const rollup = buildCapTableRollup(twoGrantsSameEmployee);
  const byStakeholder = aggregateByStakeholder(rollup);

  assert.equal(byStakeholder.length, 2);
  const jane = byStakeholder.find((s) => s.stakeholderId === "jane")!;
  assert.equal(jane.shares.toString(), "15000"); // 12,000 + 3,000
  // 15,000 / 100,000 * 100 = 15%
  assert.equal(jane.ownershipPercent!.toString(), "15");
  // Sorted descending by shares — founders (85,000) should come first.
  assert.equal(byStakeholder[0].stakeholderId, "founders");
});
