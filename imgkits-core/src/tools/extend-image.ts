import { z } from "zod";
import { MAX_SOURCE_URL_CHARS, outpaintPath, usaBaseUrl } from "../config";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";
import { postJson } from "../upstream";
import { assertPublicUrl } from "../urls";
import { sourceHost, successImage, withImageCall } from "./common";

export const extendImageInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .describe("Public http(s) URL of the image to extend (outpaint)."),
  ratio: z
    .string()
    .trim()
    .regex(/^\d{1,2}:\d{1,2}$/)
    .describe('Target aspect ratio, for example "16:9" or "9:16". Sent as upstream `ratio` with `pic`.'),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type ExtendImageInput = z.input<typeof extendImageInputSchema>;

export function normalizeRatio(ratio: string): string {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(ratio.trim());
  if (!match) throw new ToolError('ratio must look like "16:9".', "invalid_arguments");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1 || width > 32 || height > 32) {
    throw new ToolError("Each side of ratio must be an integer from 1 to 32.", "invalid_arguments");
  }
  return `${width}:${height}`;
}

/** POST `{pic, ratio}` to `/ai/image-outpainting`. */
export async function extendImage(ctx: ToolContext, input: ExtendImageInput): Promise<Record<string, unknown>> {
  const sourceUrl = assertPublicUrl(input.source_url, "source_url");
  const ratio = normalizeRatio(input.ratio);
  const host = sourceHost(sourceUrl);
  return withImageCall(ctx, "extend_image", input.idempotency_key, host, async (billed, auditId) => {
    const payload = await postJson(ctx.env, usaBaseUrl(ctx.env), outpaintPath(ctx.env), {
      pic: sourceUrl,
      ratio,
    });
    return successImage({
      tool: "extend_image",
      auditId,
      sourceUrl,
      payload,
      billed,
      extra: { ratio },
    });
  });
}
