import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  COPYRIGHT_NOTICE,
  DEFAULT_DECODE_WAIT_SECONDS,
  MAX_BLIND_WATERMARK_TEXT_CHARS,
  MAX_DECODE_WAIT_SECONDS,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_WATERMARK_IMAGE_BYTES,
  MAX_WATERMARK_TEXT_CHARS,
  SERVICE_NAME,
  SERVICE_VERSION,
  costFor,
} from "./config";
import type { ToolContext } from "./env";
import { toolErrorResult, toolJsonResult } from "./errors";
import { addWatermark, addWatermarkInputSchema } from "./tools/add-watermark";
import { decodeBlindWatermark, decodeBlindWatermarkInputSchema } from "./tools/decode-blind-watermark";
import { embedBlindWatermark, embedBlindWatermarkInputSchema } from "./tools/embed-blind-watermark";
import { removeWatermark, removeWatermarkInputSchema } from "./tools/remove-watermark";

function costLabel(cost: number): string {
  return cost === 0 ? "free" : `${cost} credit${cost === 1 ? "" : "s"}`;
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function createMarkAnyServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });
  const addCost = costFor(ctx.env, "add_watermark");
  const removeCost = costFor(ctx.env, "remove_watermark");
  const embedCost = costFor(ctx.env, "embed_blind_watermark");
  const decodeCost = costFor(ctx.env, "decode_blind_watermark");

  server.registerTool(
    "add_watermark",
    {
      title: "Add watermark",
      description:
        `Add a visible text or image watermark to an image or PDF supplied as a public URL. ` +
        `Formats: JPG/PNG/WebP images up to ${mb(MAX_IMAGE_BYTES)} MB; PDF up to ${mb(MAX_PDF_BYTES)} MB. ` +
        `watermark_type=text requires \`text\` (<= ${MAX_WATERMARK_TEXT_CHARS} chars); ` +
        `watermark_type=image requires \`watermark_image_url\` (PNG/JPG/WebP, <= ${mb(MAX_WATERMARK_IMAGE_BYTES)} MB, transparency supported). ` +
        `Position: top-left/top-center/top-right/center/bottom-left/bottom-center/bottom-right/tile. ` +
        `opacity 0.05-1, optional scale/font_size/color/rotation. For PDF, pass \`pages\` (e.g. "1-3,5") to limit pages. ` +
        `Synchronous. Cost: ${costLabel(addCost)} per call; mcp-credit-gateway charges before forwarding the request. ` +
        `Requires Authorization: Bearer sk_live_... on the MCP endpoint.`,
      inputSchema: addWatermarkInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof addWatermarkInputSchema>) => {
      try {
        return toolJsonResult(await addWatermark(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "remove_watermark",
    {
      title: "Remove watermark (authorized material only)",
      description:
        `AI watermark removal / inpainting for ONE image (JPG/PNG/WebP, <= ${mb(MAX_IMAGE_BYTES)} MB) supplied as a public URL. ` +
        `Optional \`mask_image_url\` (white = remove) or normalized \`mask_rect\` {x,y,width,height} in 0-1; ` +
        `with neither, the upstream auto-detect mode is used (support depends on the upstream). ` +
        `COPYRIGHT / ABUSE GATE: ${COPYRIGHT_NOTICE} ` +
        `This tool is metered per call, accepts a single image per request, and returns an audit_id; ` +
        `bulk/automated third-party stripping is prohibited and may be blocked or reported. ` +
        `Cost: ${costLabel(removeCost)} per call; mcp-credit-gateway charges before forwarding the request.`,
      inputSchema: removeWatermarkInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof removeWatermarkInputSchema>) => {
      try {
        return toolJsonResult(await removeWatermark(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "embed_blind_watermark",
    {
      title: "Embed blind watermark",
      description:
        `Embed an invisible/blind watermark into an image supplied as a public URL (JPG/PNG/WebP/BMP, <= ${mb(MAX_IMAGE_BYTES)} MB; ` +
        `at least 64x64 px recommended). Uses the AiController EncodeBlindWatermark / Alibaba Cloud IMM path. ` +
        `Pass \`watermark_text\` (<= ${MAX_BLIND_WATERMARK_TEXT_CHARS} chars, e.g. an order id), or omit it to use the server-held ` +
        `BLIND_WATERMARK_KEY secret; the embedded content is never echoed back. \`model\` is DWT (default, more robust) or DCT; ` +
        `optional \`strength\` 1-10. Synchronous. Cost: ${costLabel(embedCost)} per call, charged by mcp-credit-gateway before forwarding.`,
      inputSchema: embedBlindWatermarkInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof embedBlindWatermarkInputSchema>) => {
      try {
        return toolJsonResult(await embedBlindWatermark(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "decode_blind_watermark",
    {
      title: "Decode blind watermark",
      description:
        `Read a blind watermark from an image (public http(s) URL). Uses the AiController CreateDecodeBlindWatermarkTask + ` +
        `GetDecodeBlindWatermarkResult async path. Start with \`source_url\`; the call waits up to \`wait_seconds\` ` +
        `(default ${DEFAULT_DECODE_WAIT_SECONDS}, max ${MAX_DECODE_WAIT_SECONDS}) and returns a \`job_id\` if still running. ` +
        `Poll by calling again with only \`job_id\`; polling never creates a new upstream decode task. ` +
        `Returns \`content\` when readable. Cost: ${costLabel(decodeCost)} per call, charged by mcp-credit-gateway before forwarding.`,
      inputSchema: decodeBlindWatermarkInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof decodeBlindWatermarkInputSchema>) => {
      try {
        return toolJsonResult(await decodeBlindWatermark(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}
