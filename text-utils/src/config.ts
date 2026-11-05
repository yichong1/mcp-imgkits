import type { Env } from "./env";

export const SERVICE_NAME = "mcp-text-utils";
export const SERVICE_VERSION = "0.1.0";
export const MCP_ROUTE = "/mcp";

/** Expected `X-Access-Channel` value for requests forwarded by the gateway. */
export const GATEWAY_ACCESS_CHANNEL = "mcp-gateway";

export const MAX_TEXT_CHARS = 8000;

export const STYLE_MODES = [
  "morse",
  "binary",
  "old_english",
  "fancy",
  "upper",
  "lower",
  "title",
  "reverse",
] as const;

export type StyleMode = (typeof STYLE_MODES)[number];

export const PRIVACY_NOTICE =
  "Text is processed in-memory for this request only and is not stored. " +
  "Do not send secrets, passwords, or personal data you would not paste into a public tool. " +
  "Calls are rate-limited/metered by mcp-credit-gateway and require a valid sk_live_ key. " +
  "（文本仅在本请求内存中处理、不落盘；请勿提交密钥/密码等敏感信息；调用限频。）";

export type BillableTool = "convert_text_style" | "count_text";

export const DEFAULT_COSTS: Record<BillableTool, number> = {
  convert_text_style: 1,
  count_text: 1,
};

const COST_VARS: Record<BillableTool, keyof Env> = {
  convert_text_style: "COST_CONVERT_TEXT_STYLE",
  count_text: "COST_COUNT_TEXT",
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

/**
 * Direct workers.dev calls are a grey-release self-test escape hatch only.
 * Anything other than an explicit `ALLOW_DIRECT_MCP=1` fails closed.
 */
export function directMcpAllowed(env: Env): boolean {
  return env.ALLOW_DIRECT_MCP?.trim() === "1";
}
