import { z } from "zod";
import { MAX_TEXT_CHARS, MAX_TEXT_ITEMS } from "../config";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";
import { translateTexts } from "../upstream";
import {
  billTool,
  normalizeLanguages,
  raiseAfterCharge,
  requireUpstreamConfigured,
  resolveIdempotencyKey,
} from "./common";

export const translateTextInputSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_TEXT_CHARS)
    .optional()
    .describe("A single string to translate. Provide this or `texts`, not both."),
  texts: z
    .array(z.string().min(1).max(MAX_TEXT_CHARS))
    .min(1)
    .max(MAX_TEXT_ITEMS)
    .optional()
    .describe("Up to 50 strings to translate in one call. Total length must be <= 50,000 characters."),
  from: z
    .string()
    .min(1)
    .max(32)
    .default("auto")
    .describe("Source language code or English name. Defaults to 'auto'."),
  to: z
    .string()
    .min(1)
    .max(32)
    .describe("Target language code or English name, e.g. en, zh, cht, ja, ko, fr, de, es."),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional per-job key for upstream job isolation. Billing is handled by mcp-credit-gateway."),
});

export type TranslateTextInput = z.input<typeof translateTextInputSchema>;

export async function translateText(ctx: ToolContext, input: TranslateTextInput): Promise<Record<string, unknown>> {
  if (input.text !== undefined && input.texts !== undefined) {
    throw new ToolError("Provide either `text` or `texts`, not both.", "invalid_arguments");
  }
  const items = input.texts ?? (input.text !== undefined ? [input.text] : []);
  if (items.length === 0) throw new ToolError("Provide `text` or a non-empty `texts` array.", "invalid_arguments");
  if (items.some((item) => item.trim() === "")) {
    throw new ToolError("Text items must not be empty or whitespace-only.", "invalid_arguments");
  }
  if (items.length > MAX_TEXT_ITEMS) {
    throw new ToolError(`At most ${MAX_TEXT_ITEMS} text items are allowed per call.`, "text_too_long");
  }

  const charCount = items.reduce((sum, item) => sum + item.length, 0);
  if (charCount > MAX_TEXT_CHARS) {
    throw new ToolError(
      `Text is ${charCount} characters; this tool accepts at most ${MAX_TEXT_CHARS} characters per call. Split the input.`,
      "text_too_long",
    );
  }

  const { from, to } = normalizeLanguages(input.from ?? "auto", input.to);
  requireUpstreamConfigured(ctx);

  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "translate_text", idempotencyKey);

  try {
    const translations = await translateTexts(ctx.env, { from, to, texts: items });
    return {
      from,
      to,
      translations,
      ...(input.texts === undefined ? { translation: translations[0] } : {}),
      char_count: charCount,
      item_count: items.length,
      idempotency_key: idempotencyKey,
      charge: billed.charge,
    };
  } catch (error) {
    raiseAfterCharge(error, billed);
  }
}
