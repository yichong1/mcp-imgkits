import { z } from "zod";
import { MAX_SOURCE_URL_CHARS, aiBaseUrl, restorationBucket, upscalePath } from "../config";
import type { ToolContext } from "../env";
import { postJson } from "../upstream";
import { assertPublicUrl } from "../urls";
import { sourceHost, successImage, withImageCall } from "./common";

export const upscaleImageInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .describe("Public http(s) URL of the image to upscale (JPG/PNG/WebP)."),
  scale: z
    .union([z.literal(2), z.literal(4)])
    .default(2)
    .describe(
      "Scale factor sent to the restoration upstream as `upscale`. 2 (default) and 4 are the supported factors. " +
        "Face enhancement is the optional `face_enhance` flag on this same tool; there is no separate enhance tool.",
    ),
  face_enhance: z
    .boolean()
    .optional()
    .describe(
      "When set, forwarded as `face_enhance` on the restoration body. Omit it to send only `img` and `upscale`.",
    ),
  bucket: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .optional()
    .describe("Optional upstream storage bucket. Sent only when set here or via RESTORATION_BUCKET."),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type UpscaleImageInput = z.input<typeof upscaleImageInputSchema>;

/**
 * POST `{img, upscale, face_enhance?}` to `/api/restoration`.
 * Enhance is a parameter of this tool, not a separate tool.
 */
export async function upscaleImage(ctx: ToolContext, input: UpscaleImageInput): Promise<Record<string, unknown>> {
  const sourceUrl = assertPublicUrl(input.source_url, "source_url");
  const bucket = input.bucket?.trim() || restorationBucket(ctx.env);
  const scale = input.scale ?? 2;
  const body: Record<string, unknown> = {
    img: sourceUrl,
    upscale: scale,
    ...(input.face_enhance === undefined ? {} : { face_enhance: input.face_enhance }),
    ...(bucket ? { bucket } : {}),
  };
  const host = sourceHost(sourceUrl);
  return withImageCall(ctx, "upscale_image", input.idempotency_key, host, async (billed, auditId) => {
    const payload = await postJson(ctx.env, aiBaseUrl(ctx.env), upscalePath(ctx.env), body);
    return successImage({
      tool: "upscale_image",
      auditId,
      sourceUrl,
      payload,
      billed,
      extra: {
        scale,
        ...(input.face_enhance === undefined ? {} : { face_enhance: input.face_enhance }),
        ...(bucket ? { bucket } : {}),
      },
    });
  });
}
