import { z } from "zod";
import {
  MAX_BLIND_WATERMARK_TEXT_CHARS,
  MAX_IMAGE_BYTES,
  MAX_SOURCE_URL_CHARS,
  blindEncodePath,
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

export const embedBlindWatermarkInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .describe(
      `Public http(s) URL of the source image (JPG/PNG/WebP/BMP, <= ${MAX_IMAGE_BYTES / (1024 * 1024)} MB). ` +
        "Recommended at least 64x64 px so the blind watermark survives compression.",
    ),
  watermark_text: z
    .string()
    .min(1)
    .max(MAX_BLIND_WATERMARK_TEXT_CHARS)
    .optional()
    .describe(
      `Content to embed invisibly (<= ${MAX_BLIND_WATERMARK_TEXT_CHARS} chars), e.g. an order id or user id. ` +
        "Omit to use the server-held BLIND_WATERMARK_KEY. The content is never echoed back in the result.",
    ),
  model: z
    .enum(["DWT", "DCT"])
    .default("DWT")
    .describe("Blind-watermark algorithm. DWT is more robust to scaling; DCT is faster."),
  strength: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Optional embedding strength, 1–10. Higher survives more editing but is slightly more visible."),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type EmbedBlindWatermarkInput = z.infer<typeof embedBlindWatermarkInputSchema>;

function resolveWatermarkContent(ctx: ToolContext, supplied?: string): { content: string; source: "caller" | "server_key" } {
  const caller = supplied?.trim();
  if (caller) {
    if (caller.length > MAX_BLIND_WATERMARK_TEXT_CHARS) {
      throw new ToolError(
        `watermark_text is limited to ${MAX_BLIND_WATERMARK_TEXT_CHARS} characters.`,
        "text_too_long",
      );
    }
    return { content: caller, source: "caller" };
  }

  const serverKey = ctx.env.BLIND_WATERMARK_KEY?.trim();
  if (!serverKey) {
    throw new ToolError(
      "Provide watermark_text, or configure the BLIND_WATERMARK_KEY secret to embed a server-held watermark.",
      "watermark_content_missing",
    );
  }
  if (serverKey.length > MAX_BLIND_WATERMARK_TEXT_CHARS) {
    throw new ToolError(
      `BLIND_WATERMARK_KEY is limited to ${MAX_BLIND_WATERMARK_TEXT_CHARS} characters.`,
      "server_key_invalid",
    );
  }
  return { content: serverKey, source: "server_key" };
}

export async function embedBlindWatermark(
  ctx: ToolContext,
  input: EmbedBlindWatermarkInput,
): Promise<Record<string, unknown>> {
  const sourceUrl = assertPublicUrl(input.source_url, "source_url");
  const watermark = resolveWatermarkContent(ctx, input.watermark_text);

  requireUpstreamConfigured(ctx);
  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "embed_blind_watermark", idempotencyKey);
  const auditId = newAuditId();
  const sourceHost = new URL(sourceUrl).hostname;

  // Mirrors AiController::actionEncodeBlindWatermark: JSON `payload` object
  // carrying SourceURI. The ai.imgkits.com endpoint resolves the OSS target.
  const body = {
    payload: {
      SourceURI: sourceUrl,
      Content: watermark.content,
      Model: input.model,
      ...(input.strength !== undefined ? { Strength: input.strength } : {}),
    },
  };

  try {
    const payload = await aiPost(ctx.env, blindEncodePath(ctx.env), body);
    const targetUrl = extractOutputUrl(payload);
    const requestId = deepFindString(payload, ["RequestId", "requestId", "request_id"]);

    auditRecord({
      event: "embed_blind_watermark",
      audit_id: auditId,
      outcome: "ok",
      charge_id: billed.charge.charge_id,
      source_host: sourceHost,
      watermark_source: watermark.source,
      model: input.model,
      has_target_url: Boolean(targetUrl),
    });

    return {
      ok: true,
      tool: "embed_blind_watermark",
      audit_id: auditId,
      source_url: sourceUrl,
      target_url: targetUrl ?? null,
      watermark_source: watermark.source,
      watermark_chars: watermark.content.length,
      model: input.model,
      ...(input.strength !== undefined ? { strength: input.strength } : {}),
      ...(requestId ? { request_id: requestId } : {}),
      upstream_result: payload,
      expires_in_hours: 24,
      idempotency_key: idempotencyKey,
      charge: billed.charge,
      note:
        watermark.source === "server_key"
          ? "Embedded the server-held blind watermark. The content is intentionally not returned."
          : "The embedded content is intentionally not echoed back; keep your own record of it.",
    };
  } catch (error) {
    auditRecord({
      event: "embed_blind_watermark",
      audit_id: auditId,
      outcome: "error",
      charge_id: billed.charge.charge_id,
      source_host: sourceHost,
      watermark_source: watermark.source,
      model: input.model,
    });
    raiseAfterCharge(error, billed);
  }
}
