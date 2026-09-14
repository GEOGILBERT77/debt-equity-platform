import mammoth from "mammoth";

/**
 * Extracts plain text from a .docx file's bytes, for feeding into the Anthropic
 * Messages API as a text content block. Claude's native "document" content block
 * (used for PDFs — see contractAnalysisPrompt.ts / anthropicClient.ts) only accepts
 * PDFs and images, not .docx, so Word contracts need their text pulled out first.
 *
 * mammoth.extractRawText() deliberately discards formatting (tables collapse to
 * plain text, no styling) — that's fine here since the analysis only needs the
 * contract's language, not its layout.
 *
 * NOT EXECUTED IN THIS SANDBOX (no ability to install/run mammoth against a real
 * .docx here) — written against mammoth's documented API; verify with one real
 * upload after deploying.
 */
export async function extractDocxText(bytes: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: bytes });
  const text = result.value.trim();
  if (text.length === 0) {
    throw new Error("Could not extract any text from this .docx file — it may be empty, corrupted, or image-only.");
  }
  return text;
}
