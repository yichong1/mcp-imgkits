import { z } from "zod";
import { MAX_DETECT_CHARS, costFor } from "../config";
import { ToolError } from "../errors";
import type { ToolContext } from "../env";
import { detectLanguage } from "../languages";
import { billTool, resolveIdempotencyKey } from "./common";

export const detectLanguageInputSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_DETECT_CHARS)
    .describe("Text to identify. Up to 20,000 characters; longer samples improve accuracy."),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional per-job key; relevant when COST_DETECT_LANGUAGE is above 0 (gateway billing)."),
});

export type DetectLanguageInput = z.infer<typeof detectLanguageInputSchema>;

export async function detectLanguageTool(
  ctx: ToolContext,
  input: DetectLanguageInput,
): Promise<Record<string, unknown>> {
  if (input.text.length > MAX_DETECT_CHARS) {
    throw new ToolError(`Text is too long for language detection (max ${MAX_DETECT_CHARS} characters).`, "text_too_long");
  }
  const result = detectLanguage(input.text);
  const cost = costFor(ctx.env, "detect_language");

  if (cost <= 0) {
    return {
      ...result,
      billing: "free",
      charged_this_call: 0,
      note: "Local heuristic detection; no upstream call was made.",
    };
  }

  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "detect_language", idempotencyKey);
  return {
    ...result,
    billing: "charged",
    idempotency_key: idempotencyKey,
    charge: billed.charge,
  };
}
