import { z } from "zod";
import { MAX_SOURCE_URL_CHARS, aiBaseUrl, colorizePath } from "../config";
import type { ToolContext } from "../env";
import { postJson } from "../upstream";
import { assertPublicUrl } from "../urls";
import { sourceHost, successImage, withImageCall } from "./common";

export const colorizePhotoInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .describe("Public http(s) URL of the photo to colorize (JPG/PNG/WebP). Black-and-white photos work best."),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type ColorizePhotoInput = z.input<typeof colorizePhotoInputSchema>;

/** POST `{img}` to `/api/deoldify`. Live shape: `{url:"https://..."}`. */
export async function colorizePhoto(ctx: ToolContext, input: ColorizePhotoInput): Promise<Record<string, unknown>> {
  const sourceUrl = assertPublicUrl(input.source_url, "source_url");
  const host = sourceHost(sourceUrl);
  return withImageCall(ctx, "colorize_photo", input.idempotency_key, host, async (billed, auditId) => {
    const payload = await postJson(ctx.env, aiBaseUrl(ctx.env), colorizePath(ctx.env), { img: sourceUrl });
    return successImage({
      tool: "colorize_photo",
      auditId,
      sourceUrl,
      payload,
      billed,
    });
  });
}
