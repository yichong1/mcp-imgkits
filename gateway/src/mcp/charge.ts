import { cacheKey } from "../constants";
import { isWellFormedKey } from "../crypto";
import { resolveKey } from "../keys";
import { AppError } from "./http";

export interface ChargeRequest {
  cost: number;
  tool: string;
  ref: string;
}

export interface ChargeResult {
  chargeId: string | null;
  balanceAfter: number | null;
  charged: number;
}

export type ChargeFn = (request: ChargeRequest) => Promise<ChargeResult>;

const INVALID_KEY = "API key is invalid or revoked. No MinerU job was created.";

/**
 * Charge through the existing UserLock Durable Object, i.e. the same code path
 * used by `POST /v1/charge`. The caller's Bearer is resolved exactly like the
 * public API; MCP callers never share a server-side MinerU or billing key.
 */
export async function chargeCredits(
  env: Env,
  input: ChargeRequest & { bearer: string },
): Promise<ChargeResult> {
  if (!isWellFormedKey(input.bearer)) throw new AppError(401, "unauthorized", INVALID_KEY);

  const resolved = await resolveKey(env, input.bearer);
  if (resolved.kind !== "active") {
    throw new AppError(401, "unauthorized", INVALID_KEY);
  }

  const result = await env.USER_LOCK.getByName(resolved.usa_user_id).handle(resolved.id, {
    op: "charge",
    cost: input.cost,
    tool: input.tool,
    ref: input.ref,
    idempotencyKey: input.ref,
  });

  if (result.status === 401) {
    try {
      await env.KEY_CACHE.delete(cacheKey(resolved.key_hash));
    } catch {
      // The next DO read still sees revoked_at.
    }
  }
  if (result.status !== 200) throw chargeFailure(result.status, result.body.error);

  const body = result.body;
  return {
    chargeId: typeof body.charge_id === "string" ? body.charge_id : null,
    balanceAfter:
      typeof body.balance_after === "number" && Number.isFinite(body.balance_after)
        ? body.balance_after
        : null,
    charged:
      typeof body.charged === "number" && Number.isFinite(body.charged) ? body.charged : input.cost,
  };
}

function chargeFailure(status: number, error: string | undefined): AppError {
  if (status === 402) {
    return new AppError(402, "insufficient_credits", "Insufficient credits. No MinerU job was created.");
  }
  if (status === 409) {
    return new AppError(409, "idempotency_conflict", "Charge idempotency conflict. No MinerU job was created.");
  }
  if (status === 429) {
    return new AppError(429, "rate_limited", "Too many requests or daily charge limit reached. Try later.");
  }
  if (status === 503) {
    return new AppError(
      503,
      "charge_unavailable",
      "Credit service is temporarily unavailable. No MinerU job was created.",
    );
  }
  if (status === 500) {
    return new AppError(503, "charge_unavailable", "Credit service is not configured. No MinerU job was created.");
  }
  return new AppError(
    502,
    "charge_failed",
    `Credit charge failed (HTTP ${status}${error ? `, ${error}` : ""}). No MinerU job was created.`,
  );
}

export function chargeCost(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 1;
}
