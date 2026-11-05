/**
 * Bindings and vars this Worker expects.
 *
 * Pure-algorithm text utils: no UPSTREAM secrets.
 * GATEWAY_SHARED_SECRET is optional.
 */
export interface Env {
  GATEWAY_SHARED_SECRET?: string;

  /**
   * `"1"` allows direct workers.dev calls that lack the gateway channel header.
   * Grey-release self-test only; set to `"0"` once gateway wiring is live.
   */
  ALLOW_DIRECT_MCP?: string;

  COST_CONVERT_TEXT_STYLE?: string;
  COST_COUNT_TEXT?: string;
}

/** Per-request context handed to every tool implementation. */
export interface ToolContext {
  env: Env;
  /** The caller's `sk_live_...` token. Never persisted or logged. */
  authToken: string;
  /** Optional `X-Mcp-Charge-Id` forwarded by mcp-credit-gateway. */
  chargeId?: string;
  /** Optional `X-Access-Channel` (e.g. `mcp-gateway`). */
  accessChannel?: string;
}
