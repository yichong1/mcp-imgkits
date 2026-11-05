import { z } from "zod";
import {
  DEFAULT_COMPRESS_QUALITY,
  MAX_COMPRESS_INPUT_BYTES,
  MAX_COMPRESS_OUTPUT_BYTES,
  MAX_IMAGE_EDGE,
  MAX_SOURCE_URL_CHARS,
  upstreamTimeoutMs,
} from "../config";
import type { CfImages, ToolContext } from "../env";
import { ToolError, UpstreamError, errorMessage } from "../errors";
import { assertPublicUrl } from "../urls";
import { sourceHost, withImageCall, type BilledCall } from "./common";

const OUTPUT_FORMATS = {
  jpeg: "image/jpeg",
  webp: "image/webp",
  png: "image/png",
} as const;

export const compressImageInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .describe(
      `Public http(s) image URL. Direct URL only (redirects are rejected). Max input ${MAX_COMPRESS_INPUT_BYTES} bytes. ` +
        "The Worker re-encodes the bytes itself; it does not call an ImgKits upstream.",
    ),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(DEFAULT_COMPRESS_QUALITY)
    .describe(`JPEG/WebP quality, 1–100 (default ${DEFAULT_COMPRESS_QUALITY}). PNG ignores quality.`),
  max_width: z
    .number()
    .int()
    .min(16)
    .max(MAX_IMAGE_EDGE)
    .optional()
    .describe("Optional maximum width. The image is scaled down to fit; it is never upscaled."),
  max_height: z
    .number()
    .int()
    .min(16)
    .max(MAX_IMAGE_EDGE)
    .optional()
    .describe("Optional maximum height. The image is scaled down to fit; it is never upscaled."),
  format: z
    .enum(["jpeg", "webp", "png"])
    .default("jpeg")
    .describe("Output format. Default jpeg."),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type CompressImageInput = z.input<typeof compressImageInputSchema>;

interface EncodedImage {
  bytes: Uint8Array;
  contentType: string;
  width?: number;
  height?: number;
}

interface DownloadedImage {
  bytes: Uint8Array;
  contentType: string;
}

function toStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Download a public image. Redirects are rejected. Runs before billing. */
export async function fetchPublicImage(ctx: ToolContext, url: string): Promise<DownloadedImage> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "image/*,*/*;q=0.8",
        "user-agent": "mcp-imgkits-core/0.1.0",
      },
      signal: AbortSignal.timeout(upstreamTimeoutMs(ctx.env)),
    });
  } catch (error) {
    throw new UpstreamError(
      `Could not download source_url (${errorMessage(error)}).`,
      undefined,
      "image_download_failed",
    );
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ToolError(
      "source_url redirected. Pass a direct image URL; this Worker does not follow redirects.",
      "image_redirect",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolError(`source_url returned HTTP ${response.status}.`, "image_download_failed");
  }

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    await response.body?.cancel();
    throw new ToolError("source_url did not return an image content type.", "invalid_image");
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_COMPRESS_INPUT_BYTES) {
    await response.body?.cancel();
    throw new ToolError(
      `source_url is larger than ${MAX_COMPRESS_INPUT_BYTES} bytes.`,
      "image_too_large",
    );
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new ToolError("source_url returned an empty image.", "invalid_image");
  }
  if (buffer.byteLength > MAX_COMPRESS_INPUT_BYTES) {
    throw new ToolError(
      `source_url is larger than ${MAX_COMPRESS_INPUT_BYTES} bytes.`,
      "image_too_large",
    );
  }
  return { bytes: new Uint8Array(buffer), contentType };
}

async function encodeWithBinding(
  images: CfImages,
  input: CompressImageInput,
  downloaded: DownloadedImage,
): Promise<EncodedImage> {
  const format = OUTPUT_FORMATS[input.format ?? "jpeg"];
  const quality = input.quality ?? DEFAULT_COMPRESS_QUALITY;
  let chain = images.input(toStream(downloaded.bytes));
  if (input.max_width !== undefined || input.max_height !== undefined) {
    chain = chain.transform({
      fit: "scale-down",
      ...(input.max_width !== undefined ? { width: input.max_width } : {}),
      ...(input.max_height !== undefined ? { height: input.max_height } : {}),
    });
  }
  const encoded = await chain.output({ format, quality });
  const response = encoded.response();
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = encoded.contentType() || response.headers.get("content-type") || format;

  let width: number | undefined;
  let height: number | undefined;
  if (images.info) {
    try {
      const info = await images.info(toStream(bytes));
      if (typeof info.width === "number") width = info.width;
      if (typeof info.height === "number") height = info.height;
    } catch {
      // Dimensions are optional metadata.
    }
  }
  return { bytes, contentType, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
}

async function encodeWithCfImage(
  ctx: ToolContext,
  sourceUrl: string,
  input: CompressImageInput,
): Promise<EncodedImage> {
  const format = input.format ?? "jpeg";
  const quality = input.quality ?? DEFAULT_COMPRESS_QUALITY;
  const image: Record<string, unknown> = {
    format,
    quality,
    fit: "scale-down",
  };
  if (input.max_width !== undefined) image.width = input.max_width;
  if (input.max_height !== undefined) image.height = input.max_height;

  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      method: "GET",
      redirect: "manual",
      cf: { image },
      signal: AbortSignal.timeout(upstreamTimeoutMs(ctx.env)),
    } as RequestInit);
  } catch (error) {
    throw new ToolError(
      `Cloudflare image resize failed (${errorMessage(error)}). Configure the IMAGES binding.`,
      "compress_unavailable",
    );
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ToolError("Cloudflare image resize returned a redirect.", "compress_unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolError(
      `Cloudflare image resize returned HTTP ${response.status}. Configure the IMAGES binding.`,
      "compress_unavailable",
    );
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    await response.body?.cancel();
    throw new ToolError(
      "Cloudflare image resize did not return an image. The IMAGES binding is required on this account.",
      "compress_unavailable",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, contentType };
}

function assertOutputSize(bytes: Uint8Array): void {
  if (bytes.byteLength === 0) {
    throw new ToolError("Image encode produced an empty file.", "compress_failed");
  }
  if (bytes.byteLength > MAX_COMPRESS_OUTPUT_BYTES) {
    throw new ToolError(
      `Encoded image is ${bytes.byteLength} bytes, above the ${MAX_COMPRESS_OUTPUT_BYTES}-byte MCP payload limit. ` +
        "Lower quality or max_width/max_height.",
      "image_too_large",
    );
  }
}

export async function compressImage(ctx: ToolContext, input: CompressImageInput): Promise<Record<string, unknown>> {
  const sourceUrl = assertPublicUrl(input.source_url, "source_url");
  const format = input.format ?? "jpeg";
  const quality = input.quality ?? DEFAULT_COMPRESS_QUALITY;
  // Download before billing so an oversized or non-image URL is not reported as a charged failure.
  const images = ctx.env.IMAGES;
  const downloaded = images ? await fetchPublicImage(ctx, sourceUrl) : undefined;
  const host = sourceHost(sourceUrl);

  return withImageCall(ctx, "compress_image", input.idempotency_key, host, async (billed, auditId) => {
    const encoded = images
      ? await encodeWithBinding(images, { ...input, format, quality }, downloaded as DownloadedImage)
      : await encodeWithCfImage(ctx, sourceUrl, { ...input, format, quality });
    assertOutputSize(encoded.bytes);
    return compressResult({
      auditId,
      sourceUrl,
      billed,
      format,
      quality,
      maxWidth: input.max_width,
      maxHeight: input.max_height,
      encoder: images ? "images-binding" : "cf-image",
      contentType: encoded.contentType,
      bytes: encoded.bytes,
      width: encoded.width,
      height: encoded.height,
    });
  });
}

function compressResult(options: {
  auditId: string;
  sourceUrl: string;
  billed: BilledCall;
  format: string;
  quality: number;
  maxWidth?: number;
  maxHeight?: number;
  encoder: "images-binding" | "cf-image";
  contentType: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
}): Record<string, unknown> {
  return {
    ok: true,
    tool: "compress_image",
    audit_id: options.auditId,
    source_url: options.sourceUrl,
    mime_type: options.contentType,
    format: options.format,
    quality: options.quality,
    ...(options.maxWidth !== undefined ? { max_width: options.maxWidth } : {}),
    ...(options.maxHeight !== undefined ? { max_height: options.maxHeight } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    bytes: options.bytes.byteLength,
    encoder: options.encoder,
    image_base64: bytesToBase64(options.bytes),
    idempotency_key: options.billed.idempotencyKey,
    charge: options.billed.charge,
    limits: {
      max_input_bytes: MAX_COMPRESS_INPUT_BYTES,
      max_output_bytes: MAX_COMPRESS_OUTPUT_BYTES,
      redirects: "rejected",
      storage: "none",
    },
    note:
      "Pure Worker re-encode. No ImgKits upstream is called and no result URL is stored. " +
      "Decode image_base64. Input must be a direct image URL up to 8 MB; output is capped at 1.5 MB.",
  };
}
