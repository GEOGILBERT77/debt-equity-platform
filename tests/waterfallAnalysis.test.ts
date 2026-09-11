import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExitWaterfall, WaterfallClassInput } from "../src/lib/accounting/exitWaterfall.js";
import { buildWaterfallSensitivity, findWaterfallBreakpoints } from "../src/lib/accounting/waterfallAnalysis.js";

/**
 * Same class stack as the cap-table-waterfall-scenario-demo.xlsx deliverable (Series
 * C senior/participating/3x-capped, Series B and A non-participating 1x, a 10.5M-share
 * common pool) — every expected number below was hand-derived from that stack's known
 * behavior (Series A converts above $30M, Series B above $80M, Series C's cap binds at
 * $340M — see the delivery notes) and cross-checked against buildExitWaterfall directly
 * within this file, not just asserted from memory.
 */
const classes: WaterfallClassInput[] = [
  { id: "seriesC", name: "Series C", seniorityRank: 1, shares: 2_500_000, liquidationPreferencePerShare: 8, participating: true, participationCap: 24 },
  { id: "seriesB", name: "Series B", seniorityRank: 2, shares: 3_000_000, liquidationPreferencePerShare: 4, participating: false },
  { id: "seriesA", name: "Series A", seniorityRank: 3, shares: 4_000_000, liquidationPreferencePerShare: 1.5, participating: false },
  { id: "common", name: "Common pool", seniorityRank: 99, shares: 10_500_000, liquidationPreferencePerShare: 0, participating: false },
];

test("buildWaterfallSensitivity: sweeps evenly-spaced exit values and matches buildExitWaterfall at every point", () => {
  const points = buildWaterfallSensitivity(classes, { min: 0, max: 100_000_000, steps: 4 });
  assert.equal(points.length, 5); // steps + 1
  const expectedExits = [0, 25_000_000, 50_000_000, 75_000_000, 100_000_000];
  points.forEach((p, i) => {
    assert.equal(p.exitProceeds.toFixed(2), expectedExits[i].toFixed(2));
    const direct = buildExitWaterfall(expectedExits[i], classes);
    for (const cr of p.classResults) {
      const directCr = direct.classResults.find((d) => d.id === cr.id)!;
      assert.equal(cr.totalProceeds.toFixed(2), directCr.totalProceeds.toFixed(2), `mismatch for ${cr.id} at exit=${expectedExits[i]}`);
    }
  });
});

test("buildWaterfallSensitivity: rejects a non-positive step count and max < min", () => {
  assert.throws(() => buildWaterfallSensitivity(classes, { min: 0, max: 10, steps: 0 }));
  assert.throws(() => buildWaterfallSensitivity(classes, { min: 10, max: 0, steps: 5 }));
});

test("findWaterfallBreakpoints: breakeven exit values match the seniority stack's cumulative preferences", () => {
  const bps = findWaterfallBreakpoints(classes, 1_000_000_000);
  const byId = Object.fromEntries(bps.map((b) => [b.id, b]));

  // Series C (most senior) sees money almost immediately.
  assert.ok(Number(byId.seriesC.breakevenExitProceeds) < 1, `Series C breakeven should be ~0, got ${byId.seriesC.breakevenExitProceeds}`);
  // Series B needs Series C's full $20,000,000 preference paid first.
  assert.equal(Number(byId.seriesB.breakevenExitProceeds).toFixed(0), "20000000");
  // Series A and the common pool both enter the residual pool once C+B's combined
  // $32,000,000 preference is fully paid (A itself converts above $30M, but doesn't
  // actually see any money until the residual pool has something in it).
  assert.equal(Number(byId.seriesA.breakevenExitProceeds).toFixed(0), "32000000");
  assert.equal(Number(byId.common.breakevenExitProceeds).toFixed(0), "32000000");
});

test("findWaterfallBreakpoints: conversion breakpoints match preference/share x total FD shares", () => {
  const bps = findWaterfallBreakpoints(classes, 1_000_000_000);
  const byId = Object.fromEntries(bps.map((b) => [b.id, b]));

  // Total FD shares = 2.5M + 3M + 4M + 10.5M = 20,000,000.
  // Series A converts once as-converted value/share ($1.50 pref) is exceeded: 1.5 x 20M.
  assert.equal(Number(byId.seriesA.conversionBreakpointExitProceeds).toFixed(0), "30000000");
  // Series B converts once its $4.00 preference/share is exceeded: 4 x 20M.
  assert.equal(Number(byId.seriesB.conversionBreakpointExitProceeds).toFixed(0), "80000000");
  // Series C is participating — it never "converts," so this is never computed for it.
  assert.equal(byId.seriesC.conversionBreakpointExitProceeds, null);
  // The common pool has a zero preference — the conversion test doesn't apply to it either.
  assert.equal(byId.common.conversionBreakpointExitProceeds, null);

  // Cross-check directly against buildExitWaterfall on both sides of Series A's breakpoint.
  const justBelow = buildExitWaterfall(29_999_000, classes).classResults.find((r) => r.id === "seriesA")!;
  const justAbove = buildExitWaterfall(30_001_000, classes).classResults.find((r) => r.id === "seriesA")!;
  assert.equal(justBelow.converted, false);
  assert.equal(justAbove.converted, true);
});

test("findWaterfallBreakpoints: Series C's 3x participation cap binds at $340,000,000", () => {
  const bps = findWaterfallBreakpoints(classes, 1_000_000_000);
  const byId = Object.fromEntries(bps.map((b) => [b.id, b]));

  // Hand-derivation: above $80M both A and B have converted, so the residual pool is
  // all 20,000,000 FD shares and only Series C's $20,000,000 preference is paid off
  // the top. Series C's cap ($24/share x 2,500,000 = $60,000,000) binds when its
  // uncapped total (20,000,000 + 2,500,000 x per-share-residual) reaches $60,000,000,
  // i.e. per-share-residual = $16.00, i.e. (exit - 20,000,000) / 20,000,000 = 16,
  // i.e. exit = $340,000,000.
  assert.equal(Number(byId.seriesC.participationCapBreakpointExitProceeds).toFixed(0), "340000000");
  // Not participating (or not capped) — never computed for the other three classes.
  assert.equal(byId.seriesB.participationCapBreakpointExitProceeds, null);
  assert.equal(byId.seriesA.participationCapBreakpointExitProceeds, null);
  assert.equal(byId.common.participationCapBreakpointExitProceeds, null);

  const justBelow = buildExitWaterfall(339_999_000, classes).classResults.find((r) => r.id === "seriesC")!;
  const justAbove = buildExitWaterfall(340_001_000, classes).classResults.find((r) => r.id === "seriesC")!;
  assert.equal(justBelow.cappedByParticipation, false);
  assert.equal(justAbove.cappedByParticipation, true);
});

test("findWaterfallBreakpoints: a breakpoint that never occurs within the searched range comes back null", () => {
  // Search ceiling far below Series B's real $80,000,000 conversion breakpoint.
  const bps = findWaterfallBreakpoints(classes, 10_000_000);
  const byId = Object.fromEntries(bps.map((b) => [b.id, b]));
  assert.equal(byId.seriesB.conversionBreakpointExitProceeds, null);
  assert.equal(byId.seriesC.participationCapBreakpointExitProceeds, null);
});

test("findWaterfallBreakpoints: rejects a non-positive search ceiling", () => {
  assert.throws(() => findWaterfallBreakpoints(classes, 0));
  assert.throws(() => findWaterfallBreakpoints(classes, -5));
});
