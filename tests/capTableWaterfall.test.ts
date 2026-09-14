import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWaterfallClassesFromCapTable } from "../src/lib/accounting/capTableWaterfall.js";
import { buildExitWaterfall } from "../src/lib/accounting/exitWaterfall.js";
import { CapTableInstrumentInput } from "../src/lib/accounting/capTable.js";
import { PreferredStockInstrumentTerms } from "../src/lib/accounting/dispatch.js";
import { Decimal } from "../src/lib/accounting/types.js";

function preferredTerms(
  quantity: number,
  overrides: Partial<NonNullable<PreferredStockInstrumentTerms["liquidationPreference"]>> = {}
): PreferredStockInstrumentTerms {
  return {
    classification: {
      mandatorilyRedeemable: false,
      redeemableAtHolderOption: false,
      redeemableUponContingentEventOutsideCompanyControl: true, // mezzanine — the ordinary VC-preferred case
    },
    conversionTerms: { quantity, conversionRatio: 1 },
    liquidationPreference: {
      seniorityRank: 1,
      originalIssuePricePerShare: "1.00",
      liquidationPreferenceMultiple: "1",
      participating: false,
      ...overrides,
    },
  };
}

test("capTableWaterfall: pools two Series A holders into one class, and every other equity type into one Common pool", () => {
  const instruments: CapTableInstrumentInput[] = [
    {
      instrumentId: "pref1",
      stakeholderId: "s1",
      stakeholderName: "Investor 1",
      type: "PREFERRED_STOCK",
      terms: preferredTerms(1_000_000, { seriesName: "Series A" }),
    },
    {
      instrumentId: "pref2",
      stakeholderId: "s2",
      stakeholderName: "Investor 2",
      type: "PREFERRED_STOCK",
      terms: preferredTerms(1_000_000, { seriesName: "Series A" }),
    },
    {
      instrumentId: "common1",
      stakeholderId: "s3",
      stakeholderName: "Founder",
      type: "COMMON_STOCK",
      terms: { quantity: 8_000_000 },
    },
    {
      instrumentId: "loan1",
      stakeholderId: "s4",
      stakeholderName: "Bank",
      type: "TERM_LOAN",
      terms: { faceValue: "500000", netProceeds: "500000", effectiveAnnualYield: "0.08", cashFlows: [] },
      outstandingBalance: "500000",
    },
  ];

  const { classes, excluded, holdersByClassId, debt } = buildWaterfallClassesFromCapTable(instruments);
  assert.equal(excluded.length, 0);
  assert.equal(classes.length, 2); // Series A pooled to one class + one Common pool — TERM_LOAN excluded from the class stack (surfaced separately, in `debt`)

  const seriesA = classes.find((c) => c.id === "Series A")!;
  assert.ok(seriesA, "Series A class should exist");
  assert.equal(seriesA.shares.toString(), "2000000"); // 1,000,000 + 1,000,000 as-converted (1:1 ratio)
  assert.equal(new Decimal(seriesA.liquidationPreferencePerShare).toFixed(2), "1.00");

  const common = classes.find((c) => c.id === "__common_pool__")!;
  assert.ok(common);
  assert.equal(common.shares.toString(), "8000000");

  // v0.40.0 — holder-level breakdown for the report's expand/collapse UI, and debt
  // surfaced (not part of the class stack, but no longer silently dropped either).
  assert.equal(holdersByClassId["Series A"].length, 2);
  assert.deepEqual(
    holdersByClassId["Series A"].map((h) => h.stakeholderName).sort(),
    ["Investor 1", "Investor 2"]
  );
  assert.equal(holdersByClassId["__common_pool__"].length, 1);
  assert.equal(holdersByClassId["__common_pool__"][0].stakeholderName, "Founder");
  assert.equal(debt.length, 1);
  assert.equal(debt[0].instrumentId, "loan1");
  assert.equal(debt[0].stakeholderName, "Bank");
  assert.equal(debt[0].type, "TERM_LOAN");
  assert.equal(debt[0].outstandingBalance!.toString(), "500000");

  // And the resulting classes actually run through buildExitWaterfall correctly —
  // low exit ($5M): Series A's as-converted per-share value (5,000,000/10,000,000 =
  // $0.50) is below its $1.00 preference, so it takes the preference, not residual.
  const result = buildExitWaterfall(5_000_000, classes);
  const seriesAResult = result.classResults.find((r) => r.id === "Series A")!;
  assert.equal(seriesAResult.converted, false);
  assert.equal(seriesAResult.totalProceeds.toFixed(2), "2000000.00"); // 2,000,000 shares x $1.00 preference
  const commonResult = result.classResults.find((r) => r.id === "__common_pool__")!;
  assert.equal(commonResult.totalProceeds.toFixed(2), "3000000.00"); // remaining $3M to common
});

test("capTableWaterfall: excludes PREFERRED_STOCK with no liquidationPreference recorded, flags the reason", () => {
  const instruments: CapTableInstrumentInput[] = [
    {
      instrumentId: "pref1",
      stakeholderId: "s1",
      stakeholderName: "Investor 1",
      type: "PREFERRED_STOCK",
      terms: {
        classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: true },
        conversionTerms: { quantity: 1_000_000, conversionRatio: 1 },
        // no liquidationPreference
      },
    },
  ];
  const { classes, excluded } = buildWaterfallClassesFromCapTable(instruments);
  assert.equal(classes.length, 0);
  assert.equal(excluded.length, 1);
  assert.match(excluded[0].reason, /No liquidationPreference terms recorded/);
});

test("capTableWaterfall: flags inconsistent terms within the same series rather than averaging them", () => {
  const instruments: CapTableInstrumentInput[] = [
    {
      instrumentId: "pref1",
      stakeholderId: "s1",
      stakeholderName: "Investor 1",
      type: "PREFERRED_STOCK",
      terms: preferredTerms(1_000_000, { seriesName: "Series A", seniorityRank: 1 }),
    },
    {
      instrumentId: "pref2",
      stakeholderId: "s2",
      stakeholderName: "Investor 2",
      type: "PREFERRED_STOCK",
      terms: preferredTerms(1_000_000, { seriesName: "Series A", seniorityRank: 2 }), // mismatched rank
    },
  ];
  const { classes, excluded } = buildWaterfallClassesFromCapTable(instruments);
  assert.equal(classes.length, 0);
  assert.equal(excluded.length, 2);
  assert.match(excluded[0].reason, /inconsistent liquidationPreference terms/);
});

test("capTableWaterfall: a participating series with a cap carries the cap through to the waterfall class", () => {
  const instruments: CapTableInstrumentInput[] = [
    {
      instrumentId: "pref1",
      stakeholderId: "s1",
      stakeholderName: "Investor 1",
      type: "PREFERRED_STOCK",
      terms: preferredTerms(1_000_000, {
        seriesName: "Series B",
        seniorityRank: 1,
        participating: true,
        participationCapMultiple: "3",
      }),
    },
  ];
  const { classes, excluded } = buildWaterfallClassesFromCapTable(instruments);
  assert.equal(excluded.length, 0);
  const seriesB = classes[0];
  assert.equal(seriesB.participating, true);
  assert.ok(seriesB.participationCap !== undefined);
  assert.equal(new Decimal(seriesB.participationCap!).toFixed(2), "3.00"); // 3x $1.00 issue price / 1:1 as-converted
});
