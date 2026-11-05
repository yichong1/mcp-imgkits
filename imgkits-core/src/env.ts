/**
 * Bindings and vars this Worker expects.
 *
 * Public ImgKits image upstreams do not use a Bearer token. Do not add a
 * frontend key or `UPSTREAM_API_TOKEN` here.
 *
 * `GATEWAY_SHARED_SECRET` is optional. When set, every non-public `/mcp`
 * request must also carry a matching `X-Gateway-Shared-Secret` header.
 *
 * `IMAGES` is the Cloudflare Images binding used by `compress_image`.
 */
export interface CfImageInfo {
  format?: string;
  fileSize?: number;
  width?: number;
  height?: number;
}

export interface CfImageResult {
  response(): Response;
  contentType(): string;
}

export interface CfImageTransformer {
  transform(transform: { width?: number; height?: number; fit?: "scale-down" }): CfImageTransformer;
  output(options: {
    format: "image/jpeg" | "image/png" | "image/webp";
    quality?: number;
  }): Promise<CfImageResult>;
}

export interface CfImages {
  input(stream: ReadableStream<Uint8Array>): CfImageTransformer;
  info?(stream: ReadableStream<Uint8Array>): Promise<CfImageInfo>;
}

export interface Env {
  GATEWAY_SHARED_SECRET?: string;
  IMAGES?: CfImages;

  /**
   * `"1"` allows direct workers.dev calls that lack the gateway channel header.
   * Grey-release self-test only; set to `"0"` once gateway wiring is live.
   */
  ALLOW_DIRECT_MCP?: string;

  AI_BASE_URL?: string;
  API_BASE_URL?: string;
  USA_BASE_URL?: string;
  COLORIZE_PATH?: string;
  UPSCALE_PATH?: string;
  CARTOONIZE_PATH?: string;
  CARTOONIZE_V2_PATH?: string;
  SEGMENT_PATH?: string;
  OUTPAINT_PATH?: string;
  RESIZE_PATH?: string;
  /** Documented target for the hidden erase_object stub. Never requested. */
  ERASE_PATH?: string;
  /** Optional restoration bucket. Omitted from the body when unset. */
  RESTORATION_BUCKET?: string;

  UPSTREAM_TIMEOUT_MS?: string;

  COST_COLORIZE_PHOTO?: string;
  COST_UPSCALE_IMAGE?: string;
  COST_REMOVE_BACKGROUND?: string;
  COST_CARTOONIZE?: string;
  COST_EXTEND_IMAGE?: string;
  COST_RESIZE_IMAGE?: string;
  COST_COMPRESS_IMAGE?: string;
}

/** Per-request context handed to every tool implementation. */
export interface ToolContext {
  env: Env;
  /** The caller's `sk_live_...` token. Never persisted or logged. */
  authToken: string;
  /** Optional `X-Mcp-Charge-Id` forwarded by mcp-credit-gateway. */
  chargeId?: string;
  /** Optional `X-Access-Channel` (e.g. `mcp-gateway`). */
  accessChannel?: string;
}
