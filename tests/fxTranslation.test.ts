import test from "node:test";
import assert from "node:assert/strict";
import { buildFxRemeasurementSchedule, fxRemeasurementEntry } from "../src/lib/accounting/fxTranslation.js";
import { money } from "../src/lib/accounting/types.js";

/**
 * GOLDEN SCENARIO (ASC 830-20): a €100,000 EUR-denominated term loan (a liability) is
 * issued when the spot rate is 1.10 USD/EUR — a $110,000 reporting-currency carrying
 * value. By the next period-end the spot rate has moved to 1.15 USD/EUR. The loan's
 * face amount hasn't changed in EUR — this is a pure remeasurement, not a new
 * borrowing — but its reporting-currency carrying value has:
 *   100,000 * 1.15 = $115,000
 * Hand check: FX loss = $115,000 - $110,000 = $5,000. It's a LOSS, not a gain, because
 * the liability grew in reporting-currency terms — the entity now owes more dollars to
 * settle the same euro-denominated debt.
 */
const balances = [
  { periodStart: "2025-01-01", periodEnd: "2025-01-01", label: "Issuance", foreignBalance: money(100000), spotRate: money("1.10") },
  { periodStart: "2025-01-01", periodEnd: "2025-12-31", label: "FY2025", foreignBalance: money(100000), spotRate: money("1.15") },
];

test("buildFxRemeasurementSchedule: opening row establishes carrying value with zero P&L impact", () => {
  const schedule = buildFxRemeasurementSchedule({ foreignCurrency: "EUR", instrumentKind: "liability", balances });
  assert.equal(schedule[0].amount.toFixed(2), "0.00");
  assert.equal(schedule[0].endingBalance!.toFixed(2), "110000.00");
  assert.equal(schedule[0].currency, "USD"); // default reporting currency
});

test("buildFxRemeasurementSchedule: liability — spot rate increase produces a remeasurement LOSS", () => {
  const schedule = buildFxRemeasurementSchedule({ foreignCurrency: "EUR", instrumentKind: "liability", balances });
  assert.equal(schedule[1].amount.toFixed(2), "5000.00"); // positive = loss, per this module's sign convention
  assert.equal(schedule[1].endingBalance!.toFixed(2), "115000.00");
});

test("buildFxRemeasurementSchedule: the same rate movement on an ASSET produces a GAIN instead", () => {
  const schedule = buildFxRemeasurementSchedule({ foreignCurrency: "EUR", instrumentKind: "asset", balances });
  // Same €100k balance, same rate move (1.10 -> 1.15) — but for an asset (e.g. a EUR-
  // denominated receivable), a stronger euro means the asset is now worth MORE in USD,
  // which is a gain, not a loss. Negative amount = gain, per this module's convention.
  assert.equal(schedule[1].amount.toFixed(2), "-5000.00");
});

test("buildFxRemeasurementSchedule: respects a non-default reporting currency", () => {
  const schedule = buildFxRemeasurementSchedule({
    foreignCurrency: "EUR",
    reportingCurrency: "GBP",
    instrumentKind: "liability",
    balances,
  });
  assert.equal(schedule[0].currency, "GBP");
  assert.equal(schedule[1].currency, "GBP");
});

test("fxRemeasurementEntry: books a liability's FX loss as Dr FX Transaction Loss / Cr the liability", () => {
  const schedule = buildFxRemeasurementSchedule({ foreignCurrency: "EUR", instrumentKind: "liability", balances });
  const entry = fxRemeasurementEntry(schedule[1], "liability");
  const lossLine = entry.lines.find((l) => l.account === "Foreign Currency Transaction Gain/Loss");
  const liabilityLine = entry.lines.find((l) => l.account !== "Foreign Currency Transaction Gain/Loss");
  assert.equal(lossLine?.debit?.toFixed(2), "5000.00");
  assert.equal(liabilityLine?.credit?.toFixed(2), "5000.00"); // a liability grows on the credit side
});

test("fxRemeasurementEntry: books an asset's FX gain as Dr the asset / Cr Foreign Currency Transaction Gain/Loss", () => {
  const schedule = buildFxRemeasurementSchedule({ foreignCurrency: "EUR", instrumentKind: "asset", balances });
  const entry = fxRemeasurementEntry(schedule[1], "asset");
  const gainLine = entry.lines.find((l) => l.account === "Foreign Currency Transaction Gain/Loss");
  const assetLine = entry.lines.find((l) => l.account !== "Foreign Currency Transaction Gain/Loss");
  assert.equal(gainLine?.credit?.toFixed(2), "5000.00");
  assert.equal(assetLine?.debit?.toFixed(2), "5000.00"); // an asset grows on the debit side
});

test("fxRemeasurementEntry: every generated entry balances and carries the reporting currency", () => {
  const schedule = buildFxRemeasurementSchedule({ foreignCurrency: "EUR", instrumentKind: "liability", balances });
  for (const row of schedule) {
    // fxRemeasurementEntry calls assertBalanced internally — this throws if any row
    // produces an unbalanced entry, which is the real assertion here.
    const entry = fxRemeasurementEntry(row, "liability");
    assert.equal(entry.currency, "USD");
  }
});
