/**
 * Bindings and vars this Worker expects.
 *
 * `UPSTREAM_API_TOKEN` is a Worker secret (路B INTERNAL_SERVER_BEARER).
 * It must never be a key copied out of a frontend bundle or another business repo.
 *
 * `GATEWAY_SHARED_SECRET` is optional. When set, every non-public `/mcp`
 * request must also carry a matching `X-Gateway-Shared-Secret` header.
 */
export interface Env {
  UPSTREAM_API_TOKEN?: string;
  /** Set to "1" to attach Bearer from UPSTREAM_API_TOKEN (required for audio upstreams). */
  UPSTREAM_ATTACH_AUTH?: string;
  GATEWAY_SHARED_SECRET?: string;

  /**
   * `"1"` allows direct workers.dev calls that lack the gateway channel header.
   * Grey-release self-test only; set to `"0"` once gateway wiring is live.
   */
  ALLOW_DIRECT_MCP?: string;

  API_BASE_URL?: string;
  TANGOFLUX_CREATE_PATH?: string;
  TANGOFLUX_RESULT_PATH?: string;
  SPLEETER_CREATE_PATH?: string;
  SPLEETER_STATUS_PATH?: string;
  SPLEETER_RESULT_PATH?: string;
  WHISPER_CREATE_PATH?: string;
  WHISPER_RESULT_PATH?: string;
  QWEN_TTS_CREATE_PATH?: string;
  QWEN_TTS_STATUS_PATH?: string;
  QWEN_TTS_RESULT_PATH?: string;

  UPSTREAM_TIMEOUT_MS?: string;
  JOB_POLL_INTERVAL_MS?: string;

  COST_TEXT_TO_SOUND_EFFECT?: string;
  COST_SEPARATE_STEMS?: string;
  COST_TRANSCRIBE_AUDIO?: string;
  COST_GENERATE_SUBTITLES?: string;
  COST_TEXT_TO_SPEECH?: string;
  COST_CLONE_VOICE_TTS?: string;
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
