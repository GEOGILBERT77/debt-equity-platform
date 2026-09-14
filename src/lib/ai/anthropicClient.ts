/**
 * Thin, hand-written wrapper around the Anthropic Messages API — no SDK dependency,
 * to keep this codebase's dependency footprint minimal and avoid pinning an SDK
 * version that can't be verified against a live network in this environment.
 *
 * DESIGN: this file is split into PURE functions (buildForcedToolRequest,
 * extractToolInput) that build/parse plain JSON and have no network dependency —
 * these are unit tested in tests/anthropicClient.test.ts exactly like every other
 * pure function in this codebase — and a single impure function
 * (callAnthropicMessages) that actually performs the fetch. Callers (the
 * contract-analysis route) should build the request with buildForcedToolRequest,
 * call callAnthropicMessages, then parse the result with extractToolInput.
 *
 * FORCED TOOL USE: rather than asking Claude to describe a contract in prose and
 * then trying to parse that prose back into structured fields (fragile — free text
 * drifts in format), every call here forces Claude to respond via a single named
 * tool whose input schema IS the structured result we want (see
 * contractAnalysisPrompt.ts for the actual schema used for contract analysis).
 * `tool_choice: {type: "tool", name}` guarantees the response's only content block
 * is a tool_use block with `input` already shaped to that schema.
 *
 * NOT EXECUTED IN THIS SANDBOX — there is no network access here to actually call
 * api.anthropic.com. Written carefully against the documented Messages API
 * (https://docs.claude.com/en/api/messages); test one real call after deploying,
 * with ANTHROPIC_API_KEY set.
 */

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: AnthropicContentBlock[] }>;
  tools: AnthropicToolDefinition[];
  tool_choice: { type: "tool"; name: string };
}

/**
 * Builds a Messages API request body that forces the model to respond by calling
 * exactly one named tool. `content` is the array of content blocks for the single
 * user turn (typically a text instruction block plus one document/image block).
 */
export function buildForcedToolRequest(options: {
  model?: string;
  maxTokens: number;
  system?: string;
  content: AnthropicContentBlock[];
  tool: AnthropicToolDefinition;
}): AnthropicMessagesRequest {
  const { model, maxTokens, system, content, tool } = options;
  if (content.length === 0) {
    throw new Error("buildForcedToolRequest: content must have at least one block.");
  }
  return {
    model: model || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
  };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/**
 * Pulls the parsed `input` object out of a Messages API response body, given the
 * tool name we forced. Throws a descriptive error if the response isn't shaped as
 * expected (missing content, wrong block type/name, or an API-reported error) —
 * callers should treat that as an analysis failure (ContractAnalysisStatus.FAILED),
 * not crash the request handling it.
 */
export function extractToolInput(responseBody: unknown, toolName: string): unknown {
  if (!responseBody || typeof responseBody !== "object") {
    throw new Error("Anthropic response was not a JSON object.");
  }
  const body = responseBody as Record<string, unknown>;
  if (typeof body.error === "object" && body.error !== null) {
    const err = body.error as Record<string, unknown>;
    throw new Error(`Anthropic API returned an error: ${String(err.message ?? err.type ?? "unknown error")}`);
  }
  const content = body.content;
  if (!Array.isArray(content)) {
    throw new Error("Anthropic response had no content array.");
  }
  const toolUse = content.find(
    (block): block is AnthropicToolUseBlock =>
      typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "tool_use"
  );
  if (!toolUse) {
    throw new Error(
      `Anthropic response contained no tool_use block (stop_reason: ${String(body.stop_reason ?? "unknown")}).`
    );
  }
  if (toolUse.name !== toolName) {
    throw new Error(`Anthropic response used tool "${toolUse.name}", expected "${toolName}".`);
  }
  return toolUse.input;
}

/**
 * Performs the actual network call. Kept separate from buildForcedToolRequest/
 * extractToolInput so those two can be unit tested with zero network dependency.
 */
export async function callAnthropicMessages(
  request: AnthropicMessagesRequest,
  apiKey: string
): Promise<unknown> {
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — see the README's \"Document library & contract analysis\" section."
    );
  }
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in (body as Record<string, unknown>)
        ? String((body as Record<string, unknown>).error)
        : `HTTP ${response.status}`;
    throw new Error(`Anthropic API request failed: ${message}`);
  }
  return body;
}
