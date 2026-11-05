import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DEFAULT_COMPRESS_QUALITY,
  MAX_COMPRESS_INPUT_BYTES,
  MAX_COMPRESS_OUTPUT_BYTES,
  SERVICE_NAME,
  SERVICE_VERSION,
  costFor,
} from "./config";
import type { ToolContext } from "./env";
import { toolErrorResult, toolJsonResult } from "./errors";
import { cartoonize, cartoonizeInputSchema } from "./tools/cartoonize";
import { colorizePhoto, colorizePhotoInputSchema } from "./tools/colorize-photo";
import { compressImage, compressImageInputSchema } from "./tools/compress-image";
import { extendImage, extendImageInputSchema } from "./tools/extend-image";
import { removeBackground, removeBackgroundInputSchema } from "./tools/remove-background";
import { resizeImage, resizeImageInputSchema } from "./tools/resize-image";
import { upscaleImage, upscaleImageInputSchema } from "./tools/upscale-image";

function costLabel(cost: number): string {
  return cost === 0 ? "free" : `${cost} credit${cost === 1 ? "" : "s"}`;
}

function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Registers the ready image tools.
 * `erase_object` is deliberately not registered: `/api/inpaint` often returns
 * HTTP 500 HTML, and a listed tool would be billed for an empty failure.
 */
export function createImgkitsCoreServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });
  const colorizeCost = costFor(ctx.env, "colorize_photo");
  const upscaleCost = costFor(ctx.env, "upscale_image");
  const backgroundCost = costFor(ctx.env, "remove_background");
  const cartoonCost = costFor(ctx.env, "cartoonize");
  const extendCost = costFor(ctx.env, "extend_image");
  const resizeCost = costFor(ctx.env, "resize_image");
  const compressCost = costFor(ctx.env, "compress_image");

  server.registerTool(
    "colorize_photo",
    {
      title: "Colorize photo",
      description:
        "Colorize a photo from a public URL. POST {img} to ai.imgkits.com/api/deoldify (AiController Shangse). " +
        "Black-and-white photos work best; a response with a null URL is treated as failure. Synchronous. " +
        `Cost: ${costLabel(colorizeCost)} per call; mcp-credit-gateway charges before forwarding. ` +
        "Requires Authorization: Bearer sk_live_... on tools/call.",
      inputSchema: colorizePhotoInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: z.infer<typeof colorizePhotoInputSchema>) => {
      try {
        return toolJsonResult(await colorizePhoto(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "upscale_image",
    {
      title: "Upscale image",
      description:
        "Upscale an image from a public URL. POST {img, upscale} to ai.imgkits.com/api/restoration. " +
        "`scale` is 2 (default) or 4 and is sent as `upscale`. Optional `face_enhance` is sent on the same body. " +
        "There is no separate enhance_photo or enhance_face tool. Synchronous. " +
        `Cost: ${costLabel(upscaleCost)} per call; mcp-credit-gateway charges before forwarding.`,
      inputSchema: upscaleImageInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: z.infer<typeof upscaleImageInputSchema>) => {
      try {
        return toolJsonResult(await upscaleImage(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "remove_background",
    {
      title: "Remove background",
      description:
        "Remove the background of one image. GET usa.imgkits.com/ai/segment?pic=... " +
        "Optional subject head/cloth/commodity/animal/logo/body/furniture switches the path to /ai/segment<head|...>. " +
        `Synchronous. Cost: ${costLabel(backgroundCost)} per call, charged by mcp-credit-gateway before forwarding.`,
      inputSchema: removeBackgroundInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: z.infer<typeof removeBackgroundInputSchema>) => {
      try {
        return toolJsonResult(await removeBackground(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "cartoonize",
    {
      title: "Cartoonize photo",
      description:
        "Turn a photo into a cartoon. Default is POST {img} to api.imgkits.com/api/cartoonize (v1). " +
        "Pass style and/or variant to call /api/cartoonize/v2 with those fields. Synchronous. " +
        `Cost: ${costLabel(cartoonCost)} per call, charged by mcp-credit-gateway before forwarding.`,
      inputSchema: cartoonizeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: z.infer<typeof cartoonizeInputSchema>) => {
      try {
        return toolJsonResult(await cartoonize(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "extend_image",
    {
      title: "Extend image",
      description:
        'Outpaint an image. POST {pic, ratio} to usa.imgkits.com/ai/image-outpainting. ratio looks like "16:9". ' +
        "The upstream rejects a ratio equal to the source aspect. Synchronous. " +
        `Cost: ${costLabel(extendCost)} per call, charged by mcp-credit-gateway before forwarding.`,
      inputSchema: extendImageInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: z.infer<typeof extendImageInputSchema>) => {
      try {
        return toolJsonResult(await extendImage(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "resize_image",
    {
      title: "Resize image",
      description:
        "Resize an image to an exact pixel size. GET usa.imgkits.com/ai/change-img-size?pic&width&height. " +
        `Width and height are 1–8192. Synchronous. Cost: ${costLabel(resizeCost)} per call, charged by mcp-credit-gateway before forwarding.`,
      inputSchema: resizeImageInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: z.infer<typeof resizeImageInputSchema>) => {
      try {
        return toolJsonResult(await resizeImage(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "compress_image",
    {
      title: "Compress image",
      description:
        "Re-encode an image inside this Worker. No ImgKits upstream is called. " +
        `Input must be a direct image URL up to ${mb(MAX_COMPRESS_INPUT_BYTES)}; redirects are rejected. ` +
        `Optional max_width/max_height scale down only. quality 1–100 (default ${DEFAULT_COMPRESS_QUALITY}); format jpeg (default), webp, or png. ` +
        `The result is image_base64, capped at ${mb(MAX_COMPRESS_OUTPUT_BYTES)}. ` +
        "Uses the Cloudflare Images binding when present, otherwise Workers image resizing. " +
        `Cost: ${costLabel(compressCost)} per call, charged by mcp-credit-gateway before forwarding.`,
      inputSchema: compressImageInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: z.infer<typeof compressImageInputSchema>) => {
      try {
        return toolJsonResult(await compressImage(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}
