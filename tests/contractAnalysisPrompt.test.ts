import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_ANALYSIS_TOOL,
  CONTRACT_ANALYSIS_TOOL_NAME,
  buildContractAnalysisSystemPrompt,
  buildContractAnalysisInstructionBlock,
  validateContractAnalysisResult,
} from "../src/lib/ai/contractAnalysisPrompt.js";

test("CONTRACT_ANALYSIS_TOOL is named consistently and requires the key fields", () => {
  assert.equal(CONTRACT_ANALYSIS_TOOL.name, CONTRACT_ANALYSIS_TOOL_NAME);
  const schema = CONTRACT_ANALYSIS_TOOL.input_schema as { required: string[] };
  for (const field of ["identifiedInstrumentType", "summary", "ascReferences", "initialTreatment", "subsequentTreatment", "memoRequired", "memoDraft"]) {
    assert.ok(schema.required.includes(field), `expected required field "${field}"`);
  }
});

test("buildContractAnalysisSystemPrompt mentions the core ASC areas this app cares about", () => {
  const prompt = buildContractAnalysisSystemPrompt();
  for (const reference of ["ASC 718", "ASC 480", "ASC 815-40", "ASC 470"]) {
    assert.ok(prompt.includes(reference), `expected system prompt to mention ${reference}`);
  }
});

test("buildContractAnalysisInstructionBlock reflects memoRequested = true", () => {
  const block = buildContractAnalysisInstructionBlock({ memoRequested: true });
  assert.equal(block.type, "text");
  assert.ok((block as { text: string }).text.includes("has requested a full memo draft"));
});

test("buildContractAnalysisInstructionBlock reflects memoRequested = false and includes additional context", () => {
  const block = buildContractAnalysisInstructionBlock({
    memoRequested: false,
    additionalContext: "Follow-on grant under the 2021 Plan.",
  });
  const text = (block as { text: string }).text;
  assert.ok(text.includes("NOT requested a memo"));
  assert.ok(text.includes("Follow-on grant under the 2021 Plan."));
});

function validAnalysisInput(overrides: Record<string, unknown> = {}) {
  return {
    identifiedInstrumentType: "STOCK_OPTION",
    confidence: "high",
    summary: "A nonqualified stock option grant for 10,000 shares at $1.00/share, vesting over 4 years.",
    keyTerms: { grantDate: "2026-01-15", quantity: "10000", strikePrice: "1.00" },
    ascReferences: [{ reference: "ASC 718-10", relevance: "This is an employee equity award subject to service vesting." }],
    initialTreatment: "Measure grant-date fair value via Black-Scholes; recognize as equity-classified award.",
    subsequentTreatment: "Recognize compensation cost ratably over the 4-year requisite service period.",
    openQuestions: ["The document does not state whether acceleration occurs upon a change of control."],
    memoRequired: false,
    memoDraft: null,
    ...overrides,
  };
}

test("validateContractAnalysisResult accepts a well-formed result", () => {
  const result = validateContractAnalysisResult(validAnalysisInput());
  assert.equal(result.identifiedInstrumentType, "STOCK_OPTION");
  assert.equal(result.confidence, "high");
  assert.equal(result.ascReferences.length, 1);
  assert.equal(result.ascReferences[0].reference, "ASC 718-10");
  assert.equal(result.memoDraft, null);
  assert.equal(result.keyTerms.grantDate, "2026-01-15");
});

test("validateContractAnalysisResult coerces non-string keyTerms values to strings", () => {
  const result = validateContractAnalysisResult(validAnalysisInput({ keyTerms: { quantity: 10000 } }));
  assert.equal(result.keyTerms.quantity, "10000");
});

test("validateContractAnalysisResult normalizes an invalid confidence to null rather than throwing", () => {
  const result = validateContractAnalysisResult(validAnalysisInput({ confidence: "very high" }));
  assert.equal(result.confidence, null);
});

test("validateContractAnalysisResult keeps a real memoDraft when present", () => {
  const result = validateContractAnalysisResult(
    validAnalysisInput({ memoRequired: true, memoDraft: "MEMORANDUM\n\nBackground: ..." })
  );
  assert.equal(result.memoRequired, true);
  assert.ok(result.memoDraft?.startsWith("MEMORANDUM"));
});

test("validateContractAnalysisResult throws when required string fields are missing", () => {
  const { summary, ...withoutSummary } = validAnalysisInput();
  assert.throws(() => validateContractAnalysisResult(withoutSummary), /summary/);
});

test("validateContractAnalysisResult throws when ascReferences is empty", () => {
  assert.throws(() => validateContractAnalysisResult(validAnalysisInput({ ascReferences: [] })), /ascReferences/);
});

test("validateContractAnalysisResult throws on a non-object input", () => {
  assert.throws(() => validateContractAnalysisResult(null), /not an object/);
  assert.throws(() => validateContractAnalysisResult("nope"), /not an object/);
});

test("validateContractAnalysisResult filters out malformed ascReferences entries but keeps valid ones", () => {
  const result = validateContractAnalysisResult(
    validAnalysisInput({
      ascReferences: [
        { reference: "ASC 718-10", relevance: "Equity award." },
        { relevance: "missing reference field" },
        "not even an object",
      ],
    })
  );
  assert.equal(result.ascReferences.length, 1);
});
