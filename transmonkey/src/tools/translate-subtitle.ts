import { z } from "zod";
import { MAX_SUBTITLE_CHARS } from "../config";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";
import {
  detectSubtitleFormat,
  parseSubtitle,
  translateSubtitleDocument,
  type SubtitleFormat,
} from "../subtitle";
import { translateTexts } from "../upstream";
import {
  billTool,
  normalizeLanguages,
  raiseAfterCharge,
  requireUpstreamConfigured,
  resolveIdempotencyKey,
} from "./common";

export const translateSubtitleInputSchema = z.object({
  subtitle_content: z
    .string()
    .min(1)
    .max(MAX_SUBTITLE_CHARS)
    .describe(
      "Raw subtitle text (SRT, WebVTT or ASS/SSA). Up to 1,000,000 characters. Timestamps are preserved exactly.",
    ),
  format: z
    .enum(["auto", "srt", "vtt", "ass"])
    .default("auto")
    .describe("Subtitle format. Defaults to auto-detection."),
  from: z
    .string()
    .min(1)
    .max(32)
    .default("auto")
    .describe("Source language code or name. Defaults to 'auto'."),
  to: z
    .string()
    .min(1)
    .max(32)
    .describe("Target language code or name, e.g. en, zh, cht, ja, ko, fr, de, es."),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional per-job key for upstream job isolation. Billing is handled by mcp-credit-gateway."),
});

export type TranslateSubtitleInput = z.input<typeof translateSubtitleInputSchema>;

export async function translateSubtitle(
  ctx: ToolContext,
  input: TranslateSubtitleInput,
): Promise<Record<string, unknown>> {
  if (input.subtitle_content.length > MAX_SUBTITLE_CHARS) {
    throw new ToolError(
      `Subtitle content is ${input.subtitle_content.length} characters; the limit is ${MAX_SUBTITLE_CHARS}.`,
      "subtitle_too_long",
    );
  }

  const format: SubtitleFormat = detectSubtitleFormat(input.subtitle_content, input.format ?? "auto");
  // Parse before charging so malformed subtitles are rejected for free.
  parseSubtitle(input.subtitle_content, format);
  const { from, to } = normalizeLanguages(input.from ?? "auto", input.to);
  requireUpstreamConfigured(ctx);

  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "translate_subtitle", idempotencyKey);

  try {
    const result = await translateSubtitleDocument(input.subtitle_content, format, (texts) =>
      translateTexts(ctx.env, { from, to, texts }),
    );
    return {
      format: result.format,
      cue_count: result.cue_count,
      timeline_preserved: true,
      char_count: result.char_count,
      translated_subtitle: result.translated,
      idempotency_key: idempotencyKey,
      charge: billed.charge,
    };
  } catch (error) {
    raiseAfterCharge(error, billed);
  }
}
