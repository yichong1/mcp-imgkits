import { z } from "zod";
import { MAX_IMAGE_EDGE, MAX_SOURCE_URL_CHARS, resizePath, usaBaseUrl } from "../config";
import type { ToolContext } from "../env";
import { getUpstream } from "../upstream";
import { assertPublicUrl } from "../urls";
import { sourceHost, successImage, withImageCall } from "./common";

export const resizeImageInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .describe("Public http(s) URL of the image to resize."),
  width: z
    .number()
    .int()
    .min(1)
    .max(MAX_IMAGE_EDGE)
    .describe(`Target width in pixels, 1–${MAX_IMAGE_EDGE}. Sent as the \`width\` query parameter.`),
  height: z
    .number()
    .int()
    .min(1)
    .max(MAX_IMAGE_EDGE)
    .describe(`Target height in pixels, 1–${MAX_IMAGE_EDGE}. Sent as the \`height\` query parameter.`),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type ResizeImageInput = z.input<typeof resizeImageInputSchema>;

/** GET `/ai/change-img-size?pic&width&height`. JSON POST to this path returns HTTP 500. */
export async function resizeImage(ctx: ToolContext, input: ResizeImageInput): Promise<Record<string, unknown>> {
  const sourceUrl = assertPublicUrl(input.source_url, "source_url");
  const query = new URLSearchParams({
    pic: sourceUrl,
    width: String(input.width),
    height: String(input.height),
  });
  const host = sourceHost(sourceUrl);
  return withImageCall(ctx, "resize_image", input.idempotency_key, host, async (billed, auditId) => {
    const payload = await getUpstream(ctx.env, usaBaseUrl(ctx.env), `${resizePath(ctx.env)}?${query.toString()}`);
    return successImage({
      tool: "resize_image",
      auditId,
      sourceUrl,
      payload,
      billed,
      extra: { width: input.width, height: input.height },
    });
  });
}
