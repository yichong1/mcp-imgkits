/**
 * Bindings and vars this Worker expects.
 *
 * `UPSTREAM_API_TOKEN` is a Worker secret. It is a newly issued
 * server-to-server token and must never be a key copied out of a frontend
 * bundle or another business repo.
 *
 * `GATEWAY_SHARED_SECRET` is optional. When set, every non-OPTIONS `/mcp`
 * request must also carry a matching `X-Gateway-Shared-Secret` header.
 */
export interface Env {
  UPSTREAM_API_TOKEN?: string;
  GATEWAY_SHARED_SECRET?: string;

  /**
   * `"1"` allows direct workers.dev calls that lack the gateway channel header.
   * Grey-release self-test only; set to `"0"` once gateway wiring is live.
   */
  ALLOW_DIRECT_MCP?: string;

  TRANSLATE_TEXT_BASE_URL?: string;
  DOC_TRANSLATE_BASE_URL?: string;
  IMAGE_TRANSLATE_BASE_URL?: string;

  UPSTREAM_TIMEOUT_MS?: string;
  JOB_POLL_INTERVAL_MS?: string;

  COST_TRANSLATE_TEXT?: string;
  COST_TRANSLATE_DOCUMENT?: string;
  COST_TRANSLATE_IMAGE?: string;
  COST_TRANSLATE_SUBTITLE?: string;
  COST_DETECT_LANGUAGE?: string;
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
