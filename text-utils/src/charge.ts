import { ToolError } from "./errors";

export interface ChargeSuccess {
  ok: true;
  /** Credits the gateway has already deducted for this tool call. */
  charged: number;
  /** Charge id forwarded by the gateway via `X-Mcp-Charge-Id`, when present. */
  charge_id?: string;
}

export interface ChargeOptions {
  cost: number;
  tool?: string;
  chargeId?: string;
}

/**
 * Local "trust the gateway already charged" helper.
 * mcp-credit-gateway deducts credits before forwarding; this Worker never charges.
 */
export function chargeCredits(options: ChargeOptions): ChargeSuccess {
  const { cost, chargeId } = options;

  if (!Number.isInteger(cost) || cost < 0) {
    throw new ToolError("Charge cost must be a non-negative integer.", "invalid_cost");
  }
  if (cost === 0) {
    return { ok: true, charged: 0 };
  }

  const id = chargeId?.trim();
  return {
    ok: true,
    charged: cost,
    ...(id ? { charge_id: id } : {}),
  };
}
