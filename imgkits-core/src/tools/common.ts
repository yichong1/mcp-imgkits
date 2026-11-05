import { chargeCredits, type ChargeSuccess } from "../charge";
import { costFor, type BillableTool } from "../config";
import type { ToolContext } from "../env";
import { ToolError, UpstreamError, withChargeContext } from "../errors";
import { extractOutputUrl } from "../upstream";

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
    throw withChargeContext(error, billed.charge.charge_id ?? billed.idempotencyKey);
  }
  throw error;
}

/** Short correlation id so failed (or successful) calls can be audited. */
export function newAuditId(): string {
  return `aud_${crypto.randomUUID()}`;
}

/**
 * Structured, secret-free audit line. Never pass API keys or full source URLs.
 */
export function auditRecord(event: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
  } catch {
    // Audit logging must never break a tool call.
  }
}

export function sourceHost(url: string): string {
  return new URL(url).hostname;
}

export async function withImageCall(
  ctx: ToolContext,
  tool: BillableTool,
  idempotencyKeyInput: string | undefined,
  host: string,
  run: (billed: BilledCall, auditId: string) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const idempotencyKey = resolveIdempotencyKey(idempotencyKeyInput);
  const billed = await billTool(ctx, tool, idempotencyKey);
  const auditId = newAuditId();
  try {
    const result = await run(billed, auditId);
    auditRecord({
      event: tool,
      audit_id: auditId,
      outcome: "ok",
      charge_id: billed.charge.charge_id,
      source_host: host,
    });
    return result;
  } catch (error) {
    auditRecord({
      event: tool,
      audit_id: auditId,
      outcome: "error",
      charge_id: billed.charge.charge_id,
      source_host: host,
    });
    raiseAfterCharge(error, billed);
  }
}

export function successImage(options: {
  tool: BillableTool;
  auditId: string;
  sourceUrl: string;
  payload: unknown;
  billed: BilledCall;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const resultUrl = extractOutputUrl(options.payload);
  if (!resultUrl) {
    throw new UpstreamError(
      "Image upstream returned no result URL.",
      undefined,
      "invalid_upstream_response",
    );
  }
  return {
    ok: true,
    tool: options.tool,
    audit_id: options.auditId,
    source_url: options.sourceUrl,
    result_url: resultUrl,
    ...(options.extra ?? {}),
    upstream_result: options.payload,
    expires_in_hours: 24,
    idempotency_key: options.billed.idempotencyKey,
    charge: options.billed.charge,
    note: "Download the result promptly; upstream result URLs are temporary (about 24 hours).",
  };
}
