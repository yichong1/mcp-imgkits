/**
 * Bindings and vars this Worker expects.
 *
 * `UPSTREAM_API_TOKEN` is a Worker secret. It is a newly issued
 * server-to-server token and must never be a key copied out of a frontend
 * bundle or another business repo.
 *
 * `BLIND_WATERMARK_KEY` is an optional server-held blind-watermark content/key.
 * When set, `embed_blind_watermark` may omit `watermark_text` and the value is
 * used without ever being returned to the caller or logged.
 *
 * `GATEWAY_SHARED_SECRET` is optional. When set, every non-public `/mcp`
 * request must also carry a matching `X-Gateway-Shared-Secret` header.
 */
export interface Env {
  UPSTREAM_API_TOKEN?: string;
  GATEWAY_SHARED_SECRET?: string;
  BLIND_WATERMARK_KEY?: string;

  /**
   * `"1"` allows direct workers.dev calls that lack the gateway channel header.
   * Grey-release self-test only; set to `"0"` once gateway wiring is live.
   */
  ALLOW_DIRECT_MCP?: string;

  AI_BASE_URL?: string;
  ADD_WATERMARK_PATH?: string;
  REMOVE_WATERMARK_PATH?: string;
  BLIND_ENCODE_PATH?: string;
  BLIND_DECODE_PATH?: string;
  BLIND_RESULT_PATH?: string;
  INPAINT_BUCKET?: string;

  UPSTREAM_TIMEOUT_MS?: string;
  JOB_POLL_INTERVAL_MS?: string;

  COST_ADD_WATERMARK?: string;
  COST_REMOVE_WATERMARK?: string;
  COST_EMBED_BLIND_WATERMARK?: string;
  COST_DECODE_BLIND_WATERMARK?: string;

  /**
   * Optional override for the remove_watermark sliding window.
   * Unset uses 5 calls per 60_000 ms. These are not prices.
   */
  REMOVE_WATERMARK_RATE_LIMIT?: string;
  REMOVE_WATERMARK_RATE_WINDOW_MS?: string;
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
