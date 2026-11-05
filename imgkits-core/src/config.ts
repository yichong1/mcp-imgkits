import type { Env } from "./env";

export const SERVICE_NAME = "mcp-imgkits-core";
export const SERVICE_VERSION = "0.1.0";
export const MCP_ROUTE = "/mcp";

export const DEFAULT_AI_BASE_URL = "https://ai.imgkits.com";
export const DEFAULT_API_BASE_URL = "https://api.imgkits.com";
export const DEFAULT_USA_BASE_URL = "https://usa.imgkits.com";

export const DEFAULT_COLORIZE_PATH = "/api/deoldify";
export const DEFAULT_UPSCALE_PATH = "/api/restoration";
export const DEFAULT_CARTOONIZE_PATH = "/api/cartoonize";
export const DEFAULT_CARTOONIZE_V2_PATH = "/api/cartoonize/v2";
export const DEFAULT_SEGMENT_PATH = "/ai/segment";
export const DEFAULT_OUTPAINT_PATH = "/ai/image-outpainting";
export const DEFAULT_RESIZE_PATH = "/ai/change-img-size";
/** Hidden stub only. The Worker does not call this path. */
export const DEFAULT_ERASE_PATH = "/api/inpaint";

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 45_000;

/** Expected `X-Access-Channel` value for requests forwarded by the gateway. */
export const GATEWAY_ACCESS_CHANNEL = "mcp-gateway";

export const MAX_SOURCE_URL_CHARS = 2048;
export const MAX_COMPRESS_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_COMPRESS_OUTPUT_BYTES = 1_500_000;
export const DEFAULT_COMPRESS_QUALITY = 75;
export const MAX_IMAGE_EDGE = 8192;

/**
 * Tools returned by `tools/list` and `/health`. `erase_object` is intentionally
 * absent: the inpaint upstream often returns HTTP 500 HTML, so it is not ready.
 */
export const VISIBLE_TOOLS = [
  "colorize_photo",
  "upscale_image",
  "remove_background",
  "cartoonize",
  "extend_image",
  "resize_image",
  "compress_image",
] as const;

export type VisibleTool = (typeof VISIBLE_TOOLS)[number];

export const HIDDEN_TOOLS = ["erase_object"] as const;

export const SEGMENT_SUBJECTS = [
  "general",
  "head",
  "cloth",
  "commodity",
  "animal",
  "logo",
  "body",
  "furniture",
] as const;
export type SegmentSubject = (typeof SEGMENT_SUBJECTS)[number];

export const UPSCALE_FACTORS = [2, 4] as const;
export type UpscaleFactor = (typeof UPSCALE_FACTORS)[number];

export type BillableTool = VisibleTool;

export const DEFAULT_COSTS: Record<BillableTool, number> = {
  colorize_photo: 2,
  upscale_image: 2,
  remove_background: 2,
  cartoonize: 2,
  extend_image: 2,
  resize_image: 1,
  compress_image: 1,
};

const COST_VARS: Record<BillableTool, keyof Env> = {
  colorize_photo: "COST_COLORIZE_PHOTO",
  upscale_image: "COST_UPSCALE_IMAGE",
  remove_background: "COST_REMOVE_BACKGROUND",
  cartoonize: "COST_CARTOONIZE",
  extend_image: "COST_EXTEND_IMAGE",
  resize_image: "COST_RESIZE_IMAGE",
  compress_image: "COST_COMPRESS_IMAGE",
};

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

/** Cost in credits for one tool call. `0` means the tool is free. */
export function costFor(env: Env, tool: BillableTool): number {
  return positiveInt(env[COST_VARS[tool]] as string | undefined, DEFAULT_COSTS[tool]);
}

function baseUrl(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/, "");
}

function pathFromEnv(value: string | undefined, fallback: string): string {
  const path = value?.trim();
  if (!path) return fallback;
  return path.startsWith("/") ? path : `/${path}`;
}

export function aiBaseUrl(env: Env): string {
  return baseUrl(env.AI_BASE_URL, DEFAULT_AI_BASE_URL);
}

export function apiBaseUrl(env: Env): string {
  return baseUrl(env.API_BASE_URL, DEFAULT_API_BASE_URL);
}

export function usaBaseUrl(env: Env): string {
  return baseUrl(env.USA_BASE_URL, DEFAULT_USA_BASE_URL);
}

export function colorizePath(env: Env): string {
  return pathFromEnv(env.COLORIZE_PATH, DEFAULT_COLORIZE_PATH);
}

export function upscalePath(env: Env): string {
  return pathFromEnv(env.UPSCALE_PATH, DEFAULT_UPSCALE_PATH);
}

export function cartoonizePath(env: Env): string {
  return pathFromEnv(env.CARTOONIZE_PATH, DEFAULT_CARTOONIZE_PATH);
}

export function cartoonizeV2Path(env: Env): string {
  return pathFromEnv(env.CARTOONIZE_V2_PATH, DEFAULT_CARTOONIZE_V2_PATH);
}

export function segmentPath(env: Env, subject: SegmentSubject = "general"): string {
  if (subject === "general") return pathFromEnv(env.SEGMENT_PATH, DEFAULT_SEGMENT_PATH);
  return `/ai/segment${subject}`;
}

export function outpaintPath(env: Env): string {
  return pathFromEnv(env.OUTPAINT_PATH, DEFAULT_OUTPAINT_PATH);
}

export function resizePath(env: Env): string {
  return pathFromEnv(env.RESIZE_PATH, DEFAULT_RESIZE_PATH);
}

export function erasePath(env: Env): string {
  return pathFromEnv(env.ERASE_PATH, DEFAULT_ERASE_PATH);
}

/** Empty string means "do not send a bucket". */
export function restorationBucket(env: Env): string {
  return env.RESTORATION_BUCKET?.trim() ?? "";
}

export function upstreamTimeoutMs(env: Env): number {
  return positiveInt(env.UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS);
}

/**
 * Direct workers.dev calls are a grey-release self-test escape hatch only.
 * Anything other than an explicit `ALLOW_DIRECT_MCP=1` fails closed.
 */
export function directMcpAllowed(env: Env): boolean {
  return env.ALLOW_DIRECT_MCP?.trim() === "1";
}
