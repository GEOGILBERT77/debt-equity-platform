import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateIso100kAcrossExercises } from "../src/lib/accounting/optionTaxCompliance.js";

/**
 * Grant: FMV at grant = $20/share, so $100,000 / $20 = 5,000 shares is the annual cap
 * in share terms. Two tranches vest in the SAME calendar year: 3,000 shares (Jan) and
 * 4,000 shares (Jul) = 7,000 total, exceeding the 5,000-share cap by 2,000 shares.
 * Tranche 1 (3,000 sh, $60k) fits entirely under the cap. Tranche 2 (4,000 sh, $80k):
 * cumulative would be $140k, and only $40k of room is left (100k - 60k) — 40k/80k =
 * 50% of tranche 2 is ISO-qualified (2,000 sh), the other 2,000 sh recharacterized NSO.
 */
const grant = {
  instrumentId: "inst_1",
  grantDate: "2024-01-01",
  grantDateFmvPerShare: 20,
  tranches: [
    { id: "t1", vestDate: "2026-01-01", quantity: 3000 },
    { id: "t2", vestDate: "2026-07-01", quantity: 4000 },
  ],
};

test("allocateIso100kAcrossExercises: a single exercise for the grant's full vested quantity gets exactly the $100k-capped ISO amount", () => {
  const result = allocateIso100kAcrossExercises([grant], [
    { exerciseEventId: "ex_1", instrumentId: "inst_1", exerciseDate: "2026-08-01", quantityExercised: 7000 },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].iso100kQualifiedQuantity.toFixed(0), "5000");
});

test("allocateIso100kAcrossExercises: an exercise that straddles a tranche boundary gets the exact proportional ISO split, not a whole-tranche approximation", () => {
  const result = allocateIso100kAcrossExercises([grant], [
    { exerciseEventId: "ex_A", instrumentId: "inst_1", exerciseDate: "2026-08-01", quantityExercised: 2000 },
    { exerciseEventId: "ex_B", instrumentId: "inst_1", exerciseDate: "2026-09-01", quantityExercised: 5000 },
  ]);
  const a = result.find((r) => r.exerciseEventId === "ex_A")!;
  const b = result.find((r) => r.exerciseEventId === "ex_B")!;
  // A: 2000 sh, all drawn from tranche 1 (100% ISO) -> 2000 ISO.
  assert.equal(a.iso100kQualifiedQuantity.toFixed(0), "2000");
  // B: 5000 sh = remaining 1000 from tranche 1 (ISO) + 4000 from tranche 2 (50% ISO = 2000) -> 3000 ISO.
  assert.equal(b.iso100kQualifiedQuantity.toFixed(0), "3000");
  // Split-exercise total must exactly match the single-exercise total (5000).
  assert.equal(a.iso100kQualifiedQuantity.plus(b.iso100kQualifiedQuantity).toFixed(0), "5000");
});

test("allocateIso100kAcrossExercises: an over-exercise (more shares claimed than ever vested) caps ISO-qualified quantity rather than erroring", () => {
  const result = allocateIso100kAcrossExercises([grant], [
    { exerciseEventId: "ex_over", instrumentId: "inst_1", exerciseDate: "2026-08-01", quantityExercised: 9000 },
  ]);
  assert.equal(result[0].iso100kQualifiedQuantity.toFixed(0), "5000");
});

test("allocateIso100kAcrossExercises: cross-grant $100k aggregation follows GRANT-DATE order (IRC 422(d)), not tranche vest-date order", () => {
  // Grant 2 is granted LATER than `grant` but its one tranche VESTS earlier than
  // grant's second tranche — the statute orders by grant date regardless.
  const grant2 = {
    instrumentId: "inst_2",
    grantDate: "2024-06-01",
    grantDateFmvPerShare: 20,
    tranches: [{ id: "g2t1", vestDate: "2026-03-01", quantity: 3000 }],
  };
  const result = allocateIso100kAcrossExercises(
    [grant, grant2],
    [
      { exerciseEventId: "ex_g1_t1", instrumentId: "inst_1", exerciseDate: "2026-08-01", quantityExercised: 3000 },
      { exerciseEventId: "ex_g1_t2", instrumentId: "inst_1", exerciseDate: "2026-08-01", quantityExercised: 4000 },
      { exerciseEventId: "ex_g2", instrumentId: "inst_2", exerciseDate: "2026-08-01", quantityExercised: 3000 },
    ]
  );
  const g1t1 = result.find((r) => r.exerciseEventId === "ex_g1_t1")!;
  const g1t2 = result.find((r) => r.exerciseEventId === "ex_g1_t2")!;
  const g2 = result.find((r) => r.exerciseEventId === "ex_g2")!;
  assert.equal(g1t1.iso100kQualifiedQuantity.toFixed(0), "3000");
  assert.equal(g1t2.iso100kQualifiedQuantity.toFixed(0), "2000");
  // The later-GRANTED grant gets zero ISO once the earlier grant's tranches (by grant
  // date, not vest date) have already exhausted the cap.
  assert.equal(g2.iso100kQualifiedQuantity.toFixed(0), "0");
});
