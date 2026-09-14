import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildForcedToolRequest,
  extractToolInput,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicToolDefinition,
} from "../src/lib/ai/anthropicClient.js";

const SAMPLE_TOOL: AnthropicToolDefinition = {
  name: "propose_contract_analysis",
  description: "Propose a classification and accounting treatment for the uploaded contract.",
  input_schema: {
    type: "object",
    properties: {
      identifiedInstrumentType: { type: "string" },
    },
    required: ["identifiedInstrumentType"],
  },
};

test("buildForcedToolRequest defaults the model and forces the given tool", () => {
  const request = buildForcedToolRequest({
    maxTokens: 4096,
    content: [{ type: "text", text: "Analyze this contract." }],
    tool: SAMPLE_TOOL,
  });
  assert.equal(request.model, DEFAULT_ANTHROPIC_MODEL);
  assert.equal(request.max_tokens, 4096);
  assert.equal(request.tool_choice.type, "tool");
  assert.equal(request.tool_choice.name, "propose_contract_analysis");
  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0], SAMPLE_TOOL);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, "user");
  assert.equal(request.system, undefined);
});

test("buildForcedToolRequest respects an explicit model and system prompt", () => {
  const request = buildForcedToolRequest({
    model: "claude-opus-5",
    maxTokens: 1024,
    system: "You are a careful accountant.",
    content: [{ type: "text", text: "Hello" }],
    tool: SAMPLE_TOOL,
  });
  assert.equal(request.model, "claude-opus-5");
  assert.equal(request.system, "You are a careful accountant.");
});

test("buildForcedToolRequest rejects empty content", () => {
  assert.throws(() => buildForcedToolRequest({ maxTokens: 100, content: [], tool: SAMPLE_TOOL }));
});

test("extractToolInput returns the tool_use input when shaped correctly", () => {
  const responseBody = {
    content: [
      { type: "text", text: "I'll analyze this." },
      { type: "tool_use", id: "toolu_1", name: "propose_contract_analysis", input: { identifiedInstrumentType: "STOCK_OPTION" } },
    ],
    stop_reason: "tool_use",
  };
  const input = extractToolInput(responseBody, "propose_contract_analysis");
  assert.deepEqual(input, { identifiedInstrumentType: "STOCK_OPTION" });
});

test("extractToolInput throws on an API error body", () => {
  const responseBody = { error: { type: "invalid_request_error", message: "bad key" } };
  assert.throws(() => extractToolInput(responseBody, "propose_contract_analysis"), /bad key/);
});

test("extractToolInput throws when no content array is present", () => {
  assert.throws(() => extractToolInput({ stop_reason: "end_turn" }, "propose_contract_analysis"), /no content array/);
});

test("extractToolInput throws when no tool_use block is present", () => {
  const responseBody = { content: [{ type: "text", text: "Sorry, I can't do that." }], stop_reason: "end_turn" };
  assert.throws(() => extractToolInput(responseBody, "propose_contract_analysis"), /no tool_use block/);
});

test("extractToolInput throws when the tool_use block names a different tool", () => {
  const responseBody = {
    content: [{ type: "tool_use", id: "toolu_1", name: "some_other_tool", input: {} }],
  };
  assert.throws(() => extractToolInput(responseBody, "propose_contract_analysis"), /expected "propose_contract_analysis"/);
});

test("extractToolInput throws on a non-object response body", () => {
  assert.throws(() => extractToolInput(null, "propose_contract_analysis"), /not a JSON object/);
  assert.throws(() => extractToolInput("oops", "propose_contract_analysis"), /not a JSON object/);
});
