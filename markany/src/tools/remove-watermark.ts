import { z } from "zod";
import {
  COPYRIGHT_NOTICE,
  DEFAULT_INPAINT_BUCKET,
  MAX_IMAGE_BYTES,
  MAX_SOURCE_URL_CHARS,
  inpaintBucket,
  removeWatermarkPath,
  removeWatermarkRateLimit,
  removeWatermarkRateWindowMs,
} from "../config";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";
import { consumeRemoveWatermarkRateLimit, hashCallerKey } from "../rate-limit";
import { aiPost, deepFindString, extractOutputUrl } from "../upstream";
import { assertPublicUrl } from "../urls";
import {
  auditRecord,
  billTool,
  newAuditId,
  raiseAfterCharge,
  requireUpstreamConfigured,
  resolveIdempotencyKey,
} from "./common";

const maskRectSchema = z
  .object({
    x: z.number().min(0).max(1).describe("Left edge as a fraction of image width, 0–1."),
    y: z.number().min(0).max(1).describe("Top edge as a fraction of image height, 0–1."),
    width: z.number().gt(0).max(1).describe("Mask width as a fraction of image width, >0–1."),
    height: z.number().gt(0).max(1).describe("Mask height as a fraction of image height, >0–1."),
  })
  .refine((rect) => rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001, {
    message: "mask_rect must fit inside the image: x + width <= 1 and y + height <= 1.",
  });

export const removeWatermarkInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .describe(
      `Public http(s) URL of the image to clean (JPG/PNG/WebP, <= ${MAX_IMAGE_BYTES / (1024 * 1024)} MB). ` +
        "Only use material you own or are explicitly authorized to edit.",
    ),
  mask_image_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .optional()
    .describe(
      "Optional public URL of a mask image (white/opaque = watermark area to remove, black or transparent = keep). " +
        "Mutually exclusive with mask_rect.",
    ),
  mask_rect: maskRectSchema
    .optional()
    .describe(
      "Optional rectangular mask in normalized coordinates (0–1). For /api/inpaint this is forwarded as `mask_rect`; " +
        "if the upstream requires a bitmap mask, pass mask_image_url instead. Mutually exclusive with mask_image_url.",
    ),
  bucket: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .optional()
    .describe(`Upstream storage bucket for the result (default ${DEFAULT_INPAINT_BUCKET}).`),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
  confirm_authorization: z
    .boolean()
    .default(false)
    .describe(
      "Required explicit confirmation that you own this image or have a license to edit it. " +
        "Defaults to false. false or omitted is rejected and no upstream request is made.",
    ),
});

export type RemoveWatermarkInput = z.infer<typeof removeWatermarkInputSchema>;

export function resolveMaskMode(input: RemoveWatermarkInput): "auto" | "mask_url" | "mask_rect" {
  if (input.mask_image_url && input.mask_rect) {
    throw new ToolError("Provide either `mask_image_url` or `mask_rect`, not both.", "invalid_arguments");
  }
  if (input.mask_image_url) return "mask_url";
  if (input.mask_rect) return "mask_rect";
  return "auto";
}

export async function removeWatermark(
  ctx: ToolContext,
  input: RemoveWatermarkInput,
): Promise<Record<string, unknown>> {
  const sourceUrl = assertPublicUrl(input.source_url, "source_url");
  const maskMode = resolveMaskMode(input);
  const maskImageUrl = input.mask_image_url
    ? assertPublicUrl(input.mask_image_url, "mask_image_url")
    : undefined;
  const bucket = input.bucket?.trim() || inpaintBucket(ctx.env);
  const auditId = newAuditId();
  const sourceHost = new URL(sourceUrl).hostname;

  if (input.confirm_authorization !== true) {
    auditRecord({
      event: "remove_watermark",
      audit_id: auditId,
      outcome: "rejected",
      reason: "authorization_required",
      source_host: sourceHost,
      mask_mode: maskMode,
    });
    throw new ToolError(
      "remove_watermark requires confirm_authorization=true. Confirm you own this image or are explicitly licensed to edit it. No upstream request was made.",
      "authorization_required",
      { copyright: COPYRIGHT_NOTICE, audit_id: auditId },
    );
  }

  requireUpstreamConfigured(ctx);

  const limit = removeWatermarkRateLimit(ctx.env);
  const windowMs = removeWatermarkRateWindowMs(ctx.env);
  const bucketKey = await hashCallerKey(ctx.authToken || "anonymous");
  const decision = consumeRemoveWatermarkRateLimit(bucketKey, limit, windowMs);
  if (!decision.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    auditRecord({
      event: "remove_watermark",
      audit_id: auditId,
      outcome: "rejected",
      reason: "rate_limited",
      source_host: sourceHost,
      mask_mode: maskMode,
    });
    throw new ToolError(
      `remove_watermark rate limit exceeded (${limit} calls per ${Math.round(windowMs / 1000)} seconds for this caller).`,
      "rate_limited",
      {
        copyright: COPYRIGHT_NOTICE,
        audit_id: auditId,
        limit,
        window_ms: windowMs,
        retry_after_seconds: retryAfterSeconds,
      },
      429,
    );
  }

  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "remove_watermark", idempotencyKey);

  const body: Record<string, unknown> = {
    img: sourceUrl,
    bucket,
    ...(maskImageUrl ? { mask: maskImageUrl } : {}),
    ...(input.mask_rect ? { mask_rect: input.mask_rect } : {}),
  };

  try {
    const payload = await aiPost(ctx.env, removeWatermarkPath(ctx.env), body);
    const resultUrl = extractOutputUrl(payload);
    const requestId = deepFindString(payload, ["RequestId", "requestId", "request_id"]);

    auditRecord({
      event: "remove_watermark",
      audit_id: auditId,
      outcome: "ok",
      charge_id: billed.charge.charge_id,
      source_host: sourceHost,
      mask_mode: maskMode,
      has_result_url: Boolean(resultUrl),
    });

    return {
      ok: true,
      tool: "remove_watermark",
      audit_id: auditId,
      source_url: sourceUrl,
      mask_mode: maskMode,
      ...(input.mask_rect ? { mask_rect: input.mask_rect } : {}),
      bucket,
      result_url: resultUrl ?? null,
      ...(requestId ? { request_id: requestId } : {}),
      upstream_result: payload,
      expires_in_hours: 24,
      idempotency_key: idempotencyKey,
      charge: billed.charge,
      copyright: COPYRIGHT_NOTICE,
      note: resultUrl
        ? "Download the result promptly; upstream result URLs expire in about 24 hours."
        : "Upstream returned no result URL; inspect upstream_result or poll the upstream task id if present.",
    };
  } catch (error) {
    auditRecord({
      event: "remove_watermark",
      audit_id: auditId,
      outcome: "error",
      charge_id: billed.charge.charge_id,
      source_host: sourceHost,
      mask_mode: maskMode,
    });
    raiseAfterCharge(error, billed);
  }
}
