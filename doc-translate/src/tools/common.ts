import { chargeCredits, type ChargeSuccess } from "../charge";
import { costFor, type BillableTool } from "../config";
import type { ToolContext } from "../env";
import { ToolError, withChargeContext } from "../errors";

export interface BilledCall {
  charge: ChargeSuccess;
  idempotencyKey: string;
}

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

/** MinerU requires Worker secret + Bearer. No upstream call when missing. */
export function requireMineruBearer(ctx: ToolContext): void {
  if (!ctx.env.UPSTREAM_API_TOKEN?.trim()) {
    throw new ToolError(
      "UPSTREAM_API_TOKEN is not configured on this Worker. Set it with `wrangler secret put UPSTREAM_API_TOKEN` (路B). No upstream request was made.",
      "upstream_misconfigured",
    );
  }
  if (ctx.env.UPSTREAM_ATTACH_AUTH?.trim() !== "1") {
    throw new ToolError(
      "UPSTREAM_ATTACH_AUTH must be \"1\" so MinerU requests carry Authorization. No upstream request was made.",
      "upstream_misconfigured",
    );
  }
}

export function waitMsFrom(waitSeconds: number | undefined, fallbackSeconds: number, maxSeconds: number): number {
  const seconds = waitSeconds === undefined ? fallbackSeconds : waitSeconds;
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.round(Math.min(maxSeconds, seconds) * 1000);
}

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

export function raiseAfterCharge(error: unknown, billed: BilledCall): never {
  if (billed.charge.charged > 0) {
    throw withChargeContext(error, billed.charge.charge_id ?? billed.idempotencyKey);
  }
  throw error;
}

export function newAuditId(): string {
  return `aud_${crypto.randomUUID()}`;
}

export function auditRecord(event: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
  } catch {
    // Audit logging must never break a tool call.
  }
}

/**
 * Validate a public http(s) PDF URL. Rejects non-http(s) and non-.pdf path
 * (querystring ignored for suffix check).
 */
export function validatePdfUrl(value: string, field: string, maxChars: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ToolError(`${field} is required.`, "invalid_arguments");
  }
  if (trimmed.length > maxChars) {
    throw new ToolError(`${field} must be <= ${maxChars} characters.`, "invalid_arguments");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ToolError(`${field} must be a valid URL.`, "invalid_arguments");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolError(`${field} must be an http(s) URL.`, "invalid_arguments");
  }
  const pathLower = parsed.pathname.toLowerCase();
  if (!pathLower.endsWith(".pdf")) {
    throw new ToolError(`${field} must point to a .pdf file (path ending in .pdf).`, "invalid_arguments");
  }
  return trimmed;
}
