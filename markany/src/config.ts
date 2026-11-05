import type { Env } from "./env";

export const SERVICE_NAME = "mcp-markany";
export const SERVICE_VERSION = "0.1.0";
export const MCP_ROUTE = "/mcp";

/** Single upstream base for every watermark capability. */
export const DEFAULT_AI_BASE_URL = "https://ai.imgkits.com";

/**
 * Add-watermark endpoint. No confirmed single modern REST path exists in the
 * reference material, so this is a documented placeholder. Override it with
 * `ADD_WATERMARK_PATH` once the upstream path is signed off.
 */
export const DEFAULT_ADD_WATERMARK_PATH = "/api/watermark";
export const DEFAULT_REMOVE_WATERMARK_PATH = "/api/inpaint";

/** Mirrors AiController::actionEncodeBlindWatermark / Decode / GetDecode. */
export const DEFAULT_BLIND_ENCODE_PATH = "/index.php?r=ai/encode-blind-watermark";
export const DEFAULT_BLIND_DECODE_PATH = "/index.php?r=ai/decode-blind-watermark";
export const DEFAULT_BLIND_RESULT_PATH = "/index.php?r=ai/get-decode-blind-watermark";

export const DEFAULT_INPAINT_BUCKET = "imgkits";
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
export const DEFAULT_JOB_POLL_INTERVAL_MS = 2_000;

/** Expected `X-Access-Channel` value for requests forwarded by the gateway. */
export const GATEWAY_ACCESS_CHANNEL = "mcp-gateway";

/** Documented limits (mirrored in tool descriptions and README). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 30 * 1024 * 1024;
export const MAX_WATERMARK_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_WATERMARK_TEXT_CHARS = 500;
export const MAX_BLIND_WATERMARK_TEXT_CHARS = 512;
export const MAX_SOURCE_URL_CHARS = 2048;
export const DEFAULT_DECODE_WAIT_SECONDS = 15;
export const MAX_DECODE_WAIT_SECONDS = 60;

/** Nine anchor positions plus tiling for visible watermarks. */
export const WATERMARK_POSITIONS = [
  "top-left",
  "top-center",
  "top-right",
  "center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
  "tile",
] as const;
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number];

/**
 * Copyright / abuse gate shown in the remove_watermark description, the README
 * and every remove_watermark result. Keep this wording in sync with README.
 */
export const COPYRIGHT_NOTICE =
  "Use only on images you own or are explicitly licensed/authorized to edit. " +
  "Do not remove copyright, ownership, attribution or license watermarks from third-party material, " +
  "and do not bulk-strip watermarks from other people's content. " +
  "Calls are rate-limited/metered by mcp-credit-gateway, require a valid sk_live_ key, " +
  "and every attempt (including failures) is logged with an audit id for review. " +
  "（仅处理自有或已获授权素材；禁止批量剥离他人版权水印；调用限频；失败可审计。）";

export type BillableTool =
  | "add_watermark"
  | "remove_watermark"
  | "embed_blind_watermark"
  | "decode_blind_watermark";

export const DEFAULT_COSTS: Record<BillableTool, number> = {
  add_watermark: 2,
  remove_watermark: 3,
  embed_blind_watermark: 2,
  decode_blind_watermark: 2,
};

const COST_VARS: Record<BillableTool, keyof Env> = {
  add_watermark: "COST_ADD_WATERMARK",
  remove_watermark: "COST_REMOVE_WATERMARK",
  embed_blind_watermark: "COST_EMBED_BLIND_WATERMARK",
  decode_blind_watermark: "COST_DECODE_BLIND_WATERMARK",
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

export function aiBaseUrl(env: Env): string {
  return (env.AI_BASE_URL?.trim() || DEFAULT_AI_BASE_URL).replace(/\/+$/, "");
}

function pathFromEnv(value: string | undefined, fallback: string): string {
  const path = value?.trim();
  if (!path) return fallback;
  return path.startsWith("/") ? path : `/${path}`;
}

export function addWatermarkPath(env: Env): string {
  return pathFromEnv(env.ADD_WATERMARK_PATH, DEFAULT_ADD_WATERMARK_PATH);
}

export function removeWatermarkPath(env: Env): string {
  return pathFromEnv(env.REMOVE_WATERMARK_PATH, DEFAULT_REMOVE_WATERMARK_PATH);
}

export function blindEncodePath(env: Env): string {
  return pathFromEnv(env.BLIND_ENCODE_PATH, DEFAULT_BLIND_ENCODE_PATH);
}

export function blindDecodePath(env: Env): string {
  return pathFromEnv(env.BLIND_DECODE_PATH, DEFAULT_BLIND_DECODE_PATH);
}

export function blindResultPath(env: Env): string {
  return pathFromEnv(env.BLIND_RESULT_PATH, DEFAULT_BLIND_RESULT_PATH);
}

export function inpaintBucket(env: Env): string {
  return env.INPAINT_BUCKET?.trim() || DEFAULT_INPAINT_BUCKET;
}

export function upstreamTimeoutMs(env: Env): number {
  return positiveInt(env.UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS);
}

export function jobPollIntervalMs(env: Env): number {
  return Math.max(200, positiveInt(env.JOB_POLL_INTERVAL_MS, DEFAULT_JOB_POLL_INTERVAL_MS));
}

/**
 * Direct workers.dev calls are a grey-release self-test escape hatch only.
 * Anything other than an explicit `ALLOW_DIRECT_MCP=1` fails closed.
 */
export function directMcpAllowed(env: Env): boolean {
  return env.ALLOW_DIRECT_MCP?.trim() === "1";
}

/**
 * Per caller-key sliding window for `remove_watermark`. In-memory on each
 * isolate; the gateway may apply its own limit as well. Defaults are a few
 * calls per minute so a single key cannot bulk-strip watermarks.
 */
export const DEFAULT_REMOVE_WATERMARK_RATE_LIMIT = 5;
export const DEFAULT_REMOVE_WATERMARK_RATE_WINDOW_MS = 60_000;

export function removeWatermarkRateLimit(env: Env): number {
  return Math.max(1, positiveInt(env.REMOVE_WATERMARK_RATE_LIMIT, DEFAULT_REMOVE_WATERMARK_RATE_LIMIT));
}

export function removeWatermarkRateWindowMs(env: Env): number {
  return Math.max(1_000, positiveInt(env.REMOVE_WATERMARK_RATE_WINDOW_MS, DEFAULT_REMOVE_WATERMARK_RATE_WINDOW_MS));
}
