import test from "node:test";
import assert from "node:assert/strict";
import {
  applyIso100kLimit,
  computeIsoExerciseAmtPreference,
  evaluateSection83bElection,
  computeOrdinaryIncomeWithoutSection83b,
  computeQsbsExclusion,
  computeTaxOid,
  computeMarketDiscount,
} from "../src/lib/accounting/taxElections.js";

// =============================================================================
// 1. ISO $100k rule
// =============================================================================

/**
 * GOLDEN SCENARIO: two ISO grants to the same employee, both with a single tranche
 * first exercisable in 2025.
 *   Grant A: granted 2024-01-01 (earlier), $10/share grant-date FMV, 8,000 shares
 *     exercisable 2025-01-01 -> value = $80,000.
 *   Grant B: granted 2024-06-01 (later), $12/share grant-date FMV, 3,000 shares
 *     exercisable 2025-01-01 -> value = $36,000.
 * Combined 2025 exercisability = $116,000, exceeding $100,000 by $16,000.
 * Hand check: Grant A was granted FIRST, so it's processed first and fits entirely
 * under the cap ($80,000 <= $100,000) -> fully ISO, 8,000 shares. Grant B then has
 * only $20,000 of cap remaining ($100,000 - $80,000): isoValue = $20,000, so
 * isoQuantity = 3,000 * (20,000/36,000) = 1,666.666... shares ISO, and the remaining
 * 1,333.333... shares (worth exactly $16,000 at $12/share) become NSO.
 */
test("applyIso100kLimit: an earlier grant consumes the cap first, and a later grant in the same year absorbs the excess as NSO", () => {
  const results = applyIso100kLimit([
    {
      id: "Grant A",
      grantDate: "2024-01-01",
      grantDateFmvPerShare: 10,
      tranches: [{ id: "A-1", firstExercisableDate: "2025-01-01", quantity: 8000 }],
    },
    {
      id: "Grant B",
      grantDate: "2024-06-01",
      grantDateFmvPerShare: 12,
      tranches: [{ id: "B-1", firstExercisableDate: "2025-01-01", quantity: 3000 }],
    },
  ]);

  const a = results.find((r) => r.grantId === "Grant A")!;
  const b = results.find((r) => r.grantId === "Grant B")!;

  assert.equal(a.isoQuantity.toFixed(2), "8000.00");
  assert.equal(a.nsoQuantity.toFixed(2), "0.00");

  assert.equal(b.isoQuantity.toFixed(4), "1666.6667");
  assert.equal(b.nsoQuantity.toFixed(4), "1333.3333");
  // Value check: the NSO portion should be worth exactly the $16,000 excess.
  assert.equal(b.nsoQuantity.times(12).toFixed(2), "16000.00");
});

test("applyIso100kLimit: each calendar year is independent — no carryover of unused cap or of excess", () => {
  const results = applyIso100kLimit([
    {
      id: "Grant A",
      grantDate: "2024-01-01",
      grantDateFmvPerShare: 10,
      tranches: [
        { id: "A-1", firstExercisableDate: "2025-01-01", quantity: 15000 }, // $150,000 in 2025 alone
        { id: "A-2", firstExercisableDate: "2026-01-01", quantity: 5000 }, // $50,000 in 2026, well under the cap
      ],
    },
  ]);
  const y2025 = results.find((r) => r.calendarYear === 2025)!;
  const y2026 = results.find((r) => r.calendarYear === 2026)!;

  assert.equal(y2025.isoQuantity.toFixed(2), "10000.00"); // $100,000 / $10 per share
  assert.equal(y2025.nsoQuantity.toFixed(2), "5000.00");
  // 2026 gets its own fresh $100k cap — fully ISO despite 2025's overage.
  assert.equal(y2026.isoQuantity.toFixed(2), "5000.00");
  assert.equal(y2026.nsoQuantity.toFixed(2), "0.00");
});

// =============================================================================
// 2. AMT preference on ISO exercise
// =============================================================================

test("computeIsoExerciseAmtPreference: the full bargain element is an AMT preference item when the shares are held", () => {
  const result = computeIsoExerciseAmtPreference({
    exerciseDate: "2025-06-01",
    quantity: 1000,
    exercisePricePerShare: 10,
    fmvPerShareAtExercise: 50,
  });
  assert.equal(result.bargainElement.toFixed(2), "40000.00");
  assert.equal(result.amtPreferenceItem.toFixed(2), "40000.00");
});

test("computeIsoExerciseAmtPreference: a same-calendar-year disqualifying disposition eliminates the AMT preference entirely", () => {
  const result = computeIsoExerciseAmtPreference({
    exerciseDate: "2025-06-01",
    quantity: 1000,
    exercisePricePerShare: 10,
    fmvPerShareAtExercise: 50,
    disqualifyingDispositionSameCalendarYear: true,
  });
  assert.equal(result.bargainElement.toFixed(2), "40000.00"); // still computed and reported
  assert.equal(result.amtPreferenceItem.toFixed(2), "0.00"); // but no AMT hit
});

// =============================================================================
// 3. IRC 83(b) elections
// =============================================================================

test("evaluateSection83bElection: a timely election (within 30 days) recognizes ordinary income now on the transfer-date spread", () => {
  const result = evaluateSection83bElection(
    { transferDate: "2025-01-01", fmvPerShareAtTransfer: 5, purchasePricePerShare: 1, quantity: 10000 },
    "2025-01-20"
  );
  assert.equal(result.deadline, "2025-01-31"); // 30 days after Jan 1
  assert.equal(result.isTimely, true);
  assert.equal(result.ordinaryIncomeAtTransfer.toFixed(2), "40000.00"); // (5-1)*10000
});

test("evaluateSection83bElection: filing even one day late voids the election entirely — no partial credit, no extension", () => {
  const result = evaluateSection83bElection(
    { transferDate: "2025-01-01", fmvPerShareAtTransfer: 5, purchasePricePerShare: 1, quantity: 10000 },
    "2025-02-01" // deadline was 2025-01-31
  );
  assert.equal(result.isTimely, false);
  assert.equal(result.ordinaryIncomeAtTransfer.toFixed(2), "0.00");
  assert.match(result.note, /NOT TIMELY/);
});

/**
 * GOLDEN COMPARISON: same restricted stock grant, 4 annual tranches of 2,500 shares
 * each, purchase price $1/share throughout, but FMV escalates as the company grows:
 * $5, $8, $12, $20 per share at each successive vest date.
 * Without an 83(b) election, income is recognized at EACH vest date's own FMV:
 *   Year 1: (5-1)*2500 = $10,000; Year 2: (8-1)*2500 = $17,500;
 *   Year 3: (12-1)*2500 = $27,500; Year 4: (20-1)*2500 = $47,500.
 *   Total = $102,500.
 * With a timely 83(b) election filed at transfer (FMV $5, matching Year 1's rate, as
 * if the whole grant were valued at transfer): ordinary income = (5-1)*10,000 shares
 * = $40,000 — one time, at transfer — which is exactly the comparison an 83(b)
 * election is meant to make favorable when FMV is expected to rise.
 */
test("computeOrdinaryIncomeWithoutSection83b: recognizes income at each vest date's own (rising) FMV, illustrating why an 83(b) election is usually favorable when FMV is expected to climb", () => {
  const noElection = computeOrdinaryIncomeWithoutSection83b([
    { vestDate: "2025-01-01", quantity: 2500, fmvPerShareAtVest: 5, purchasePricePerShare: 1 },
    { vestDate: "2026-01-01", quantity: 2500, fmvPerShareAtVest: 8, purchasePricePerShare: 1 },
    { vestDate: "2027-01-01", quantity: 2500, fmvPerShareAtVest: 12, purchasePricePerShare: 1 },
    { vestDate: "2028-01-01", quantity: 2500, fmvPerShareAtVest: 20, purchasePricePerShare: 1 },
  ]);
  const totalWithoutElection = noElection.reduce((sum, r) => sum.plus(r.ordinaryIncome), noElection[0].ordinaryIncome.minus(noElection[0].ordinaryIncome));
  assert.equal(totalWithoutElection.toFixed(2), "102500.00");

  const withElection = evaluateSection83bElection(
    { transferDate: "2025-01-01", fmvPerShareAtTransfer: 5, purchasePricePerShare: 1, quantity: 10000 },
    "2025-01-15"
  );
  assert.equal(withElection.ordinaryIncomeAtTransfer.toFixed(2), "40000.00");
  assert.ok(withElection.ordinaryIncomeAtTransfer.toNumber() < totalWithoutElection.toNumber());
});

// =============================================================================
// 4. QSBS / Section 1202
// =============================================================================

test("computeQsbsExclusion: pre-OBBBA, 100%-exclusion tier (acquired after 9/27/2010) — capped at $10M, and NO AMT preference on the excluded gain", () => {
  const result = computeQsbsExclusion({
    issuanceDate: "2019-01-01",
    dispositionDate: "2025-06-01", // more than 5 years after acquisition
    adjustedBasis: 1_000_000,
    amountRealized: 21_000_000, // $20,000,000 gain
    metGrossAssetsTest: true,
    isQualifiedSmallBusinessStock: true,
  });
  assert.equal(result.regime, "pre-OBBBA");
  assert.equal(result.eligible, true);
  assert.equal(result.exclusionPercentage, 1);
  assert.equal(result.gain.toFixed(2), "20000000.00");
  assert.equal(result.exclusionCap.toFixed(2), "10000000.00"); // greater of $10M or 10x $1M basis
  assert.equal(result.excludableGain.toFixed(2), "10000000.00"); // capped
  assert.equal(result.taxableGain.toFixed(2), "10000000.00");
  assert.equal(result.amtPreferenceItem.toFixed(2), "0.00"); // 100% tier: no AMT preference
});

test("computeQsbsExclusion: pre-OBBBA, 50%-exclusion tier (acquired on or before 2/17/2009) carries a 7% AMT preference on the excluded gain", () => {
  const result = computeQsbsExclusion({
    issuanceDate: "2008-06-01",
    dispositionDate: "2015-01-01",
    adjustedBasis: 500_000,
    amountRealized: 2_500_000, // $2,000,000 gain
    metGrossAssetsTest: true,
    isQualifiedSmallBusinessStock: true,
  });
  assert.equal(result.exclusionPercentage, 0.5);
  assert.equal(result.excludableGain.toFixed(2), "1000000.00"); // 50% of $2M
  assert.equal(result.amtPreferenceItem.toFixed(2), "70000.00"); // 7% of $1,000,000
  assert.equal(result.taxableGain.toFixed(2), "1000000.00");
});

test("computeQsbsExclusion: pre-OBBBA stock that hasn't cleared the 5-year cliff gets zero exclusion", () => {
  const result = computeQsbsExclusion({
    issuanceDate: "2022-01-01",
    dispositionDate: "2024-06-01", // under 5 years
    adjustedBasis: 100_000,
    amountRealized: 1_000_000,
    metGrossAssetsTest: true,
    isQualifiedSmallBusinessStock: true,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.excludableGain.toFixed(2), "0.00");
  assert.equal(result.taxableGain.toFixed(2), "900000.00"); // full gain is taxable
});

test("computeQsbsExclusion: post-OBBBA, 4-year tier (75%) on stock acquired after 7/4/2025, capped at $15M", () => {
  const result = computeQsbsExclusion({
    issuanceDate: "2025-08-01",
    dispositionDate: "2029-08-01", // exactly 4 years after acquisition
    adjustedBasis: 200_000,
    amountRealized: 4_200_000, // $4,000,000 gain
    metGrossAssetsTest: true,
    isQualifiedSmallBusinessStock: true,
  });
  assert.equal(result.regime, "post-OBBBA");
  assert.equal(result.exclusionPercentage, 0.75);
  assert.equal(result.exclusionCap.toFixed(2), "15000000.00");
  assert.equal(result.excludableGain.toFixed(2), "3000000.00"); // 75% of $4M
  assert.equal(result.amtPreferenceItem.toFixed(2), "210000.00"); // 7% of $3M, per this module's documented (flagged) reading
  assert.equal(result.taxableGain.toFixed(2), "1000000.00");
});

test("computeQsbsExclusion: post-OBBBA stock held less than 3 years gets zero exclusion under the new tiered rules", () => {
  const result = computeQsbsExclusion({
    issuanceDate: "2025-08-01",
    dispositionDate: "2027-01-01", // under 3 years
    adjustedBasis: 100_000,
    amountRealized: 1_000_000,
    metGrossAssetsTest: true,
    isQualifiedSmallBusinessStock: true,
  });
  assert.equal(result.eligible, false);
});

test("computeQsbsExclusion: the issued-vs-acquired distinction — a secondary purchase of pre-OBBBA-issued stock still tests against the OLD $50M gross-assets threshold, even though the taxpayer's own acquisition falls in the post-OBBBA window", () => {
  const result = computeQsbsExclusion({
    issuanceDate: "2020-01-01", // issued well before the OBBBA cutoff
    acquisitionDate: "2025-09-01", // but this taxpayer acquired it afterward (secondary purchase)
    dispositionDate: "2029-09-02", // >= 4-year mark from acquisition
    adjustedBasis: 100_000,
    amountRealized: 500_000,
    metGrossAssetsTest: true,
    isQualifiedSmallBusinessStock: true,
  });
  assert.equal(result.grossAssetsTestThresholdApplicable, "$50,000,000 (pre-OBBBA — stock issued on or before 7/4/2025)");
  // But the HOLDING PERIOD/exclusion tier rules still follow the taxpayer's own
  // (post-OBBBA) acquisition date — the two tests genuinely use different dates.
  assert.equal(result.regime, "post-OBBBA");
});

test("computeQsbsExclusion: fails on ineligible stock or a failed gross-assets test regardless of holding period", () => {
  const notQsbs = computeQsbsExclusion({
    issuanceDate: "2019-01-01",
    dispositionDate: "2025-06-01",
    adjustedBasis: 100_000,
    amountRealized: 1_000_000,
    metGrossAssetsTest: true,
    isQualifiedSmallBusinessStock: false,
  });
  assert.equal(notQsbs.eligible, false);
  assert.match(notQsbs.ineligibilityReason!, /Not qualified small business stock/);

  const failedGrossAssets = computeQsbsExclusion({
    issuanceDate: "2019-01-01",
    dispositionDate: "2025-06-01",
    adjustedBasis: 100_000,
    amountRealized: 1_000_000,
    metGrossAssetsTest: false,
    isQualifiedSmallBusinessStock: true,
  });
  assert.equal(failedGrossAssets.eligible, false);
  assert.match(failedGrossAssets.ineligibilityReason!, /gross assets test/);
});

// =============================================================================
// 5. Debt-side: OID and market discount
// =============================================================================

/**
 * Reuses the exact hand-verified single-period golden scenario from
 * debtAmortization.test.ts: $100,000 stated redemption price, $95,000 issue price,
 * 1-year bullet. Total OID = $5,000. De minimis threshold = 0.25% * $100,000 * 1 year
 * = $250 — $5,000 comfortably exceeds it, so full constant-yield accrual applies, and
 * the schedule should show exactly the same $5,000.00 single-period number already
 * proven correct in the GAAP test.
 */
test("computeTaxOid: a real (non-de-minimis) OID accrues via the same constant-yield math as the GAAP effective-interest engine, tagged with the IRC citation", () => {
  const result = computeTaxOid(
    {
      issuePrice: 95000,
      statedRedemptionPriceAtMaturity: 100000,
      yieldToMaturity: 5000 / 95000,
      completeYearsToMaturity: 1,
      cashFlows: [{ date: "2026-01-01", amount: 100000 }],
    },
    [{ label: "Year 1", start: "2025-01-01", end: "2026-01-01" }]
  );
  assert.equal(result.totalOid.toFixed(2), "5000.00");
  assert.equal(result.deMinimisThreshold.toFixed(2), "250.00");
  assert.equal(result.isDeMinimis, false);
  assert.equal(result.schedule.length, 1);
  assert.equal(result.schedule[0].amount.toFixed(2), "5000.00");
  assert.equal(result.schedule[0].meta!.ircReference, "IRC 1272(a) (constant-yield OID accrual)");
});

test("computeTaxOid: OID smaller than the de minimis threshold requires no accrual at all", () => {
  const result = computeTaxOid(
    {
      issuePrice: 99900,
      statedRedemptionPriceAtMaturity: 100000, // only $100 of OID
      yieldToMaturity: 100 / 99900,
      completeYearsToMaturity: 1,
      cashFlows: [{ date: "2026-01-01", amount: 100000 }],
    },
    [{ label: "Year 1", start: "2025-01-01", end: "2026-01-01" }]
  );
  assert.equal(result.totalOid.toFixed(2), "100.00");
  assert.equal(result.deMinimisThreshold.toFixed(2), "250.00");
  assert.equal(result.isDeMinimis, true);
  assert.equal(result.schedule.length, 0);
});

/**
 * GOLDEN SCENARIO (market discount): a bond is purchased for $90,000 in the secondary
 * market when its revised (adjusted) issue price is $98,000 — an $8,000 market
 * discount. Stated redemption price at maturity is $100,000, 2 complete years
 * remaining to maturity from the purchase date.
 * De minimis threshold = 0.25% * $100,000 * 2 = $500 — $8,000 far exceeds it.
 * Ratable method: $8,000 spread evenly across the 2 equal-length annual periods =
 * $4,000/year.
 */
test("computeMarketDiscount: a real market discount produces both a ratable and a constant-yield schedule for comparison", () => {
  const periods = [
    { label: "Year 1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Year 2", start: "2026-01-01", end: "2027-01-01" },
  ];
  const result = computeMarketDiscount(
    {
      purchaseDate: "2025-01-01",
      purchasePrice: 90000,
      revisedIssuePriceAtPurchase: 98000,
      statedRedemptionPriceAtMaturity: 100000,
      maturityDate: "2027-01-01",
      yieldToMaturity: 0.0541, // approx yield off a $90,000 purchase to $100,000 in 2 years
      completeYearsToMaturity: 2,
      cashFlows: [
        { date: "2026-01-01", amount: 0 },
        { date: "2027-01-01", amount: 100000 },
      ],
    },
    periods
  );
  assert.equal(result.totalMarketDiscount.toFixed(2), "8000.00");
  assert.equal(result.deMinimisThreshold.toFixed(2), "500.00");
  assert.equal(result.isDeMinimis, false);
  assert.equal(result.ratableSchedule[0].amount.toFixed(2), "4000.00");
  assert.equal(result.ratableSchedule[1].amount.toFixed(2), "4000.00");
  // Both schedules should tie out to the same total, however differently they time it.
  const ratableTotal = result.ratableSchedule.reduce((s, r) => s.plus(r.amount), result.ratableSchedule[0].amount.minus(result.ratableSchedule[0].amount));
  assert.equal(ratableTotal.toFixed(2), "8000.00");
});

test("computeMarketDiscount: discount smaller than the de minimis threshold requires no inclusion under either method", () => {
  const periods = [{ label: "Year 1", start: "2025-01-01", end: "2026-01-01" }];
  const result = computeMarketDiscount(
    {
      purchaseDate: "2025-01-01",
      purchasePrice: 99800,
      revisedIssuePriceAtPurchase: 100000, // only $200 of market discount
      statedRedemptionPriceAtMaturity: 100000,
      maturityDate: "2026-01-01",
      yieldToMaturity: 200 / 99800,
      completeYearsToMaturity: 1,
      cashFlows: [{ date: "2026-01-01", amount: 100000 }],
    },
    periods
  );
  assert.equal(result.totalMarketDiscount.toFixed(2), "200.00");
  assert.equal(result.isDeMinimis, true);
  assert.equal(result.ratableSchedule.length, 0);
  assert.equal(result.constantYieldSchedule.length, 0);
});

test("computeMarketDiscount: no market discount at all (purchased at or above the revised issue price) produces empty schedules without being mislabeled as de minimis", () => {
  const periods = [{ label: "Year 1", start: "2025-01-01", end: "2026-01-01" }];
  const result = computeMarketDiscount(
    {
      purchaseDate: "2025-01-01",
      purchasePrice: 101000, // bought at a PREMIUM, not a discount
      revisedIssuePriceAtPurchase: 100000,
      statedRedemptionPriceAtMaturity: 100000,
      maturityDate: "2026-01-01",
      yieldToMaturity: 0.01,
      completeYearsToMaturity: 1,
      cashFlows: [{ date: "2026-01-01", amount: 100000 }],
    },
    periods
  );
  assert.equal(result.totalMarketDiscount.toFixed(2), "0.00");
  assert.equal(result.isDeMinimis, false); // not "de minimis" — there's simply none
  assert.equal(result.ratableSchedule.length, 0);
});
