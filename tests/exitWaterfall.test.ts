import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExitWaterfall, WaterfallClassInput } from "../src/lib/accounting/exitWaterfall.js";

/**
 * Every scenario below is hand-computed in the doc comment/commit history for
 * exitWaterfall.ts's design — see that file's methodology note for the rules being
 * exercised here. Numbers are chosen to be exactly reproducible by hand.
 */

test("exitWaterfall: high exit — non-participating preferred converts to common", () => {
  const classes: WaterfallClassInput[] = [
    { id: "common", name: "Common", seniorityRank: 99, shares: 8_000_000, liquidationPreferencePerShare: 0, participating: false },
    { id: "seriesA", name: "Series A", seniorityRank: 1, shares: 2_000_000, liquidationPreferencePerShare: 1, participating: false },
  ];
  // As-converted per share = 50,000,000 / 10,000,000 = $5.00 > $1.00 preference -> Series A converts.
  const result = buildExitWaterfall(50_000_000, classes);

  const common = result.classResults.find((r) => r.id === "common")!;
  const seriesA = result.classResults.find((r) => r.id === "seriesA")!;

  assert.equal(seriesA.converted, true);
  assert.equal(common.totalProceeds.toFixed(2), "40000000.00"); // 8,000,000 * $5.00
  assert.equal(seriesA.totalProceeds.toFixed(2), "10000000.00"); // 2,000,000 * $5.00
  assert.equal(result.totalDistributed.toFixed(2), "50000000.00");
  assert.equal(result.undistributed.toFixed(2), "0.00");
});

test("exitWaterfall: low exit — non-participating preferred takes its stated preference", () => {
  const classes: WaterfallClassInput[] = [
    { id: "common", name: "Common", seniorityRank: 99, shares: 8_000_000, liquidationPreferencePerShare: 0, participating: false },
    { id: "seriesA", name: "Series A", seniorityRank: 1, shares: 2_000_000, liquidationPreferencePerShare: 1, participating: false },
  ];
  // As-converted per share = 5,000,000 / 10,000,000 = $0.50 < $1.00 preference -> Series A takes its preference.
  const result = buildExitWaterfall(5_000_000, classes);

  const common = result.classResults.find((r) => r.id === "common")!;
  const seriesA = result.classResults.find((r) => r.id === "seriesA")!;

  assert.equal(seriesA.converted, false);
  assert.equal(seriesA.totalProceeds.toFixed(2), "2000000.00"); // its full $1/share x 2,000,000 preference
  // Residual = 5,000,000 - 2,000,000 = 3,000,000 to common alone (8,000,000 shares) = $0.375/share.
  assert.equal(common.totalProceeds.toFixed(2), "3000000.00");
  assert.equal(result.totalDistributed.toFixed(2), "5000000.00");
});

test("exitWaterfall: proceeds insufficient even for the stated preference — common gets zero", () => {
  const classes: WaterfallClassInput[] = [
    { id: "common", name: "Common", seniorityRank: 99, shares: 8_000_000, liquidationPreferencePerShare: 0, participating: false },
    { id: "seriesA", name: "Series A", seniorityRank: 1, shares: 2_000_000, liquidationPreferencePerShare: 1, participating: false },
  ];
  const result = buildExitWaterfall(1_000_000, classes);

  const common = result.classResults.find((r) => r.id === "common")!;
  const seriesA = result.classResults.find((r) => r.id === "seriesA")!;

  assert.equal(seriesA.totalProceeds.toFixed(2), "1000000.00");
  assert.equal(common.totalProceeds.toFixed(2), "0.00");
  assert.equal(result.totalDistributed.toFixed(2), "1000000.00");
});

test("exitWaterfall: seniority stack — senior preference fully satisfied before junior sees anything", () => {
  const classes: WaterfallClassInput[] = [
    { id: "common", name: "Common", seniorityRank: 99, shares: 7_000_000, liquidationPreferencePerShare: 0, participating: false },
    { id: "seriesB", name: "Series B (senior)", seniorityRank: 1, shares: 1_000_000, liquidationPreferencePerShare: 3, participating: false },
    { id: "seriesA", name: "Series A (junior)", seniorityRank: 2, shares: 2_000_000, liquidationPreferencePerShare: 1, participating: false },
  ];
  // Total FD shares = 10,000,000. As-converted-per-share at $4,000,000 = $0.40, below
  // both classes' preferences ($3 and $1), so both take their preference.
  const result = buildExitWaterfall(4_000_000, classes);

  const seriesB = result.classResults.find((r) => r.id === "seriesB")!;
  const seriesA = result.classResults.find((r) => r.id === "seriesA")!;
  const common = result.classResults.find((r) => r.id === "common")!;

  assert.equal(seriesB.totalProceeds.toFixed(2), "3000000.00"); // fully satisfied first (senior)
  assert.equal(seriesA.totalProceeds.toFixed(2), "1000000.00"); // remaining 1,000,000 of its 2,000,000 due
  assert.equal(common.totalProceeds.toFixed(2), "0.00"); // nothing left
  assert.equal(result.totalDistributed.toFixed(2), "4000000.00");
});

test("exitWaterfall: participating preferred takes preference plus pro-rata residual", () => {
  const classes: WaterfallClassInput[] = [
    { id: "common", name: "Common", seniorityRank: 99, shares: 8_000_000, liquidationPreferencePerShare: 0, participating: false },
    { id: "seriesA", name: "Series A (participating)", seniorityRank: 1, shares: 2_000_000, liquidationPreferencePerShare: 1, participating: true },
  ];
  const result = buildExitWaterfall(10_000_000, classes);

  const seriesA = result.classResults.find((r) => r.id === "seriesA")!;
  const common = result.classResults.find((r) => r.id === "common")!;

  // Step 1: Series A preference = 2,000,000. Remaining = 8,000,000.
  // Step 2: residual pool = common (8,000,000) + Series A (2,000,000) = 10,000,000 shares.
  // Per-share residual = 8,000,000 / 10,000,000 = $0.80.
  assert.equal(seriesA.proceedsFromPreference.toFixed(2), "2000000.00");
  assert.equal(seriesA.proceedsFromResidual.toFixed(2), "1600000.00"); // 2,000,000 * 0.80
  assert.equal(seriesA.totalProceeds.toFixed(2), "3600000.00");
  assert.equal(common.totalProceeds.toFixed(2), "6400000.00"); // 8,000,000 * 0.80
  assert.equal(result.totalDistributed.toFixed(2), "10000000.00");
  assert.equal(result.undistributed.toFixed(2), "0.00");
});

test("exitWaterfall: participation cap clamps payout and reports the clawback as undistributed", () => {
  const classes: WaterfallClassInput[] = [
    { id: "common", name: "Common", seniorityRank: 99, shares: 8_000_000, liquidationPreferencePerShare: 0, participating: false },
    {
      id: "seriesA",
      name: "Series A (participating, 3x cap)",
      seniorityRank: 1,
      shares: 2_000_000,
      liquidationPreferencePerShare: 1,
      participating: true,
      participationCap: 3, // total return capped at $3.00/share
    },
  ];
  const result = buildExitWaterfall(50_000_000, classes);

  const seriesA = result.classResults.find((r) => r.id === "seriesA")!;
  const common = result.classResults.find((r) => r.id === "common")!;

  // Uncapped: preference 2,000,000; residual pool = 10,000,000 shares, remaining 48,000,000
  // -> per-share residual $4.80 -> Series A residual = 9,600,000 -> uncapped total 11,600,000
  // ($5.80/share) vs. cap of $3.00/share * 2,000,000 = 6,000,000 -> clamps to 6,000,000.
  assert.equal(seriesA.cappedByParticipation, true);
  assert.equal(seriesA.totalProceeds.toFixed(2), "6000000.00");
  assert.equal(seriesA.perShareProceeds.toFixed(2), "3.00");
  // Common's residual share is computed from the SAME (uncapped) per-share residual —
  // the cap's clawback is not reallocated to common, per the documented simplification.
  assert.equal(common.totalProceeds.toFixed(2), "38400000.00"); // 8,000,000 * $4.80
  assert.equal(result.undistributed.toFixed(2), "5600000.00"); // 11,600,000 - 6,000,000
  assert.equal(result.totalDistributed.plus(result.undistributed).toFixed(2), "50000000.00");
});

test("exitWaterfall: plain common-only cap table — every dollar goes pro-rata by shares", () => {
  const classes: WaterfallClassInput[] = [
    { id: "founder", name: "Founder", seniorityRank: 99, shares: 6_000_000, liquidationPreferencePerShare: 0, participating: false },
    { id: "employee", name: "Employee pool", seniorityRank: 99, shares: 4_000_000, liquidationPreferencePerShare: 0, participating: false },
  ];
  const result = buildExitWaterfall(20_000_000, classes);
  const founder = result.classResults.find((r) => r.id === "founder")!;
  const employee = result.classResults.find((r) => r.id === "employee")!;
  assert.equal(founder.totalProceeds.toFixed(2), "12000000.00");
  assert.equal(employee.totalProceeds.toFixed(2), "8000000.00");
});
