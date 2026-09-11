import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDisposition,
  computeDisqualifyingDispositionOrdinaryIncome,
  computeNsoExerciseOrdinaryIncome,
  computeForm3921Data,
  classifyRestrictedTransferForFiling,
  classifyExerciseForFiling,
  buildMonthlyComplianceReport,
  ExerciseForCompliance,
} from "../src/lib/accounting/optionTaxCompliance.js";

test("classifyDisposition: qualifying requires STRICTLY more than 2yr-from-grant AND 1yr-from-exercise", () => {
  assert.equal(
    classifyDisposition({ grantDate: "2024-01-01", exerciseDate: "2025-01-01", dispositionDate: "2026-01-02" }).qualifying,
    true
  );
  // Exactly on the mark does NOT qualify — "more than," not "at least."
  assert.equal(
    classifyDisposition({ grantDate: "2024-01-01", exerciseDate: "2025-01-01", dispositionDate: "2026-01-01" }).qualifying,
    false
  );
  // Past the grant mark but not yet past the exercise mark — still disqualifying.
  assert.equal(
    classifyDisposition({ grantDate: "2024-01-01", exerciseDate: "2025-06-01", dispositionDate: "2026-03-01" }).qualifying,
    false
  );
});

test("computeDisqualifyingDispositionOrdinaryIncome: ordinary income is the LESSER of bargain element and actual gain", () => {
  // Stock appreciated further after exercise: capped at the bargain element.
  const higher = computeDisqualifyingDispositionOrdinaryIncome({
    exercisePricePerShare: 1,
    fairMarketValuePerShareAtExercise: 5,
    salePricePerShare: 8,
    quantitySold: 100,
  });
  assert.equal(higher.totalOrdinaryIncome.toFixed(2), "400.00");

  // Stock DROPPED after exercise: capped at the actual (smaller) gain, not the bargain element.
  const lower = computeDisqualifyingDispositionOrdinaryIncome({
    exercisePricePerShare: 1,
    fairMarketValuePerShareAtExercise: 5,
    salePricePerShare: 3,
    quantitySold: 100,
  });
  assert.equal(lower.totalOrdinaryIncome.toFixed(2), "200.00");

  // Sold at or below exercise price: zero ordinary income, never negative.
  const atCost = computeDisqualifyingDispositionOrdinaryIncome({
    exercisePricePerShare: 1,
    fairMarketValuePerShareAtExercise: 5,
    salePricePerShare: 1,
    quantitySold: 100,
  });
  assert.equal(atCost.totalOrdinaryIncome.toFixed(2), "0.00");
});

test("computeNsoExerciseOrdinaryIncome: bargain element times quantity", () => {
  const result = computeNsoExerciseOrdinaryIncome({
    exercisePricePerShare: 1,
    fairMarketValuePerShareAtExercise: 6,
    quantityExercised: 500,
  });
  assert.equal(result.totalOrdinaryIncome.toFixed(2), "2500.00");
});

test("computeForm3921Data: refuses to assemble with a missing transferor EIN/address or recipient TIN/address", () => {
  const result = computeForm3921Data({
    entity: { name: "Acme", address: null, employerIdentificationNumber: null },
    stakeholder: { name: "Jane", address: "1 Main St", taxIdNumber: "123-45-6789" },
    grantDate: "2025-01-01",
    exerciseDate: "2026-03-15",
    exercisePricePerShare: 1,
    fairMarketValuePerShareAtExercise: 5,
    isoQualifiedSharesTransferred: 1000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.missingFields.length, 2);
  }
});

test("computeForm3921Data: assembles correctly and computes the real IRS deadlines (Jan 31 / Feb 28 / Mar 31 of the following year)", () => {
  const result = computeForm3921Data({
    entity: { name: "Acme Robotics, Inc.", address: "1 Robotics Way, Palo Alto, CA", employerIdentificationNumber: "12-3456789" },
    stakeholder: { name: "Jane Doe", address: "2 Employee Ln", taxIdNumber: "123-45-6789" },
    grantDate: "2025-01-01",
    exerciseDate: "2026-03-15",
    exercisePricePerShare: 1,
    fairMarketValuePerShareAtExercise: 5,
    isoQualifiedSharesTransferred: 1000,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.taxYear, 2026);
    assert.equal(result.data.furnishToEmployeeDeadline, "2027-01-31");
    assert.equal(result.data.irsPaperFilingDeadline, "2027-02-28");
    assert.equal(result.data.irsElectronicFilingDeadline, "2027-03-31");
    assert.equal(result.data.sharesTransferred.toFixed(0), "1000");
  }
});

test("classifyRestrictedTransferForFiling: 83(b) deadline is exactly 30 days after transfer", () => {
  const obligation = classifyRestrictedTransferForFiling({
    instrumentId: "inst_1",
    stakeholderId: "sh_1",
    transferDate: "2026-01-15",
  });
  assert.equal(obligation.deadline, "2026-02-14");
  assert.equal(obligation.filingType, "ELECTION_83B_DEADLINE");
});

const baseIsoExercise: ExerciseForCompliance = {
  exerciseEventId: "oee_1",
  instrumentId: "inst_1",
  stakeholderId: "sh_1",
  isIncentiveStockOption: true,
  grantDate: "2025-01-01",
  exerciseDate: "2026-03-15",
  quantityExercised: 1000,
  exercisePricePerShare: 1,
  fairMarketValuePerShareAtExercise: 5,
  dispositions: [],
};

test("classifyExerciseForFiling: pure ISO exercise with no disposition produces exactly one FORM_3921 obligation carrying the AMT preference", () => {
  const obligations = classifyExerciseForFiling(baseIsoExercise);
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].filingType, "FORM_3921");
  assert.equal(obligations[0].amount?.toFixed(2), "4000.00");
});

test("classifyExerciseForFiling: $100k rule partial recharacterization splits into FORM_3921 + W2_NSO_EXERCISE_INCOME", () => {
  const obligations = classifyExerciseForFiling({ ...baseIsoExercise, iso100kQualifiedQuantity: 600 });
  assert.equal(obligations.length, 2);
  const form3921 = obligations.find((o) => o.filingType === "FORM_3921")!;
  const nso = obligations.find((o) => o.filingType === "W2_NSO_EXERCISE_INCOME")!;
  assert.ok(form3921.description.includes("600"));
  assert.equal(nso.amount?.toFixed(2), "1600.00"); // 400 recharacterized shares * $4 bargain element
});

test("classifyExerciseForFiling: a same-calendar-year disqualifying disposition creates a W2 obligation AND zeroes the FORM_3921 AMT preference", () => {
  const obligations = classifyExerciseForFiling({
    ...baseIsoExercise,
    dispositions: [{ dispositionDate: "2026-06-01", quantitySold: 1000, salePricePerShare: 8 }],
  });
  assert.equal(obligations.length, 2);
  const disqualifying = obligations.find((o) => o.filingType === "W2_ISO_DISQUALIFYING_DISPOSITION")!;
  const form3921 = obligations.find((o) => o.filingType === "FORM_3921")!;
  assert.equal(disqualifying.amount?.toFixed(2), "4000.00"); // lesser(bargain=4, gain=7) * 1000
  assert.equal(form3921.amount?.toFixed(2), "0.00"); // IRC 56(b)(3) same-year exception
});

test("classifyExerciseForFiling: a later QUALIFYING disposition creates no disqualifying-disposition obligation and leaves the AMT preference intact", () => {
  const obligations = classifyExerciseForFiling({
    ...baseIsoExercise,
    dispositions: [{ dispositionDate: "2028-06-01", quantitySold: 1000, salePricePerShare: 8 }],
  });
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].filingType, "FORM_3921");
  assert.equal(obligations[0].amount?.toFixed(2), "4000.00");
});

test("classifyExerciseForFiling: a pure NSO exercise produces exactly one W2_NSO_EXERCISE_INCOME obligation", () => {
  const obligations = classifyExerciseForFiling({
    exerciseEventId: "oee_2",
    instrumentId: "inst_2",
    stakeholderId: "sh_1",
    isIncentiveStockOption: false,
    grantDate: "2025-01-01",
    exerciseDate: "2026-03-15",
    quantityExercised: 200,
    exercisePricePerShare: 1,
    fairMarketValuePerShareAtExercise: 5,
    dispositions: [],
  });
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].filingType, "W2_NSO_EXERCISE_INCOME");
  assert.equal(obligations[0].amount?.toFixed(2), "800.00");
});

test("buildMonthlyComplianceReport: flags an obligation as due only in its actual deadline month, and reconciles against existing FILED records", () => {
  const dueMonth = buildMonthlyComplianceReport("2027-01", [baseIsoExercise], [], []);
  assert.equal(dueMonth.rows.length, 1);
  assert.equal(dueMonth.rows[0].dueThisMonth, true);
  assert.equal(dueMonth.actionableThisMonth.length, 1);

  const otherMonth = buildMonthlyComplianceReport("2027-02", [baseIsoExercise], [], []);
  assert.equal(otherMonth.rows[0].dueThisMonth, false);

  const alreadyFiled = buildMonthlyComplianceReport(
    "2027-01",
    [baseIsoExercise],
    [],
    [{ id: "tfr_1", filingType: "FORM_3921", taxYear: 2026, exerciseEventId: "oee_1", instrumentId: null, status: "FILED" }]
  );
  assert.equal(alreadyFiled.actionableThisMonth.length, 0);
});
