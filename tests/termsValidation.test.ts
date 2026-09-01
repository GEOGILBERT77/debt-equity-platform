import test from "node:test";
import assert from "node:assert/strict";
import { validateInstrumentTerms, TermsValidationError } from "../src/lib/accounting/termsValidation.js";

/**
 * Verifies termsValidation.ts against exactly the shapes the real engines expect (see
 * ServiceConditionGrant in vesting.ts, TermDebtInputs/PikDebtInputs/RevolverInputs in
 * debtAmortization.ts, ConventionalConvertibleNoteInputs in convertibleNote.ts, and
 * WarrantInstrumentTerms in dispatch.ts) — a payload that passes here should always be
 * accepted by the corresponding engine, and a payload rejected here should always be
 * one the engine would have failed on (or worse, silently miscomputed).
 */

function issuePaths(err: unknown): string[] {
  assert.ok(err instanceof TermsValidationError);
  return err.issues.map((i) => i.path);
}

test("validateInstrumentTerms: STOCK_OPTION/RSU accepts a well-formed ServiceConditionGrant", () => {
  const grant = {
    grantDate: "2025-01-01",
    quantity: "6000",
    grantDateFairValuePerUnit: "2",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2026-01-01", quantity: "3000" },
      { id: "t2", vestDate: "2027-01-01", quantity: "3000" },
    ],
  };
  assert.doesNotThrow(() => validateInstrumentTerms("STOCK_OPTION", grant));
  assert.doesNotThrow(() => validateInstrumentTerms("RSU", grant));
});

test("validateInstrumentTerms: STOCK_OPTION rejects a missing quantity, bad date, invalid attributionMethod, and empty tranches all at once", () => {
  const bad = {
    grantDate: "not-a-date",
    // quantity missing entirely
    grantDateFairValuePerUnit: "2",
    attributionMethod: "immediate", // not a valid value
    tranches: [],
  };
  assert.throws(() => validateInstrumentTerms("STOCK_OPTION", bad), TermsValidationError);
  try {
    validateInstrumentTerms("STOCK_OPTION", bad);
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.ok(paths.includes("grantDate"));
    assert.ok(paths.includes("quantity"));
    assert.ok(paths.includes("attributionMethod"));
    assert.ok(paths.includes("tranches"));
    // All four problems reported together, not just the first one encountered.
    assert.equal(paths.length, 4);
  }
});

test("validateInstrumentTerms: STOCK_OPTION rejects a malformed tranche with a path pointing at exactly which one and which field", () => {
  const bad = {
    grantDate: "2025-01-01",
    quantity: "12000",
    grantDateFairValuePerUnit: "2",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2026-01-01", quantity: "3000" },
      { id: "t2", vestDate: "not-a-date", quantity: "3000" },
    ],
  };
  try {
    validateInstrumentTerms("STOCK_OPTION", bad);
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.deepEqual(paths, ["tranches[1].vestDate"]);
  }
});

test("validateInstrumentTerms: STOCK_OPTION rejects tranche quantities that don't sum to the grant's total (the most common hand-typed-grant mistake)", () => {
  const mismatched = {
    grantDate: "2025-01-01",
    quantity: "12000", // tranches below only sum to 9000
    grantDateFairValuePerUnit: "2",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2026-01-01", quantity: "3000" },
      { id: "t2", vestDate: "2027-01-01", quantity: "3000" },
      { id: "t3", vestDate: "2028-01-01", quantity: "3000" },
    ],
  };
  try {
    validateInstrumentTerms("STOCK_OPTION", mismatched);
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.deepEqual(paths, ["tranches"]);
    assert.match((err as TermsValidationError).issues[0].message, /9000.*12000/);
  }
});

test("validateInstrumentTerms: STOCK_OPTION rejects a tranche that vests on or before the grant date", () => {
  const bad = {
    grantDate: "2025-01-01",
    quantity: "6000",
    grantDateFairValuePerUnit: "2",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2025-01-01", quantity: "3000" }, // same day as grant — invalid
      { id: "t2", vestDate: "2027-01-01", quantity: "3000" },
    ],
  };
  try {
    validateInstrumentTerms("STOCK_OPTION", bad);
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["tranches[0].vestDate"]);
  }
});

test("validateInstrumentTerms: a grant whose tranches are individually well-formed and correctly summed passes cleanly with three tranches", () => {
  const grant = {
    grantDate: "2025-01-01",
    quantity: "9000",
    grantDateFairValuePerUnit: "2",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2026-01-01", quantity: "3000" },
      { id: "t2", vestDate: "2027-01-01", quantity: "3000" },
      { id: "t3", vestDate: "2028-01-01", quantity: "3000" },
    ],
  };
  assert.doesNotThrow(() => validateInstrumentTerms("STOCK_OPTION", grant));
});

test("validateInstrumentTerms: TERM_LOAN accepts a well-formed TermDebtInputs and rejects a non-numeric faceValue plus a malformed cash flow", () => {
  const good = {
    faceValue: "500000",
    netProceeds: "490000",
    effectiveAnnualYield: "0.06",
    cashFlows: [{ date: "2026-12-31", amount: "15000" }],
  };
  assert.doesNotThrow(() => validateInstrumentTerms("TERM_LOAN", good));

  const bad = {
    faceValue: "not a number",
    netProceeds: "490000",
    effectiveAnnualYield: "0.06",
    cashFlows: [{ date: "2026-12-31", amount: "not a number either" }],
  };
  try {
    validateInstrumentTerms("TERM_LOAN", bad);
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.ok(paths.includes("faceValue"));
    assert.ok(paths.includes("cashFlows[0].amount"));
  }
});

test("validateInstrumentTerms: TERM_LOAN rejects out-of-order cashFlows dates (a transposed-rows mistake `buildEffectiveInterestSchedule` would never catch on its own, since it matches cashFlows[i] to periods[i] purely by index and never reads the date field)", () => {
  const outOfOrder = {
    faceValue: "1000000",
    netProceeds: "950000",
    effectiveAnnualYield: "0.07",
    cashFlows: [
      { date: "2027-01-01", amount: "50000" },
      { date: "2026-01-01", amount: "50000" }, // out of order — before the prior entry
      { date: "2028-01-01", amount: "50000" },
    ],
  };
  try {
    validateInstrumentTerms("TERM_LOAN", outOfOrder);
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.ok(paths.includes("cashFlows"));
    const issue = (err as TermsValidationError).issues.find((i) => i.path === "cashFlows")!;
    assert.match(issue.message, /entry 1 \(2026-01-01\) is not after entry 0 \(2027-01-01\)/);
  }

  const duplicate = {
    ...outOfOrder,
    cashFlows: [
      { date: "2026-01-01", amount: "50000" },
      { date: "2026-01-01", amount: "50000" }, // duplicate — not STRICTLY increasing
    ],
  };
  assert.throws(() => validateInstrumentTerms("TERM_LOAN", duplicate), /strictly increasing chronological order/);

  const wellOrdered = {
    ...outOfOrder,
    cashFlows: [
      { date: "2026-01-01", amount: "50000" },
      { date: "2027-01-01", amount: "50000" },
      { date: "2028-01-01", amount: "50000" },
    ],
  };
  assert.doesNotThrow(() => validateInstrumentTerms("TERM_LOAN", wellOrdered));
});

test("validateInstrumentTerms: CONVERTIBLE_NOTE requires everything TERM_LOAN does plus conversionPricePerShare", () => {
  const missingConversionPrice = {
    faceValue: "1000000",
    netProceeds: "950000",
    effectiveAnnualYield: "0.07",
    cashFlows: [{ date: "2027-01-01", amount: "50000" }],
  };
  try {
    validateInstrumentTerms("CONVERTIBLE_NOTE", missingConversionPrice);
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["conversionPricePerShare"]);
  }
});

test("validateInstrumentTerms: PIK_NOTE accepts the minimal two-field shape and rejects a missing rate", () => {
  assert.doesNotThrow(() =>
    validateInstrumentTerms("PIK_NOTE", { initialPrincipal: "250000", annualPikRate: "0.10" })
  );
  try {
    validateInstrumentTerms("PIK_NOTE", { initialPrincipal: "250000" });
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["annualPikRate"]);
  }
});

test("validateInstrumentTerms: REVOLVER requires at least a commitmentFee or deferredFees, and validates the shape of whichever is present", () => {
  try {
    validateInstrumentTerms("REVOLVER", {});
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), [""]);
  }

  assert.doesNotThrow(() =>
    validateInstrumentTerms("REVOLVER", {
      commitmentFee: { totalCommitmentFee: "20000", commitmentStart: "2025-01-01", commitmentEnd: "2027-01-01" },
    })
  );
  assert.doesNotThrow(() =>
    validateInstrumentTerms("REVOLVER", {
      deferredFees: [{ id: "closing", amount: "60000", amortizationStart: "2025-01-01", amortizationEnd: "2027-01-01" }],
    })
  );

  try {
    validateInstrumentTerms("REVOLVER", { commitmentFee: { totalCommitmentFee: "20000" } });
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.ok(paths.includes("commitmentFee.commitmentStart"));
    assert.ok(paths.includes("commitmentFee.commitmentEnd"));
  }
});

test("validateInstrumentTerms: REVOLVER rejects a commitmentEnd on or before commitmentStart, and an amortizationEnd on or before amortizationStart", () => {
  try {
    validateInstrumentTerms("REVOLVER", {
      commitmentFee: { totalCommitmentFee: "20000", commitmentStart: "2027-01-01", commitmentEnd: "2025-01-01" },
    });
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["commitmentFee.commitmentEnd"]);
  }

  try {
    validateInstrumentTerms("REVOLVER", {
      deferredFees: [{ id: "closing", amount: "60000", amortizationStart: "2027-01-01", amortizationEnd: "2027-01-01" }],
    });
    assert.fail("should have thrown");
  } catch (err) {
    // Same day counts as invalid too — allocateStraightLineByElapsedTime needs
    // strictly-positive totalDays (see allocation.ts).
    assert.deepEqual(issuePaths(err), ["deferredFees[0].amortizationEnd"]);
  }
});

test("validateInstrumentTerms: WARRANT requires classification, and only validates remeasurement's shape when present (its requiredness is a dispatch.ts concern, not a shape one)", () => {
  assert.doesNotThrow(() =>
    validateInstrumentTerms("WARRANT", {
      classification: { netCashSettlementPossible: false, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
      sharesIssuable: "5000",
    })
  );

  try {
    validateInstrumentTerms("WARRANT", { classification: { netCashSettlementPossible: "yes" } });
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.ok(paths.includes("classification.netCashSettlementPossible"));
    assert.ok(paths.includes("classification.indexedToOwnStockOnly"));
    assert.ok(paths.includes("classification.hasDownRoundProtection"));
  }

  assert.doesNotThrow(() =>
    validateInstrumentTerms("WARRANT", {
      classification: { netCashSettlementPossible: true, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
      remeasurement: {
        inceptionDate: "2025-01-01",
        inceptionFairValue: "100000",
        observations: [{ date: "2026-01-01", fairValue: "120000" }],
      },
      instrumentAccountName: "Warrant Liability",
    })
  );

  try {
    validateInstrumentTerms("WARRANT", {
      classification: { netCashSettlementPossible: true, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
      remeasurement: { inceptionDate: "2025-01-01", inceptionFairValue: "100000", observations: [] },
    });
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["remeasurement.observations"]);
  }
});

test("validateInstrumentTerms: WARRANT rejects out-of-order remeasurement.observations, and an observation dated on or before inceptionDate (buildFairValueRemeasurementSchedule matches observations[i] to periods[i] by index, throwing only once a real periods array exists at compute time — this catches the same mistake immediately at write time)", () => {
  const outOfOrder = {
    classification: { netCashSettlementPossible: true, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
    remeasurement: {
      inceptionDate: "2025-01-01",
      inceptionFairValue: "100000",
      observations: [
        { date: "2027-01-01", fairValue: "130000" },
        { date: "2026-01-01", fairValue: "120000" }, // out of order
      ],
    },
  };
  try {
    validateInstrumentTerms("WARRANT", outOfOrder);
    assert.fail("should have thrown");
  } catch (err) {
    const issue = (err as TermsValidationError).issues.find((i) => i.path === "remeasurement.observations")!;
    assert.match(issue.message, /entry 1 \(2026-01-01\) is not after entry 0 \(2027-01-01\)/);
  }

  const beforeInception = {
    classification: { netCashSettlementPossible: true, indexedToOwnStockOnly: true, hasDownRoundProtection: false },
    remeasurement: {
      inceptionDate: "2026-06-01",
      inceptionFairValue: "100000",
      observations: [{ date: "2026-01-01", fairValue: "120000" }], // before inceptionDate
    },
  };
  try {
    validateInstrumentTerms("WARRANT", beforeInception);
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["remeasurement.observations[0].date"]);
  }
});

test("validateInstrumentTerms: COMMON_STOCK requires only quantity", () => {
  assert.doesNotThrow(() => validateInstrumentTerms("COMMON_STOCK", { quantity: "100000" }));
  try {
    validateInstrumentTerms("COMMON_STOCK", {});
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["quantity"]);
  }
});

test("validateInstrumentTerms: RESTRICTED_STOCK accepts a well-formed grant (exactly a ServiceConditionGrant plus purchasePricePerShare)", () => {
  assert.doesNotThrow(() =>
    validateInstrumentTerms("RESTRICTED_STOCK", {
      grantDate: "2026-01-01",
      quantity: "4000",
      grantDateFairValuePerUnit: "2.00",
      purchasePricePerShare: "0.01",
      attributionMethod: "straight-line",
      tranches: [
        { id: "t1", vestDate: "2027-01-01", quantity: "2000" },
        { id: "t2", vestDate: "2028-01-01", quantity: "2000" },
      ],
    })
  );
});

test("validateInstrumentTerms: RESTRICTED_STOCK rejects a missing purchasePricePerShare even when every ServiceConditionGrant field is otherwise well-formed", () => {
  try {
    validateInstrumentTerms("RESTRICTED_STOCK", {
      grantDate: "2026-01-01",
      quantity: "4000",
      grantDateFairValuePerUnit: "2.00",
      attributionMethod: "straight-line",
      tranches: [{ id: "t1", vestDate: "2027-01-01", quantity: "4000" }],
    });
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["purchasePricePerShare"]);
  }
});

test("validateInstrumentTerms: RESTRICTED_STOCK reuses ServiceConditionGrant's own checks — a tranche-quantity mismatch and a vestDate-before-grantDate both still get caught", () => {
  try {
    validateInstrumentTerms("RESTRICTED_STOCK", {
      grantDate: "2026-01-01",
      quantity: "4000",
      grantDateFairValuePerUnit: "2.00",
      purchasePricePerShare: "0.01",
      attributionMethod: "straight-line",
      tranches: [{ id: "t1", vestDate: "2025-01-01", quantity: "1000" }], // before grantDate, and doesn't sum to 4000
    });
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.ok(paths.includes("tranches[0].vestDate"));
    assert.ok(paths.includes("tranches"));
  }
});

test("validateInstrumentTerms: PREFERRED_STOCK requires a classification object; debtTerms/accretion/dividends are validated only when present", () => {
  try {
    validateInstrumentTerms("PREFERRED_STOCK", {});
    assert.fail("should have thrown");
  } catch (err) {
    // "classification." (trailing dot) is IssueCollector's path() joining a non-empty
    // prefix with an empty field name — the same shape WARRANT's analogous
    // "classification isn't even an object" case would produce, not a typo.
    assert.deepEqual(issuePaths(err), ["classification."]);
  }

  assert.doesNotThrow(() =>
    validateInstrumentTerms("PREFERRED_STOCK", {
      classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: false },
    })
  );
});

test("validateInstrumentTerms: PREFERRED_STOCK's optional accretion block is validated field-by-field, including redemptionDate-after-issueDate", () => {
  try {
    validateInstrumentTerms("PREFERRED_STOCK", {
      classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false },
      accretion: { issueDate: "2026-01-01", quantity: "1000", issuePricePerShare: "10", redemptionDate: "2020-01-01", redemptionValuePerShare: "15" },
    });
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["accretion.redemptionDate"]);
  }

  assert.doesNotThrow(() =>
    validateInstrumentTerms("PREFERRED_STOCK", {
      classification: { mandatorilyRedeemable: false, redeemableAtHolderOption: true, redeemableUponContingentEventOutsideCompanyControl: false },
      accretion: { issueDate: "2026-01-01", quantity: "1000", issuePricePerShare: "10", redemptionDate: "2031-01-01", redemptionValuePerShare: "15" },
    })
  );
});

test("validateInstrumentTerms: PREFERRED_STOCK's optional debtTerms block is validated against the exact TermDebtInputs shape", () => {
  try {
    validateInstrumentTerms("PREFERRED_STOCK", {
      classification: { mandatorilyRedeemable: true, redeemableAtHolderOption: false, redeemableUponContingentEventOutsideCompanyControl: false },
      debtTerms: { faceValue: "1000000" },
    });
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.ok(paths.includes("debtTerms.netProceeds"));
    assert.ok(paths.includes("debtTerms.effectiveAnnualYield"));
    assert.ok(paths.includes("debtTerms.cashFlows"));
  }
});

test("validateInstrumentTerms: SAR requires a valid settlementType — a real engine exists now, so an arbitrary object no longer passes", () => {
  try {
    validateInstrumentTerms("SAR", { anything: "goes" });
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["settlementType"]);
  }
});

test("validateInstrumentTerms: SAR settlementType STOCK validates equityTerms against the exact ServiceConditionGrant shape", () => {
  assert.doesNotThrow(() =>
    validateInstrumentTerms("SAR", {
      settlementType: "STOCK",
      equityTerms: {
        grantDate: "2025-01-01",
        quantity: "1000",
        grantDateFairValuePerUnit: "2.50",
        tranches: [{ id: "t1", vestDate: "2026-01-01", quantity: "1000" }],
        attributionMethod: "straight-line",
      },
    })
  );

  try {
    validateInstrumentTerms("SAR", { settlementType: "STOCK", equityTerms: { grantDate: "2025-01-01" } });
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.ok(paths.includes("equityTerms.quantity"));
    assert.ok(paths.includes("equityTerms.grantDateFairValuePerUnit"));
    assert.ok(paths.includes("equityTerms.tranches"));
  }
});

test("validateInstrumentTerms: SAR settlementType CASH validates cashTerms, including per-tranche shape and vestDate-after-grantDate", () => {
  assert.doesNotThrow(() =>
    validateInstrumentTerms("SAR", {
      settlementType: "CASH",
      cashTerms: {
        grantDate: "2025-01-01",
        quantity: "1000",
        strikePrice: "10",
        tranches: [{ id: "t1", vestDate: "2027-01-01", quantity: "1000" }],
        observations: [{ date: "2026-01-01", fairValuePerUnit: "3.00" }],
      },
    })
  );

  try {
    validateInstrumentTerms("SAR", {
      settlementType: "CASH",
      cashTerms: {
        grantDate: "2025-01-01",
        quantity: "1000",
        strikePrice: "10",
        tranches: [{ id: "t1", vestDate: "2020-01-01", quantity: "1000" }], // before grantDate
        observations: "not an array",
      },
    });
    assert.fail("should have thrown");
  } catch (err) {
    const paths = issuePaths(err);
    assert.ok(paths.includes("cashTerms.tranches[0].vestDate"));
    assert.ok(paths.includes("cashTerms.observations"));
  }
});

test("validateInstrumentTerms: SAR settlementType CASH rejects out-of-order cashTerms.observations, and an observation dated on or before grantDate (same positional-matching hazard buildCashSettledSarSchedule has as buildFairValueRemeasurementSchedule)", () => {
  try {
    validateInstrumentTerms("SAR", {
      settlementType: "CASH",
      cashTerms: {
        grantDate: "2025-01-01",
        quantity: "1000",
        strikePrice: "10",
        tranches: [{ id: "t1", vestDate: "2028-01-01", quantity: "1000" }],
        observations: [
          { date: "2027-01-01", fairValuePerUnit: "4.00" },
          { date: "2026-01-01", fairValuePerUnit: "3.00" }, // out of order
        ],
      },
    });
    assert.fail("should have thrown");
  } catch (err) {
    const issue = (err as TermsValidationError).issues.find((i) => i.path === "cashTerms.observations")!;
    assert.match(issue.message, /entry 1 \(2026-01-01\) is not after entry 0 \(2027-01-01\)/);
  }

  try {
    validateInstrumentTerms("SAR", {
      settlementType: "CASH",
      cashTerms: {
        grantDate: "2026-06-01",
        quantity: "1000",
        strikePrice: "10",
        tranches: [{ id: "t1", vestDate: "2028-01-01", quantity: "1000" }],
        observations: [{ date: "2026-01-01", fairValuePerUnit: "3.00" }], // before grantDate
      },
    });
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["cashTerms.observations[0].date"]);
  }
});

test("validateInstrumentTerms: SAR rejects an invalid settlementType value outright rather than checking either branch", () => {
  try {
    validateInstrumentTerms("SAR", { settlementType: "STOCK_AND_CASH", equityTerms: {} });
    assert.fail("should have thrown");
  } catch (err) {
    assert.deepEqual(issuePaths(err), ["settlementType"]);
  }
});

test("validateInstrumentTerms: rejects a non-object terms payload outright for every type", () => {
  for (const type of ["STOCK_OPTION", "TERM_LOAN", "PIK_NOTE", "REVOLVER", "WARRANT", "COMMON_STOCK"] as const) {
    try {
      validateInstrumentTerms(type, "just a string");
      assert.fail(`should have thrown for ${type}`);
    } catch (err) {
      assert.deepEqual(issuePaths(err), [""]);
    }
    try {
      validateInstrumentTerms(type, null);
      assert.fail(`should have thrown for ${type} with null`);
    } catch (err) {
      assert.ok(err instanceof TermsValidationError);
    }
  }
});
