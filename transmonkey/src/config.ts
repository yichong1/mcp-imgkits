import type { Env } from "./env";

export const SERVICE_NAME = "mcp-transmonkey";
export const SERVICE_VERSION = "0.1.0";
export const MCP_ROUTE = "/mcp";

export const DEFAULT_TEXT_BASE_URL = "https://a2.imgkits.com";
export const DEFAULT_DOC_BASE_URL = "https://api.imgkits.com";
export const DEFAULT_IMAGE_BASE_URL = "https://ai.imgkits.com";

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
export const DEFAULT_JOB_POLL_INTERVAL_MS = 2_000;

/** Expected `X-Access-Channel` value for requests forwarded by the gateway. */
export const GATEWAY_ACCESS_CHANNEL = "mcp-gateway";

/** The text endpoint rejects any single content item over 2,000 characters. */
export const MAX_UPSTREAM_TEXT_CHARS = 1_900;
export const MAX_UPSTREAM_TEXTS_PER_CALL = 40;

export const MAX_TEXT_CHARS = 50_000;
export const MAX_TEXT_ITEMS = 50;
export const MAX_DETECT_CHARS = 20_000;
export const MAX_SUBTITLE_CHARS = 1_000_000;
export const MAX_IMAGE_URLS = 10;
export const MAX_IMAGE_BYTES_HINT = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES_PDF = 30 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES_OTHER = 80 * 1024 * 1024;

export const DEFAULT_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 120;

export type BillableTool =
  | "translate_text"
  | "translate_document"
  | "translate_image"
  | "translate_subtitle"
  | "detect_language";

export const DEFAULT_COSTS: Record<BillableTool, number> = {
  translate_text: 1,
  translate_document: 5,
  translate_image: 2,
  translate_subtitle: 3,
  // Local heuristic only. Override COST_DETECT_LANGUAGE to charge for it.
  detect_language: 0,
};

const COST_VARS: Record<BillableTool, keyof Env> = {
  translate_text: "COST_TRANSLATE_TEXT",
  translate_document: "COST_TRANSLATE_DOCUMENT",
  translate_image: "COST_TRANSLATE_IMAGE",
  translate_subtitle: "COST_TRANSLATE_SUBTITLE",
  detect_language: "COST_DETECT_LANGUAGE",
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

export function textBaseUrl(env: Env): string {
  return (env.TRANSLATE_TEXT_BASE_URL?.trim() || DEFAULT_TEXT_BASE_URL).replace(/\/+$/, "");
}

export function docBaseUrl(env: Env): string {
  return (env.DOC_TRANSLATE_BASE_URL?.trim() || DEFAULT_DOC_BASE_URL).replace(/\/+$/, "");
}

export function imageBaseUrl(env: Env): string {
  return (env.IMAGE_TRANSLATE_BASE_URL?.trim() || DEFAULT_IMAGE_BASE_URL).replace(/\/+$/, "");
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
