import { apiBaseUrl, jobPollIntervalMs, upstreamTimeoutMs } from "./config";
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
 * ImgKits envelopes: `{code:0,msg:"ok",data:...}` and `{success:true,data:...}`.
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
        `Audio upstream rejected the request: ${upstreamRemark(record) ?? `code ${String(code)}`}`,
        undefined,
        "upstream_rejected",
        { upstream_code: code },
      );
    }
  }

  if (record.ok === false || record.success === false) {
    throw new UpstreamError(
      `Audio upstream rejected the request: ${upstreamRemark(record) ?? "unknown error"}`,
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

export function extractJobId(payload: unknown): string | undefined {
  return deepFindString(payload, ["jobId", "job_id", "JobId", "taskId", "task_id"]);
}

/**
 * Pick the produced audio URL. TangoFlux stores the WAV URL in `result` (string).
 */
export function extractAudioUrl(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (record) {
    const result = record.result;
    if (typeof result === "string" && /^https?:\/\//i.test(result.trim())) return result.trim();
  }
  const direct = deepFindString(payload, [
    "audio_url",
    "audioUrl",
    "result_url",
    "resultUrl",
    "output_url",
    "outputUrl",
    "url",
  ]);
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  return undefined;
}

export interface TangoFluxJobState {
  state: "pending" | "done" | "failed";
  status?: number;
  status_str?: string;
  job_id?: string;
  audio_url?: string;
  duration?: number;
  steps?: number;
  remark?: string;
  payload: unknown;
}

function numericStatus(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

/**
 * Normalize TangoFlux create/result payloads:
 * status 0 waiting / 4 processing → pending; 10 done; -1 fail.
 */
export function normalizeTangoFluxResult(payload: unknown): TangoFluxJobState {
  const record = asRecord(payload) ?? {};
  const status = numericStatus(record.status);
  const statusStr = deepFindString(record, ["status_str", "statusStr", "State", "state"]);
  const jobId = extractJobId(record);
  const audioUrl = extractAudioUrl(record);
  const remark = deepFindString(record, ["remark", "message", "msg"]);
  const durationRaw = record.duration;
  const stepsRaw = record.steps;
  const duration =
    typeof durationRaw === "number" && Number.isFinite(durationRaw) ? durationRaw : undefined;
  const steps = typeof stepsRaw === "number" && Number.isFinite(stepsRaw) ? stepsRaw : undefined;

  let state: TangoFluxJobState["state"] = "pending";
  if (status === 10 || statusStr?.toLowerCase() === "done" || Boolean(audioUrl)) {
    state = "done";
  } else if (status === -1 || statusStr?.toLowerCase() === "fail" || statusStr?.toLowerCase() === "failed") {
    state = "failed";
  } else if (status === 0 || status === 4) {
    state = "pending";
  }

  return {
    state,
    ...(status !== undefined ? { status } : {}),
    ...(statusStr ? { status_str: statusStr } : {}),
    ...(jobId ? { job_id: jobId } : {}),
    ...(audioUrl ? { audio_url: audioUrl } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(remark ? { remark } : {}),
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

function optionalUpstreamToken(env: Env): string | undefined {
  const token = env.UPSTREAM_API_TOKEN?.trim();
  return token || undefined;
}

/**
 * TangoFlux requires Bearer (路B). Attach when UPSTREAM_API_TOKEN is set and
 * UPSTREAM_ATTACH_AUTH=1 (wrangler default). Callers must requireUpstreamBearer first.
 */
function upstreamHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "mcp-audio/0.1.0",
  };
  const token = optionalUpstreamToken(env);
  if (token && env.UPSTREAM_ATTACH_AUTH?.trim() === "1") {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function readUpstreamJson(response: Response): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError(
      `Audio upstream returned a redirect (HTTP ${response.status}); redirects are not followed.`,
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
      `Audio upstream returned non-JSON (HTTP ${response.status}).`,
      response.status,
      "invalid_upstream_response",
    );
  }

  if (!response.ok) {
    throw new UpstreamError(
      `Audio upstream returned HTTP ${response.status}: ${upstreamRemark(payload) ?? "unknown error"}.`,
      response.status,
      "upstream_http_error",
    );
  }
  if (payload === undefined) {
    throw new UpstreamError("Audio upstream returned an empty body.", response.status, "invalid_upstream_response");
  }
  return unwrapUpstream(payload);
}

export async function postUpstream(env: Env, baseUrl: string, path: string, body: unknown): Promise<unknown> {
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
      `Audio upstream request failed (${errorMessage(error)}).`,
      undefined,
      "upstream_unreachable",
    );
  }
  return readUpstreamJson(response);
}

/** POST to the configured API base URL. */
export function apiPost(env: Env, path: string, body: unknown): Promise<unknown> {
  return postUpstream(env, apiBaseUrl(env), path, body);
}

export function defaultPollInterval(env: Env): number {
  return jobPollIntervalMs(env);
}

export interface AsyncJobState {
  state: "pending" | "done" | "failed";
  status?: number;
  status_str?: string;
  job_id?: string;
  remark?: string;
  result?: unknown;
  payload: unknown;
}

/**
 * Normalize ImgKits async job payloads (spleeter / whisper / qwen-tts / tangoflux):
 * status 0 waiting / 4 processing / 6 merging → pending; 10 done; -1 fail.
 */
export function normalizeAsyncJob(payload: unknown): AsyncJobState {
  const record = asRecord(payload) ?? {};
  const status = numericStatus(record.status);
  const statusStr = deepFindString(record, ["status_str", "statusStr", "State", "state"]);
  const jobId = extractJobId(record);
  const remark = deepFindString(record, ["remark", "message", "msg"]);
  const result = record.result;

  let state: AsyncJobState["state"] = "pending";
  if (status === 10 || statusStr?.toLowerCase() === "done") {
    state = "done";
  } else if (
    status === -1 ||
    statusStr?.toLowerCase() === "fail" ||
    statusStr?.toLowerCase() === "failed"
  ) {
    state = "failed";
  } else if (status === 0 || status === 4 || status === 6) {
    state = "pending";
  }

  return {
    state,
    ...(status !== undefined ? { status } : {}),
    ...(statusStr ? { status_str: statusStr } : {}),
    ...(jobId ? { job_id: jobId } : {}),
    ...(remark ? { remark } : {}),
    ...(result !== undefined ? { result } : {}),
    payload,
  };
}

export interface StemUrls {
  vocals?: string;
  accompaniment?: string;
  zip_url?: string;
}

/** Extract Spleeter result URLs from a done job payload / result object. */
export function extractStemUrls(payload: unknown): StemUrls {
  const record = asRecord(payload) ?? {};
  const result = asRecord(record.result) ?? record;
  const out: StemUrls = {};
  for (const [key, alias] of [
    ["vocals", "vocals"],
    ["accompaniment", "accompaniment"],
    ["zip_url", "zip_url"],
    ["zipUrl", "zip_url"],
  ] as const) {
    const value = result[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
      out[alias] = value.trim();
    }
  }
  return out;
}
