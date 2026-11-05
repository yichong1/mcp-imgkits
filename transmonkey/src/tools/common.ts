import { chargeCredits, type ChargeSuccess } from "../charge";
import { costFor, type BillableTool } from "../config";
import type { ToolContext } from "../env";
import { rethrowWithCharge, ToolError } from "../errors";
import { normalizeLanguageCode } from "../languages";

export interface BilledCall {
  charge: ChargeSuccess;
  idempotencyKey: string;
}

/** Generate a per-job key if the caller did not supply one. */
export function resolveIdempotencyKey(supplied?: string): string {
  const key = supplied?.trim();
  if (!key) return crypto.randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(key)) {
    throw new ToolError(
      "idempotency_key must be 1–120 characters and may contain only letters, digits, '.', '_', ':' or '-'.",
      "invalid_idempotency_key",
    );
  }
  return key;
}

export function requireUpstreamConfigured(ctx: ToolContext): void {
  if (!ctx.env.UPSTREAM_API_TOKEN?.trim()) {
    throw new ToolError(
      "UPSTREAM_API_TOKEN is not configured on this Worker. Deploy the secret first: `wrangler secret put UPSTREAM_API_TOKEN`. No upstream request was made.",
      "upstream_not_configured",
    );
  }
}

export function normalizeLanguages(from: string, to: string): { from: string; to: string } {
  const normalizedFrom = normalizeLanguageCode(from || "auto", true);
  const normalizedTo = normalizeLanguageCode(to, false);
  if (normalizedFrom !== "auto" && normalizedFrom === normalizedTo) {
    throw new ToolError(
      `Source and target languages are both '${normalizedTo}'. Choose a different target language.`,
      "invalid_language_pair",
    );
  }
  return { from: normalizedFrom, to: normalizedTo };
}

export function waitMsFrom(waitSeconds: number | undefined, fallback: number): number {
  const seconds = waitSeconds === undefined ? fallback : waitSeconds;
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.round(Math.min(120, seconds) * 1000);
}

/**
 * Record the gateway charge for this tool call before touching the upstream.
 *
 * Mount convention A: mcp-credit-gateway has already deducted credits before
 * forwarding the request. This is a zero-network trust helper; it never posts
 * to the gateway charge endpoint. `cost === 0` is a no-op (detect_language's free default).
 */
export async function billTool(
  ctx: ToolContext,
  tool: BillableTool,
  idempotencyKey: string,
): Promise<BilledCall> {
  const cost = costFor(ctx.env, tool);
  const charge = chargeCredits({
    cost,
    tool,
    ...(ctx.chargeId ? { chargeId: ctx.chargeId } : {}),
  });
  return { charge, idempotencyKey };
}

/**
 * Upstream `userId` is a pseudo-user derived from the caller key and job key.
 * It never contains the API key and gives each MCP job its own
 * "one in-progress job" slot upstream, so different callers do not block each
 * other. The same idempotency key maps to the same pseudo-user.
 */
export async function pseudoUpstreamUserId(authToken: string, idempotencyKey: string): Promise<string> {
  const data = new TextEncoder().encode(`${authToken}\u0000${idempotencyKey}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `mcp_${hex.slice(0, 24)}`;
}

/**
 * Convert an upstream failure after a successful charge into a support-ready
 * error. Zero-cost calls are re-thrown unchanged.
 */
export function raiseAfterCharge(error: unknown, billed: BilledCall): never {
  if (billed.charge.charged > 0) {
    rethrowWithCharge(error, billed.charge.charge_id ?? billed.idempotencyKey);
  }
  throw error;
}

export function safeFileName(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  return candidate.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "translateFile";
}

export function fileNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop();
    return name ? decodeURIComponent(name) : "translateFile";
  } catch {
    return "translateFile";
  }
}
