/**
 * Bindings and vars this Worker expects.
 *
 * `UPSTREAM_API_TOKEN` is a Worker secret (路B INTERNAL_SERVER_BEARER) used only
 * for MinerU S2S. It must never be a key copied out of a frontend bundle.
 *
 * Public `/translate/text` does NOT use Authorization and has no translate secret.
 *
 * `GATEWAY_SHARED_SECRET` is optional. When set, every non-public `/mcp`
 * request must also carry a matching `X-Gateway-Shared-Secret` header.
 */
export interface Env {
  UPSTREAM_API_TOKEN?: string;
  /** Set to "1" to attach Bearer from UPSTREAM_API_TOKEN on MinerU calls. */
  UPSTREAM_ATTACH_AUTH?: string;
  GATEWAY_SHARED_SECRET?: string;

  /**
   * `"1"` allows direct workers.dev calls that lack the gateway channel header.
   * Grey-release self-test only; set to `"0"` once gateway wiring is live.
   */
  ALLOW_DIRECT_MCP?: string;

  API_BASE_URL?: string;
  MINERU_BASE_PATH?: string;
  TRANSLATE_TEXT_PATH?: string;

  UPSTREAM_TIMEOUT_MS?: string;
  JOB_POLL_INTERVAL_MS?: string;

  COST_PDF_TO_MARKDOWN_THEN_TRANSLATE?: string;
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
