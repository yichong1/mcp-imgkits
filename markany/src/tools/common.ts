import { chargeCredits, type ChargeSuccess } from "../charge";
import { costFor, type BillableTool } from "../config";
import type { ToolContext } from "../env";
import { rethrowWithCharge, ToolError } from "../errors";

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
      "UPSTREAM_API_TOKEN is not configured on this Worker. Set it with `wrangler secret put UPSTREAM_API_TOKEN`. No upstream request was made.",
      "upstream_not_configured",
    );
  }
}

/** Convert `wait_seconds` to a bounded millisecond timeout. */
export function waitMsFrom(waitSeconds: number | undefined, fallbackSeconds: number, maxSeconds: number): number {
  const seconds = waitSeconds === undefined ? fallbackSeconds : waitSeconds;
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.round(Math.min(maxSeconds, seconds) * 1000);
}

/**
 * Record the gateway charge for this tool call before touching the upstream.
 *
 * Mount convention A: mcp-credit-gateway has already deducted credits before
 * forwarding the request. This is a zero-network trust helper; it never posts
 * to the gateway charge endpoint.
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
 * Convert an upstream failure after a successful charge into a support-ready
 * error. Zero-cost calls are re-thrown unchanged.
 */
export function raiseAfterCharge(error: unknown, billed: BilledCall): never {
  if (billed.charge.charged > 0) {
    rethrowWithCharge(error, billed.charge.charge_id ?? billed.idempotencyKey);
  }
  throw error;
}

/** Short correlation id so failed (or successful) calls can be audited. */
export function newAuditId(): string {
  return `aud_${crypto.randomUUID()}`;
}

/**
 * Structured, secret-free audit line. Worker observability collects console
 * output; never pass API keys, blind-watermark content or source URLs here.
 */
export function auditRecord(event: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
  } catch {
    // Audit logging must never break a tool call.
  }
}
