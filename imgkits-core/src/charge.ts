import { ChargeError } from "./errors";

export interface ChargeSuccess {
  ok: true;
  /** Credits the gateway has already deducted for this tool call. */
  charged: number;
  /** Charge id forwarded by the gateway via `X-Mcp-Charge-Id`, when present. */
  charge_id?: string;
}

export interface ChargeOptions {
  cost: number;
  /** Tool name, kept for call-site symmetry/metadata. */
  tool?: string;
  /** `X-Mcp-Charge-Id` forwarded by mcp-credit-gateway. */
  chargeId?: string;
}

/**
 * Local "trust the gateway already charged" helper.
 *
 * Mount convention A: `mcp-credit-gateway` deducts credits before forwarding
 * the MCP request to this Worker. This Worker must never call the gateway
 * charge endpoint itself, so this function performs zero network I/O: it only
 * validates the local cost and passes the gateway charge id through.
 */
export function chargeCredits(options: ChargeOptions): ChargeSuccess {
  const { cost, chargeId } = options;

  if (!Number.isInteger(cost) || cost < 0) {
    throw new ChargeError("Charge cost must be a non-negative integer.", undefined, "invalid_cost");
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
