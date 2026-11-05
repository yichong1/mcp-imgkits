import type { Env } from "./env";

export const SERVICE_NAME = "mcp-doc-translate";
export const SERVICE_VERSION = "0.1.0";
export const MCP_ROUTE = "/mcp";

export const DEFAULT_API_BASE_URL = "https://api.imgkits.com";
export const DEFAULT_MINERU_BASE_PATH = "/api/mineru";
export const DEFAULT_TRANSLATE_TEXT_PATH = "/translate/text";

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
export const DEFAULT_JOB_POLL_INTERVAL_MS = 4_000;

/** Expected `X-Access-Channel` value for requests forwarded by the gateway. */
export const GATEWAY_ACCESS_CHANNEL = "mcp-gateway";

export const MAX_FILE_URL_CHARS = 2048;
export const DEFAULT_WAIT_SECONDS = 45;
export const MAX_WAIT_SECONDS = 55;
export const FROM_APP = "mcp-doc-translate";

export const MAX_UPSTREAM_TEXT_CHARS = 1_900;
export const MAX_UPSTREAM_TEXTS_PER_CALL = 40;
export const MAX_MARKDOWN_CHARS = 1_500_000;

/**
 * Copyright / abuse gate shown in tool descriptions and health.
 */
export const COPYRIGHT_NOTICE =
  "Use only on documents you own or are explicitly licensed/authorized to convert and translate. " +
  "Do not upload or redistribute copyrighted material without permission. " +
  "Output markdown is ephemeral and must not be abused for bulk scraping. " +
  "Calls are rate-limited/metered by mcp-credit-gateway and require a valid sk_live_ key. " +
  "（仅处理自有或已获授权文档；禁止滥用转换/翻译他人受版权保护材料；调用限频。）";

export type BillableTool = "pdf_to_markdown_then_translate";

export const DEFAULT_COSTS: Record<BillableTool, number> = {
  pdf_to_markdown_then_translate: 2,
};

const COST_VARS: Record<BillableTool, keyof Env> = {
  pdf_to_markdown_then_translate: "COST_PDF_TO_MARKDOWN_THEN_TRANSLATE",
};

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

/** Cost in credits for one tool call. Informational only; gateway charges. */
export function costFor(env: Env, tool: BillableTool): number {
  return positiveInt(env[COST_VARS[tool]] as string | undefined, DEFAULT_COSTS[tool]);
}

export function apiBaseUrl(env: Env): string {
  return (env.API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function pathFromEnv(value: string | undefined, fallback: string): string {
  const path = value?.trim();
  if (!path) return fallback;
  return path.startsWith("/") ? path : `/${path}`;
}

export function mineruBasePath(env: Env): string {
  return pathFromEnv(env.MINERU_BASE_PATH, DEFAULT_MINERU_BASE_PATH).replace(/\/+$/, "");
}

export function translateTextPath(env: Env): string {
  return pathFromEnv(env.TRANSLATE_TEXT_PATH, DEFAULT_TRANSLATE_TEXT_PATH);
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
