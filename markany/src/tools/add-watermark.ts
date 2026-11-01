import { z } from "zod";
import {
  MAX_PDF_BYTES,
  MAX_IMAGE_BYTES,
  MAX_SOURCE_URL_CHARS,
  MAX_WATERMARK_IMAGE_BYTES,
  MAX_WATERMARK_TEXT_CHARS,
  WATERMARK_POSITIONS,
  addWatermarkPath,
} from "../config";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";
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

export const addWatermarkInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .describe(
      `Public http(s) URL of the source image (JPG/PNG/WebP, <= ${MAX_IMAGE_BYTES / (1024 * 1024)} MB) ` +
        `or PDF (<= ${MAX_PDF_BYTES / (1024 * 1024)} MB).`,
    ),
  source_type: z
    .enum(["image", "pdf"])
    .optional()
    .describe("Optional. Defaults to PDF when source_url ends in .pdf, otherwise image."),
  watermark_type: z
    .enum(["text", "image"])
    .describe("`text` stamps words; `image` overlays a logo/PNG watermark."),
  text: z
    .string()
    .min(1)
    .max(MAX_WATERMARK_TEXT_CHARS)
    .optional()
    .describe(`Watermark text, required when watermark_type=text (<= ${MAX_WATERMARK_TEXT_CHARS} chars).`),
  watermark_image_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .optional()
    .describe(
      `Public PNG/JPG/WebP watermark image URL, required when watermark_type=image ` +
        `(<= ${MAX_WATERMARK_IMAGE_BYTES / (1024 * 1024)} MB; transparency supported).`,
    ),
  position: z
    .enum(WATERMARK_POSITIONS)
    .default("bottom-right")
    .describe("Anchor for the watermark, or `tile` to repeat it across the page/image."),
  opacity: z.number().min(0.05).max(1).default(0.35).describe("Watermark opacity, 0.05–1 (default 0.35)."),
  scale: z
    .number()
    .min(0.02)
    .max(0.95)
    .optional()
    .describe("Image watermark width as a fraction of the source width, 0.02–0.95."),
  font_size: z
    .number()
    .int()
    .min(8)
    .max(256)
    .optional()
    .describe("Text watermark font size in pixels (images) or points (PDF), 8–256."),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe("Text colour as #RRGGBB. Defaults to upstream choice (usually white)."),
  rotation: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe("Clockwise rotation in degrees, -180 to 180 (e.g. 45 for a diagonal stamp)."),
  pages: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('PDF only. 1-based page selection such as "1", "1-3" or "1-3,5,8-10".'),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type AddWatermarkInput = z.infer<typeof addWatermarkInputSchema>;

function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function validatePageRange(pages: string): string {
  const value = pages.trim();
  if (!/^\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*$/.test(value)) {
    throw new ToolError('pages must look like "1", "1-3" or "1-3,5,8-10".', "invalid_page_range");
  }
  for (const part of value.split(",")) {
    const [rawStart, rawEnd] = part.split("-").map((item) => Number(item.trim()));
    if (!Number.isInteger(rawStart) || rawStart < 1 || rawStart > 10_000) {
      throw new ToolError("PDF page numbers are 1-based and must be between 1 and 10,000.", "invalid_page_range");
    }
    if (rawEnd !== undefined) {
      if (!Number.isInteger(rawEnd) || rawEnd < rawStart || rawEnd > 10_000) {
        throw new ToolError("A PDF page range must be ascending and within 1–10,000.", "invalid_page_range");
      }
    }
  }
  return value;
}

export async function addWatermark(
  ctx: ToolContext,
  input: AddWatermarkInput,
): Promise<Record<string, unknown>> {
  const sourceUrl = assertPublicUrl(input.source_url, "source_url");

  if (input.watermark_type === "text") {
    if (!input.text?.trim()) {
      throw new ToolError("watermark_type=text requires a non-empty `text` parameter.", "invalid_arguments");
    }
    if (input.watermark_image_url) {
      throw new ToolError("Do not send `watermark_image_url` when watermark_type=text.", "invalid_arguments");
    }
  } else {
    if (!input.watermark_image_url) {
      throw new ToolError(
        "watermark_type=image requires a `watermark_image_url` (public PNG/JPG/WebP).",
        "invalid_arguments",
      );
    }
    if (input.text) {
      throw new ToolError("Do not send `text` when watermark_type=image.", "invalid_arguments");
    }
  }

  const watermarkImageUrl = input.watermark_image_url
    ? assertPublicUrl(input.watermark_image_url, "watermark_image_url")
    : undefined;

  const sourceType = input.source_type ?? (isPdfUrl(sourceUrl) ? "pdf" : "image");
  if (input.pages && sourceType !== "pdf") {
    throw new ToolError("`pages` is only supported when the source is a PDF.", "invalid_arguments");
  }
  const pages = input.pages ? validatePageRange(input.pages) : undefined;

  if (input.watermark_type === "text" && input.text!.length > MAX_WATERMARK_TEXT_CHARS) {
    throw new ToolError(`Watermark text is limited to ${MAX_WATERMARK_TEXT_CHARS} characters.`, "text_too_long");
  }
  if (input.watermark_type === "image" && input.watermark_image_url!.length > MAX_SOURCE_URL_CHARS) {
    throw new ToolError("watermark_image_url is too long.", "invalid_url");
  }

  requireUpstreamConfigured(ctx);
  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "add_watermark", idempotencyKey);
  const auditId = newAuditId();

  const body: Record<string, unknown> = {
    source_url: sourceUrl,
    source_type: sourceType,
    type: input.watermark_type,
    position: input.position,
    opacity: input.opacity,
    ...(input.watermark_type === "text" ? { text: input.text!.trim() } : {}),
    ...(watermarkImageUrl ? { watermark_image: watermarkImageUrl } : {}),
    ...(input.scale !== undefined ? { scale: input.scale } : {}),
    ...(input.font_size !== undefined ? { font_size: input.font_size } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.rotation !== undefined ? { rotation: input.rotation } : {}),
    ...(pages ? { pages } : {}),
  };

  try {
    const payload = await aiPost(ctx.env, addWatermarkPath(ctx.env), body);
    const resultUrl = extractOutputUrl(payload);
    const requestId = deepFindString(payload, ["RequestId", "requestId", "request_id"]);

    auditRecord({
      event: "add_watermark",
      audit_id: auditId,
      outcome: "ok",
      charge_id: billed.charge.charge_id,
      source_host: new URL(sourceUrl).hostname,
      source_type: sourceType,
      watermark_type: input.watermark_type,
      position: input.position,
      has_result_url: Boolean(resultUrl),
    });

    return {
      ok: true,
      tool: "add_watermark",
      audit_id: auditId,
      source_url: sourceUrl,
      source_type: sourceType,
      watermark_type: input.watermark_type,
      position: input.position,
      opacity: input.opacity,
      ...(pages ? { pages } : {}),
      result_url: resultUrl ?? null,
      ...(requestId ? { request_id: requestId } : {}),
      upstream_result: payload,
      expires_in_hours: 24,
      idempotency_key: idempotencyKey,
      charge: billed.charge,
      note: resultUrl
        ? "Download the result promptly; upstream result URLs expire in about 24 hours."
        : "Upstream returned no result URL; inspect upstream_result or poll the upstream task id if one is present.",
    };
  } catch (error) {
    auditRecord({
      event: "add_watermark",
      audit_id: auditId,
      outcome: "error",
      charge_id: billed.charge.charge_id,
      source_host: new URL(sourceUrl).hostname,
      watermark_type: input.watermark_type,
    });
    raiseAfterCharge(error, billed);
  }
}
