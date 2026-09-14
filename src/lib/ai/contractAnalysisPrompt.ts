import type { AnthropicContentBlock, AnthropicToolDefinition } from "./anthropicClient.js";

/**
 * George, verbatim: "we need to work on the functionality that allows users to
 * upload a contract and the platform identifies what it is (option, debt, etc.)
 * and proposes accounting treatment and memo justification for it... This needs
 * to be able to identify the potential accounting needs within a contract and
 * reference ASC and company policy guidance to propose initial and subsequent
 * accounting treatment."
 *
 * Per George's own scoping decision (asked directly before building this): ASC
 * guidance only for now — no separate company-policy-document library in this
 * pass. If a company policy library gets built later, its text would simply be
 * appended to buildContractAnalysisSystemPrompt's guidance section.
 *
 * This file is 100% pure — no network, no filesystem, no Prisma — so it's fully
 * unit tested in tests/contractAnalysisPrompt.test.ts. The one impure step
 * (actually reading bytes off a DocumentVersion and calling the Anthropic API) is
 * the caller's job (the /api/document-versions/:id/analyze route, not yet built).
 *
 * DISCLAIMER, repeated everywhere this result surfaces: this is an AI-generated
 * PROPOSAL for a qualified accountant to review — never auto-applied to create a
 * real Instrument, JournalEntry, or any other accounting record in this app. See
 * ContractAnalysis's doc comment in prisma/schema.prisma.
 */

export const CONTRACT_ANALYSIS_TOOL_NAME = "propose_contract_accounting_treatment";

/** Kept free-text (not InstrumentType) since a contract can be something this app has
 * no InstrumentType for yet (e.g. an operating lease, an employment agreement with no
 * equity component) — see the matching field's doc comment on ContractAnalysis. This
 * list is the vocabulary Claude is instructed to prefer when the contract *does* match
 * one of this app's existing instrument types. */
export const KNOWN_INSTRUMENT_TYPES = [
  "STOCK_OPTION",
  "RSU",
  "SAR",
  "WARRANT",
  "CONVERTIBLE_NOTE",
  "TERM_LOAN",
  "REVOLVER",
  "PIK_NOTE",
  "PREFERRED_STOCK",
  "COMMON_STOCK",
  "RESTRICTED_STOCK",
] as const;

export const CONTRACT_ANALYSIS_TOOL: AnthropicToolDefinition = {
  name: CONTRACT_ANALYSIS_TOOL_NAME,
  description:
    "Propose a classification, ASC references, and initial/subsequent accounting treatment for an uploaded contract or agreement, based solely on the document's own text.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      identifiedInstrumentType: {
        type: "string",
        description:
          `The kind of instrument or arrangement this contract represents. Prefer one of: ${KNOWN_INSTRUMENT_TYPES.join(", ")} — or "OTHER" if it genuinely matches none of those (e.g. a lease, an NDA, an employment offer letter with no equity component), or "NOT_A_CONTRACT" if the document does not appear to be an executed or draft agreement at all.`,
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "How confident this classification is, based only on how clearly the document's own terms support it.",
      },
      summary: {
        type: "string",
        description: "2-4 sentence plain-language summary of what this contract is and its key economic terms.",
      },
      keyTerms: {
        type: "object",
        description:
          "The specific terms extracted from the document that drove the classification and treatment below — e.g. grant date, quantity, strike/exercise price, vesting schedule, maturity date, interest rate, conversion terms, redemption/repurchase rights, performance or market conditions. Keys and values are free-form text; include only terms actually present in the document.",
        additionalProperties: { type: "string" },
      },
      ascReferences: {
        type: "array",
        description: "The specific ASC topic(s)/subtopic(s) that govern this instrument's accounting, each with a one-sentence note on why it applies to THIS contract's terms.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            reference: { type: "string", description: 'e.g. "ASC 718-10", "ASC 480-10", "ASC 815-40", "ASC 470-20"' },
            relevance: { type: "string", description: "Why this reference applies to this specific contract's terms." },
          },
          required: ["reference", "relevance"],
        },
      },
      initialTreatment: {
        type: "string",
        description:
          "The proposed initial (day-one) accounting treatment: recognition, measurement basis (e.g. fair value via Black-Scholes/lattice, face value, relative fair value allocation), equity vs. liability classification, and the initial journal entry in plain language.",
      },
      subsequentTreatment: {
        type: "string",
        description:
          "The proposed subsequent (period-over-period) accounting treatment: amortization/expense pattern, remeasurement requirements (if liability-classified), and any reclassification triggers (e.g. a contingency being resolved, a modification).",
      },
      openQuestions: {
        type: "array",
        items: { type: "string" },
        description:
          "Specific questions a reviewing accountant should resolve before finalizing treatment — missing terms, ambiguous language, or facts outside the document (e.g. \"the document does not state whether this is subject to shareholder approval\").",
      },
      memoRequired: {
        type: "boolean",
        description:
          "Your own recommendation on whether this contract's accounting is judgmental/material enough to warrant a written memo, independent of what the user selected when uploading.",
      },
      memoDraft: {
        type: ["string", "null"],
        description:
          "If a memo was requested by the user, a full draft technical accounting memo (background, facts, issue, analysis with ASC citations, conclusion). Null if no memo was requested.",
      },
    },
    required: [
      "identifiedInstrumentType",
      "confidence",
      "summary",
      "ascReferences",
      "initialTreatment",
      "subsequentTreatment",
      "openQuestions",
      "memoRequired",
      "memoDraft",
    ],
  },
};

/**
 * The system prompt fixes Claude's role and points it at the ASC areas this app's
 * own supported instrument types actually touch, so it doesn't waste the contract's
 * context window re-deriving GAAP from first principles. This is guidance, not a
 * substitute for a reviewing accountant's own judgment — see the disclaimer text
 * required in every caller that surfaces memoDraft/initialTreatment to a user.
 */
export function buildContractAnalysisSystemPrompt(): string {
  return [
    "You are assisting a U.S. GAAP technical accounting reviewer at a private company that tracks equity and debt instruments (options, RSUs, SARs, warrants, convertible notes, term loans, revolvers, PIK notes, preferred stock, common stock, and early-exercised/restricted stock).",
    "You will be given the text or scanned image of an uploaded contract or agreement. Read it carefully and propose how it should likely be classified and accounted for under U.S. GAAP, citing the specific ASC topic(s) that apply.",
    "",
    "Relevant ASC areas for this company's instrument types (use whichever actually applies to the contract in front of you — do not force-fit):",
    "- ASC 718 (Compensation — Stock Compensation): employee/non-employee equity awards — options, RSUs, SARs, restricted stock. Covers grant-date fair value measurement, equity vs. liability classification (ASC 718-10-25), service/performance/market conditions, requisite service period expense attribution, and modification accounting (ASC 718-20-35).",
    "- ASC 480 (Distinguishing Liabilities from Equity): mandatorily redeemable instruments and other instruments that must be liability-classified regardless of their legal form.",
    "- ASC 815-40 (Derivatives — Contracts in Entity's Own Equity): warrants and other equity-linked contracts — indexation to the entity's own stock and equity-classification conditions; if not equity-classified, the instrument is a derivative liability remeasured to fair value each period.",
    "- ASC 470 (Debt): term loans, revolvers, PIK notes — initial measurement at proceeds net of discount/issuance costs, effective-interest amortization, debt modification vs. extinguishment (ASC 470-50/-60).",
    "- ASC 470-20 (Debt with Conversion and Other Options): convertible notes — beneficial conversion features, cash conversion features, and (post ASU 2020-06) the simplified single-instrument model for most convertible debt.",
    "- ASC 505 (Equity): common and preferred stock issuances, including distinguishing participating/redeemable preferred that may need ASC 480-10-S99 (SEC guidance) temporary-equity presentation for a public filer.",
    "",
    "Base every conclusion strictly on what the document's own text actually says — quote or closely paraphrase the specific term that drives each conclusion. Where the document is silent, ambiguous, or you are inferring rather than reading a stated term, say so explicitly in openQuestions rather than assuming a fact. Never fabricate a term, date, or number that is not in the document.",
    "This analysis is a starting proposal for a qualified accountant to review — it is never a final accounting determination and is never applied automatically.",
  ].join("\n");
}

export interface ContractAnalysisPromptOptions {
  /** true if the user checked "draft a memo" when uploading — see George's own scoping: "not all option grants need a memo." */
  memoRequested: boolean;
  /** Optional free-text context supplied at upload time (e.g. "this is a follow-on grant under the 2021 Plan"). */
  additionalContext?: string;
}

/**
 * Builds the instruction text block that accompanies the document content block(s)
 * in the user turn. Kept separate from the document bytes themselves — the caller
 * (the analyze API route) appends the actual document/text content block(s) after
 * this one.
 */
export function buildContractAnalysisInstructionBlock(options: ContractAnalysisPromptOptions): AnthropicContentBlock {
  const { memoRequested, additionalContext } = options;
  const lines = [
    "Analyze the attached contract and call the propose_contract_accounting_treatment tool with your proposed classification and accounting treatment.",
    memoRequested
      ? "The user has requested a full memo draft — populate memoDraft with a complete technical accounting memo."
      : "The user has NOT requested a memo for this contract — set memoDraft to null. Still set memoRequired to your own honest recommendation on whether one is warranted, independent of what the user chose.",
  ];
  if (additionalContext && additionalContext.trim().length > 0) {
    lines.push(`Additional context provided by the user: ${additionalContext.trim()}`);
  }
  return { type: "text", text: lines.join("\n") };
}

export interface NormalizedContractAnalysis {
  identifiedInstrumentType: string;
  confidence: "high" | "medium" | "low" | null;
  summary: string;
  keyTerms: Record<string, string>;
  ascReferences: Array<{ reference: string; relevance: string }>;
  initialTreatment: string;
  subsequentTreatment: string;
  openQuestions: string[];
  memoRequired: boolean;
  memoDraft: string | null;
}

/**
 * Validates and normalizes the raw tool-call input (already extracted via
 * extractToolInput) into a strict shape safe to persist onto ContractAnalysis.
 * Throws with a descriptive message on any structural problem — the caller should
 * catch that and record it in ContractAnalysis.errorMessage with status FAILED
 * rather than persist a malformed/partial result.
 */
export function validateContractAnalysisResult(raw: unknown): NormalizedContractAnalysis {
  if (!raw || typeof raw !== "object") {
    throw new Error("Contract analysis tool input was not an object.");
  }
  const input = raw as Record<string, unknown>;

  const identifiedInstrumentType = readRequiredString(input, "identifiedInstrumentType");
  const summary = readRequiredString(input, "summary");
  const initialTreatment = readRequiredString(input, "initialTreatment");
  const subsequentTreatment = readRequiredString(input, "subsequentTreatment");

  const confidenceRaw = input.confidence;
  const confidence: "high" | "medium" | "low" | null =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low" ? confidenceRaw : null;

  const keyTerms: Record<string, string> = {};
  if (input.keyTerms && typeof input.keyTerms === "object") {
    for (const [key, value] of Object.entries(input.keyTerms as Record<string, unknown>)) {
      if (typeof value === "string") {
        keyTerms[key] = value;
      } else if (value !== null && value !== undefined) {
        keyTerms[key] = String(value);
      }
    }
  }

  const ascReferences: Array<{ reference: string; relevance: string }> = [];
  if (Array.isArray(input.ascReferences)) {
    for (const entry of input.ascReferences) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (typeof e.reference === "string" && e.reference.trim().length > 0) {
          ascReferences.push({
            reference: e.reference.trim(),
            relevance: typeof e.relevance === "string" ? e.relevance.trim() : "",
          });
        }
      }
    }
  }
  if (ascReferences.length === 0) {
    throw new Error("Contract analysis tool input had no valid ascReferences entries.");
  }

  const openQuestions: string[] = Array.isArray(input.openQuestions)
    ? input.openQuestions.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    : [];

  const memoRequired = input.memoRequired === true;
  const memoDraft = typeof input.memoDraft === "string" && input.memoDraft.trim().length > 0 ? input.memoDraft : null;

  return {
    identifiedInstrumentType,
    confidence,
    summary,
    keyTerms,
    ascReferences,
    initialTreatment,
    subsequentTreatment,
    openQuestions,
    memoRequired,
    memoDraft,
  };
}

function readRequiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Contract analysis tool input was missing a non-empty "${field}" string.`);
  }
  return value.trim();
}
