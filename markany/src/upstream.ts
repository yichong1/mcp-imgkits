import { aiBaseUrl, jobPollIntervalMs, upstreamTimeoutMs } from "./config";
import type { Env } from "./env";
import { errorMessage, UpstreamError } from "./errors";

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** Depth-first search for the first non-empty string/number under `keys`. */
export function deepFindString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(value);
  if (record) {
    for (const key of keys) {
      const hit = record[key];
      if (typeof hit === "string" && hit.trim()) return hit.trim();
      if (typeof hit === "number" && Number.isFinite(hit)) return String(hit);
    }
    for (const child of Object.values(record)) {
      const hit = deepFindString(child, keys, depth + 1);
      if (hit) return hit;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const hit = deepFindString(child, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

function upstreamRemark(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  for (const key of ["remark", "message", "msg", "error", "Message", "ErrMsg", "errmsg"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * ImgKits/AiController-style envelopes:
 * `{code:0,msg:"ok",data:...}` and `{success:true,message:"",data:...}`.
 * Treat only explicit failure signals as errors; unknown success shapes are
 * passed through so an upstream addition does not break the Worker.
 */
export function unwrapUpstream(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return payload;

  const code = record.code;
  if (code !== undefined) {
    const numeric = typeof code === "number" ? code : Number(code);
    const failed =
      code === false ||
      code === 1 ||
      code === "1" ||
      (Number.isFinite(numeric) && (numeric < 0 || numeric >= 400));
    if (failed) {
      throw new UpstreamError(
        `Watermark upstream rejected the request: ${upstreamRemark(record) ?? `code ${String(code)}`}`,
        undefined,
        "upstream_rejected",
        { upstream_code: code },
      );
    }
  }

  if (record.ok === false || record.success === false) {
    throw new UpstreamError(
      `Watermark upstream rejected the request: ${upstreamRemark(record) ?? "unknown error"}`,
      undefined,
      "upstream_rejected",
    );
  }

  if (record.data !== undefined && record.data !== null) return record.data;
  if (record.result !== undefined && (code === 0 || code === "0" || code === 200 || code === "200")) {
    return record.result;
  }
  return record;
}

const OUTPUT_URL_KEYS = [
  "targetUrl",
  "target_url",
  "outputUrl",
  "output_url",
  "resultUrl",
  "result_url",
  "ImageURL",
  "imageUrl",
  "image_url",
  "url",
];

/** Pick the produced image URL from an add/remove/embed upstream response. */
export function extractOutputUrl(payload: unknown): string | undefined {
  const direct = deepFindString(payload, OUTPUT_URL_KEYS);
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  return undefined;
}

export function extractTaskId(payload: unknown): string | undefined {
  return deepFindString(payload, ["taskId", "task_id", "TaskId", "jobId", "job_id"]);
}

export interface BlindWatermarkResult {
  state: "pending" | "done" | "failed";
  status?: string;
  code?: string;
  message?: string;
  content?: string;
  user_data?: string;
  payload: unknown;
}

const DONE_WORDS = new Set(["success", "succeeded", "done", "finished", "complete", "completed", "ready", "ok"]);
const FAILED_WORDS = new Set([
  "fail",
  "failed",
  "error",
  "expired",
  "cancelled",
  "canceled",
  "timeout",
  "rejected",
  "denied",
]);
const SUCCESS_CODES = new Set(["success", "ok", "0", "200"]);

function statusState(raw: string | undefined): BlindWatermarkResult["state"] | undefined {
  const word = raw?.trim().toLowerCase();
  if (!word) return undefined;
  if (DONE_WORDS.has(word)) return "done";
  if (FAILED_WORDS.has(word)) return "failed";
  if (["processing", "pending", "running", "queued", "waiting", "in_progress"].includes(word)) return "pending";
  if (/^-?\d+$/.test(word)) {
    const numeric = Number(word);
    if (numeric === 10 || numeric >= 100) return "done";
    if (numeric < 0) return "failed";
    return "pending";
  }
  return undefined;
}

/**
 * Normalize `GetDecodeBlindWatermarkResult` (`{Status,Code,Message,Content,
 * UserData}`) and similar async shapes into a small stable state.
 */
export function normalizeBlindWatermarkResult(payload: unknown): BlindWatermarkResult {
  const record = asRecord(payload) ?? {};
  const status = deepFindString(record, ["Status", "status", "State", "state"]);
  const code = deepFindString(record, ["Code", "code"]);
  const message = deepFindString(record, ["Message", "message", "Msg", "msg"]);
  const content = deepFindString(record, ["Content", "content", "WatermarkContent", "watermark_content"]);
  const userData = deepFindString(record, ["UserData", "userData", "user_data"]);

  const codeIsError = code !== undefined && !SUCCESS_CODES.has(code.toLowerCase());
  const state = statusState(status) ?? (content ? "done" : codeIsError ? "failed" : "pending");

  return {
    state,
    ...(status ? { status } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(content ? { content } : {}),
    ...(userData ? { user_data: userData } : {}),
    payload,
  };
}

export interface PollResult<T> {
  state: T;
  timed_out: boolean;
}

/**
 * Poll a status function until it leaves `pending` or the deadline passes.
 * The first poll is immediate, so `timeoutMs: 0` still returns a snapshot.
 */
export async function pollJob<T extends { state: "pending" | "done" | "failed" }>(
  poll: () => Promise<T>,
  options: { timeoutMs: number; intervalMs: number },
): Promise<PollResult<T>> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  for (;;) {
    const last = await poll();
    if (last.state !== "pending") return { state: last, timed_out: false };

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: last, timed_out: true };

    const sleepMs = Math.min(Math.max(50, options.intervalMs), remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
  }
}

/** Append query parameters to a path that may already contain `?`. */
export function withQuery(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

function requireUpstreamToken(env: Env): string {
  const token = env.UPSTREAM_API_TOKEN?.trim();
  if (!token) {
    throw new UpstreamError(
      "UPSTREAM_API_TOKEN is not configured on this Worker. Set it with `wrangler secret put UPSTREAM_API_TOKEN` before using watermark tools.",
      undefined,
      "upstream_not_configured",
    );
  }
  return token;
}

function upstreamHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${requireUpstreamToken(env)}`,
    "content-type": "application/json",
    accept: "application/json",
    channel: "ai",
    "user-agent": "mcp-markany/0.1.0",
  };
}

async function readUpstreamJson(response: Response): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError(
      `Watermark upstream returned a redirect (HTTP ${response.status}); redirects are not followed.`,
      response.status,
      "upstream_redirect",
    );
  }

  const text = await response.text().catch(() => "");
  let payload: unknown;
  try {
    payload = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    throw new UpstreamError(
      `Watermark upstream returned non-JSON (HTTP ${response.status}).`,
      response.status,
      "invalid_upstream_response",
    );
  }

  if (!response.ok) {
    throw new UpstreamError(
      `Watermark upstream returned HTTP ${response.status}: ${upstreamRemark(payload) ?? "unknown error"}.`,
      response.status,
      "upstream_http_error",
    );
  }
  if (payload === undefined) {
    throw new UpstreamError("Watermark upstream returned an empty body.", response.status, "invalid_upstream_response");
  }
  return unwrapUpstream(payload);
}

export async function postUpstream(env: Env, baseUrl: string, path: string, body: unknown): Promise<unknown> {
  // Build headers first so a missing token surfaces as upstream_not_configured
  // instead of being wrapped as an unreachable-network error.
  const headers = upstreamHeaders(env);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(upstreamTimeoutMs(env)),
    });
  } catch (error) {
    throw new UpstreamError(
      `Watermark upstream request failed (${errorMessage(error)}).`,
      undefined,
      "upstream_unreachable",
    );
  }
  return readUpstreamJson(response);
}

export async function getUpstream(env: Env, baseUrl: string, path: string): Promise<unknown> {
  const headers = upstreamHeaders(env);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(upstreamTimeoutMs(env)),
    });
  } catch (error) {
    throw new UpstreamError(
      `Watermark upstream request failed (${errorMessage(error)}).`,
      undefined,
      "upstream_unreachable",
    );
  }
  return readUpstreamJson(response);
}

/** POST to the single configured AI base URL. */
export function aiPost(env: Env, path: string, body: unknown): Promise<unknown> {
  return postUpstream(env, aiBaseUrl(env), path, body);
}

/** GET from the single configured AI base URL (used for job polling). */
export function aiGet(env: Env, path: string): Promise<unknown> {
  return getUpstream(env, aiBaseUrl(env), path);
}

export function defaultPollInterval(env: Env): number {
  return jobPollIntervalMs(env);
}
