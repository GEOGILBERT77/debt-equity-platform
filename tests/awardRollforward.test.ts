import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAwardRollforward, AwardRollforwardInput } from "../src/lib/accounting/awardRollforward.js";

function baseInput(overrides: Partial<AwardRollforwardInput> = {}): AwardRollforwardInput {
  return {
    awardType: "STOCK_OPTION",
    conditionClass: "ALL",
    periodStart: "2025-01-01",
    periodEnd: "2025-12-31",
    instruments: [],
    exerciseEvents: [],
    forfeitureEvents: [],
    ...overrides,
  };
}

test("buildAwardRollforward: STOCK_OPTION — a grant before the period, an exercise and a forfeiture inside it", () => {
  const result = buildAwardRollforward(
    baseInput({
      instruments: [
        { instrumentId: "opt-1", grantDate: "2023-06-01", quantity: 10000, conditionType: "service", strikePrice: 5 },
      ],
      exerciseEvents: [{ instrumentId: "opt-1", exerciseDate: "2025-03-01", quantityExercised: 2000, exercisePricePerShare: 5 }],
      forfeitureEvents: [{ instrumentId: "opt-1", forfeitureDate: "2025-06-01", quantityForfeited: 500, eventType: "FORFEITED" }],
    })
  );
  assert.equal(result.outstandingAtStart.toFixed(2), "10000.00");
  assert.equal(result.granted.toFixed(2), "0.00");
  assert.equal(result.reduced.toFixed(2), "2000.00");
  assert.equal(result.reducedLabel, "Exercised");
  assert.equal(result.forfeited.toFixed(2), "500.00");
  assert.equal(result.expired.toFixed(2), "0.00");
  // 10000 - 2000 - 500 = 7500
  assert.equal(result.outstandingAtEnd.toFixed(2), "7500.00");
  assert.equal(result.instrumentCount, 1);
  assert.equal(result.warnings.length, 0);
});

test("buildAwardRollforward: STOCK_OPTION — a grant made mid-period counts as an addition, not a beginning balance", () => {
  const result = buildAwardRollforward(
    baseInput({
      instruments: [{ instrumentId: "opt-2", grantDate: "2025-04-01", quantity: 3000, conditionType: "service", strikePrice: 8 }],
    })
  );
  assert.equal(result.outstandingAtStart.toFixed(2), "0.00");
  assert.equal(result.granted.toFixed(2), "3000.00");
  assert.equal(result.outstandingAtEnd.toFixed(2), "3000.00");
});

test("buildAwardRollforward: STOCK_OPTION — a grant issued after periodEnd is excluded entirely", () => {
  const result = buildAwardRollforward(
    baseInput({
      instruments: [{ instrumentId: "opt-3", grantDate: "2026-01-15", quantity: 999, conditionType: "service", strikePrice: 1 }],
    })
  );
  assert.equal(result.instrumentCount, 0);
  assert.equal(result.outstandingAtEnd.toFixed(2), "0.00");
});

test("buildAwardRollforward: conditionClass filters STOCK_OPTION grants by their vesting condition type", () => {
  const instruments: AwardRollforwardInput["instruments"] = [
    { instrumentId: "svc", grantDate: "2024-01-01", quantity: 1000, conditionType: "service", strikePrice: 5 },
    { instrumentId: "perf", grantDate: "2024-01-01", quantity: 2000, conditionType: "performance", strikePrice: 5 },
    { instrumentId: "mkt", grantDate: "2024-01-01", quantity: 4000, conditionType: "market", strikePrice: 5 },
  ];
  const serviceOnly = buildAwardRollforward(baseInput({ instruments, conditionClass: "service" }));
  assert.equal(serviceOnly.outstandingAtStart.toFixed(2), "1000.00");

  const all = buildAwardRollforward(baseInput({ instruments, conditionClass: "ALL" }));
  assert.equal(all.outstandingAtStart.toFixed(2), "7000.00");
});

test("buildAwardRollforward: RSU — vesting tranches reduce the unvested balance, not an exercise event", () => {
  const result = buildAwardRollforward(
    baseInput({
      awardType: "RSU",
      instruments: [
        {
          instrumentId: "rsu-1",
          grantDate: "2024-01-01",
          quantity: 4000,
          conditionType: "service",
          grantDateFairValuePerUnit: 12,
          tranches: [
            { vestDate: "2024-06-01", quantity: 1000 }, // before periodStart
            { vestDate: "2025-06-01", quantity: 1000 }, // inside the period
            { vestDate: "2026-06-01", quantity: 1000 }, // after periodEnd — not yet vested
          ],
        },
      ],
    })
  );
  assert.equal(result.reducedLabel, "Vested");
  // Granted 4000, one tranche (1000) vested before periodStart => beginning balance 3000.
  assert.equal(result.outstandingAtStart.toFixed(2), "3000.00");
  // One more tranche (1000) vests inside the period.
  assert.equal(result.reduced.toFixed(2), "1000.00");
  assert.equal(result.outstandingAtEnd.toFixed(2), "2000.00");
});

test("buildAwardRollforward: RSU with a performance/market filter matches nothing and explains why", () => {
  const result = buildAwardRollforward(
    baseInput({
      awardType: "RSU",
      conditionClass: "performance",
      instruments: [{ instrumentId: "rsu-2", grantDate: "2024-01-01", quantity: 500, conditionType: "service", tranches: [] }],
    })
  );
  assert.equal(result.instrumentCount, 0);
  assert.ok(result.warnings.some((w) => w.includes("always service-condition")));
});

test("buildAwardRollforward: weighted-average exercise price rolls forward using real per-exercise prices", () => {
  const result = buildAwardRollforward(
    baseInput({
      instruments: [{ instrumentId: "opt-4", grantDate: "2023-01-01", quantity: 1000, conditionType: "service", strikePrice: 10 }],
      exerciseEvents: [{ instrumentId: "opt-4", exerciseDate: "2025-05-01", quantityExercised: 200, exercisePricePerShare: 10 }],
    })
  );
  assert.equal(result.priceAtStart.toFixed(2), "10.00");
  // 1000*10 - 200*10 = 8000; 8000/800 = 10 (unchanged since exercise price == grant price here)
  assert.equal(result.priceAtEnd.toFixed(2), "10.00");
});

test("buildAwardRollforward: a grant missing its strike price is still counted in shares but flagged as excluded from the price roll", () => {
  const result = buildAwardRollforward(
    baseInput({
      instruments: [{ instrumentId: "opt-5", grantDate: "2023-01-01", quantity: 500, conditionType: "service" }],
    })
  );
  assert.equal(result.outstandingAtStart.toFixed(2), "500.00");
  assert.ok(result.warnings.some((w) => w.includes("strike price")));
});
