import { z } from "zod";
import { MAX_SOURCE_URL_CHARS, apiBaseUrl, cartoonizePath, cartoonizeV2Path } from "../config";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";
import { postJson } from "../upstream";
import { assertPublicUrl } from "../urls";
import { sourceHost, successImage, withImageCall } from "./common";

const styleToken = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .describe("Style or variant token (letters, digits, '.', '_' or '-'). Either one switches the call to cartoonize v2.");

export const cartoonizeInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .describe("Public http(s) URL of the photo to cartoonize."),
  style: styleToken
    .optional()
    .describe("Optional style. When set, the Worker calls `/api/cartoonize/v2` and sends `{img, style}`."),
  variant: styleToken
    .optional()
    .describe("Optional variant. When set (with or without style), the Worker calls `/api/cartoonize/v2`."),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type CartoonizeInput = z.input<typeof cartoonizeInputSchema>;

export function cartoonizeRequest(input: CartoonizeInput, sourceUrl: string): {
  version: "v1" | "v2";
  body: Record<string, unknown>;
} {
  const style = input.style?.trim();
  const variant = input.variant?.trim();
  if ((style && style.length > 40) || (variant && variant.length > 40)) {
    throw new ToolError("style and variant must be at most 40 characters.", "invalid_arguments");
  }
  const body: Record<string, unknown> = { img: sourceUrl };
  if (style) body.style = style;
  if (variant) body.variant = variant;
  return { version: style || variant ? "v2" : "v1", body };
}

/** Default POST `{img}` to `/api/cartoonize`. style or variant switches to `/api/cartoonize/v2`. */
export async function cartoonize(ctx: ToolContext, input: CartoonizeInput): Promise<Record<string, unknown>> {
  const sourceUrl = assertPublicUrl(input.source_url, "source_url");
  const request = cartoonizeRequest(input, sourceUrl);
  const path = request.version === "v2" ? cartoonizeV2Path(ctx.env) : cartoonizePath(ctx.env);
  const host = sourceHost(sourceUrl);
  return withImageCall(ctx, "cartoonize", input.idempotency_key, host, async (billed, auditId) => {
    const payload = await postJson(ctx.env, apiBaseUrl(ctx.env), path, request.body);
    return successImage({
      tool: "cartoonize",
      auditId,
      sourceUrl,
      payload,
      billed,
      extra: {
        cartoon_api: request.version,
        ...(typeof request.body.style === "string" ? { style: request.body.style } : {}),
        ...(typeof request.body.variant === "string" ? { variant: request.body.variant } : {}),
      },
    });
  });
}
