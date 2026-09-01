import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCashExercise,
  buildCashExerciseEntry,
  computeNetShareSettlement,
  buildNetShareSettlementEntry,
  buildTaxWithholdingRemittanceEntry,
} from "../src/lib/accounting/optionSettlement.js";

// Every scenario below is hand-computed — see optionSettlement.ts's module doc comment
// for the accounting methodology each test exercises.

test("cash exercise: cash paid + previously-recognized grant-date value both flow into Common Stock", () => {
  const result = computeCashExercise({
    exerciseDate: "2026-06-15",
    quantityExercised: 10_000,
    exercisePricePerUnit: 2, // $20,000 cash
    grantDateFairValuePerUnit: 5, // $50,000 already recognized via vesting.ts
  });
  assert.equal(result.cashReceived.toFixed(2), "20000.00");
  assert.equal(result.apicReclassified.toFixed(2), "50000.00");
  assert.equal(result.commonStockIssued.toFixed(2), "70000.00");

  const entry = buildCashExerciseEntry({
    exerciseDate: "2026-06-15",
    quantityExercised: 10_000,
    exercisePricePerUnit: 2,
    grantDateFairValuePerUnit: 5,
  });
  const cashLine = entry.lines.find((l) => l.account === "Cash")!;
  const apicLine = entry.lines.find((l) => l.account === "Additional Paid-In Capital")!;
  const commonLine = entry.lines.find((l) => l.account === "Common Stock")!;
  assert.equal(cashLine.debit!.toFixed(2), "20000.00");
  assert.equal(apicLine.debit!.toFixed(2), "50000.00");
  assert.equal(commonLine.credit!.toFixed(2), "70000.00");
  const totalDebits = cashLine.debit!.plus(apicLine.debit!);
  assert.equal(totalDebits.toFixed(2), commonLine.credit!.toFixed(2));
});

test("cash exercise: zero grant-date value (e.g. a fully-expensed award tracked elsewhere) omits the APIC reclass line", () => {
  const entry = buildCashExerciseEntry({
    exerciseDate: "2026-06-15",
    quantityExercised: 1_000,
    exercisePricePerUnit: 10,
    grantDateFairValuePerUnit: 0,
  });
  assert.equal(entry.lines.some((l) => l.account === "Additional Paid-In Capital"), false);
  const cashLine = entry.lines.find((l) => l.account === "Cash")!;
  const commonLine = entry.lines.find((l) => l.account === "Common Stock")!;
  assert.equal(cashLine.debit!.toFixed(2), "10000.00");
  assert.equal(commonLine.credit!.toFixed(2), "10000.00");
});

test("net share settlement: RSU (exercisePricePerUnit = 0) with tax withholding", () => {
  // 10,000 gross RSUs vest, FMV $10/share = $100,000 gross value. Tax withholding
  // obligation is $37,000 -> 3,700 shares withheld at $10. Net shares issued = 6,300.
  const result = computeNetShareSettlement({
    settlementDate: "2026-03-01",
    grossQuantity: 10_000,
    exercisePricePerUnit: 0,
    fairMarketValuePerUnitAtSettlement: 10,
    taxWithholdingAmount: 37_000,
  });
  assert.equal(result.sharesUsedForExercisePrice.toFixed(0), "0");
  assert.equal(result.sharesWithheldForTax.toFixed(0), "3700");
  assert.equal(result.netSharesIssued.toFixed(0), "6300");
  assert.equal(result.commonStockIssued.toFixed(2), "63000.00");
  assert.equal(result.taxWithholdingLiability.toFixed(2), "37000.00");
  assert.equal(result.apicRelieved.toFixed(2), "100000.00"); // (6,300 + 3,700) * $10

  const entry = buildNetShareSettlementEntry({
    settlementDate: "2026-03-01",
    grossQuantity: 10_000,
    exercisePricePerUnit: 0,
    fairMarketValuePerUnitAtSettlement: 10,
    taxWithholdingAmount: 37_000,
  });
  const apicLine = entry.lines.find((l) => l.account === "Additional Paid-In Capital")!;
  const commonLine = entry.lines.find((l) => l.account === "Common Stock")!;
  const payableLine = entry.lines.find((l) => l.account === "Payroll Tax Withholding Payable")!;
  assert.equal(apicLine.debit!.toFixed(2), "100000.00");
  assert.equal(commonLine.credit!.toFixed(2), "63000.00");
  assert.equal(payableLine.credit!.toFixed(2), "37000.00");
  assert.equal(commonLine.credit!.plus(payableLine.credit!).toFixed(2), apicLine.debit!.toFixed(2));
});

test("net share settlement: stock option cashless net exercise with exercise price AND tax withholding", () => {
  // 5,000 options, strike $2, FMV at exercise $12. Exercise-price value = $10,000 ->
  // 833.33 shares -> rounds to 833 shares used to cover it. Tax withholding $18,000 ->
  // 1,500 shares withheld. Net shares issued = 5,000 - 833 - 1,500 = 2,667.
  const result = computeNetShareSettlement({
    settlementDate: "2026-07-01",
    grossQuantity: 5_000,
    exercisePricePerUnit: 2,
    fairMarketValuePerUnitAtSettlement: 12,
    taxWithholdingAmount: 18_000,
  });
  assert.equal(result.sharesUsedForExercisePrice.toFixed(0), "833");
  assert.equal(result.sharesWithheldForTax.toFixed(0), "1500");
  assert.equal(result.netSharesIssued.toFixed(0), "2667");

  const entry = buildNetShareSettlementEntry({
    settlementDate: "2026-07-01",
    grossQuantity: 5_000,
    exercisePricePerUnit: 2,
    fairMarketValuePerUnitAtSettlement: 12,
    taxWithholdingAmount: 18_000,
  });
  const totalDebits = entry.lines.reduce((s, l) => s.plus(l.debit ?? 0), result.apicRelieved.minus(result.apicRelieved));
  const totalCredits = entry.lines.reduce((s, l) => s.plus(l.credit ?? 0), result.apicRelieved.minus(result.apicRelieved));
  assert.equal(totalDebits.toFixed(2), totalCredits.toFixed(2));
});

test("net share settlement: no tax withholding and no exercise price issues the full gross quantity", () => {
  const result = computeNetShareSettlement({
    settlementDate: "2026-01-01",
    grossQuantity: 1_000,
    exercisePricePerUnit: 0,
    fairMarketValuePerUnitAtSettlement: 25,
  });
  assert.equal(result.netSharesIssued.toFixed(0), "1000");
  assert.equal(result.sharesWithheldForTax.toFixed(0), "0");
  assert.equal(result.commonStockIssued.toFixed(2), "25000.00");
  assert.equal(result.taxWithholdingLiability.toFixed(2), "0.00");
});

test("net share settlement: throws when exercise price + withholding exceed the award's value", () => {
  assert.throws(() =>
    computeNetShareSettlement({
      settlementDate: "2026-01-01",
      grossQuantity: 100,
      exercisePricePerUnit: 5,
      fairMarketValuePerUnitAtSettlement: 6,
      taxWithholdingAmount: 550, // 500 (exercise) + 550 (tax) worth of shares > 600 gross value
    })
  );
});

test("net share settlement: throws on a zero fair market value (can't convert a dollar withholding into a share count)", () => {
  assert.throws(() =>
    computeNetShareSettlement({
      settlementDate: "2026-01-01",
      grossQuantity: 100,
      exercisePricePerUnit: 0,
      fairMarketValuePerUnitAtSettlement: 0,
      taxWithholdingAmount: 100,
    })
  );
});

test("tax withholding remittance entry clears the payable against cash and balances", () => {
  const entry = buildTaxWithholdingRemittanceEntry("2026-03-15", 37_000);
  const payableLine = entry.lines.find((l) => l.account === "Payroll Tax Withholding Payable")!;
  const cashLine = entry.lines.find((l) => l.account === "Cash")!;
  assert.equal(payableLine.debit!.toFixed(2), "37000.00");
  assert.equal(cashLine.credit!.toFixed(2), "37000.00");
});
