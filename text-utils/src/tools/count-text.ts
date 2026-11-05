import { z } from "zod";
import { MAX_TEXT_CHARS, costFor } from "../config";
import { chargeCredits } from "../charge";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";

export const countTextInputSchema = {
  text: z
    .string()
    .min(1, "text is required")
    .max(MAX_TEXT_CHARS, `text must be <= ${MAX_TEXT_CHARS} characters`),
};

export type CountTextInput = {
  text: string;
};

/**
 * Simple CJK + Latin word/char/line counters.
 * - characters: Unicode code points (length of [...text])
 * - words: Latin runs + each CJK ideograph as one word
 * - lines: split on \\n (empty text → 0)
 */
export function countTextMetrics(text: string): {
  characters: number;
  characters_no_whitespace: number;
  words: number;
  lines: number;
  bytes_utf8: number;
} {
  const chars = [...text];
  const characters = chars.length;
  const characters_no_whitespace = chars.filter((c) => !/\s/u.test(c)).length;
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  const bytes_utf8 = new TextEncoder().encode(text).byteLength;

  // Words: sequences of Latin alnum/'/- OR single CJK Unified Ideograph
  const wordMatches = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[\u4e00-\u9fff]/gu);
  const words = wordMatches ? wordMatches.length : 0;

  return { characters, characters_no_whitespace, words, lines, bytes_utf8 };
}

export async function countText(
  ctx: ToolContext,
  args: CountTextInput,
): Promise<Record<string, unknown>> {
  const text = args.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new ToolError("text is required and must be a non-empty string.", "invalid_arguments");
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new ToolError(`text must be <= ${MAX_TEXT_CHARS} characters.`, "invalid_arguments");
  }

  const cost = costFor(ctx.env, "count_text");
  const charge = chargeCredits({
    cost,
    tool: "count_text",
    ...(ctx.chargeId ? { chargeId: ctx.chargeId } : {}),
  });

  const metrics = countTextMetrics(text);
  return {
    ok: true,
    tool: "count_text",
    text_preview: text.length > 80 ? `${text.slice(0, 80)}…` : text,
    ...metrics,
    charged: charge.charged,
    charged_this_call: charge.charged,
    billing: charge.charged > 0 ? "charged" : "free",
    ...(charge.charge_id ? { charge_id: charge.charge_id } : {}),
  };
}
