import { SERVICE_NAME, SERVICE_VERSION, upstreamTimeoutMs } from "./config";
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
 * ImgKits / AiController envelopes:
 * `{code:0,msg:"ok",data:...}`, `{success:true,message:"",data:...}`,
 * and a bare `{url:"https://..."}`.
 * Only explicit failure signals are errors.
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
        `Image upstream rejected the request: ${upstreamRemark(record) ?? `code ${String(code)}`}`,
        undefined,
        "upstream_rejected",
        { upstream_code: code },
      );
    }
  }

  if (record.ok === false || record.success === false || record.ok === 2 || record.ok === "2") {
    throw new UpstreamError(
      `Image upstream rejected the request: ${upstreamRemark(record) ?? "unknown error"}`,
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
  "url",
  "ali_url",
  "targetUrl",
  "target_url",
  "outputUrl",
  "output_url",
  "resultUrl",
  "result_url",
  "ImageURL",
  "imageUrl",
  "image_url",
];

/** Pick the produced image URL from an upstream response. */
export function extractOutputUrl(payload: unknown): string | undefined {
  const direct = deepFindString(payload, OUTPUT_URL_KEYS);
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  return undefined;
}

function upstreamHeaders(jsonBody: boolean): Record<string, string> {
  return {
    accept: "application/json",
    "user-agent": `${SERVICE_NAME}/${SERVICE_VERSION}`,
    ...(jsonBody ? { "content-type": "application/json" } : {}),
  };
}

async function readUpstreamJson(response: Response): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError(
      `Image upstream returned a redirect (HTTP ${response.status}); redirects are not followed.`,
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
      `Image upstream returned non-JSON (HTTP ${response.status}).`,
      response.status,
      "invalid_upstream_response",
    );
  }

  if (!response.ok) {
    throw new UpstreamError(
      `Image upstream returned HTTP ${response.status}: ${upstreamRemark(payload) ?? "unknown error"}.`,
      response.status,
      "upstream_http_error",
    );
  }
  if (payload === undefined) {
    throw new UpstreamError("Image upstream returned an empty body.", response.status, "invalid_upstream_response");
  }
  return unwrapUpstream(payload);
}

async function requestUpstream(env: Env, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(upstreamTimeoutMs(env)),
    });
  } catch (error) {
    throw new UpstreamError(
      `Image upstream request failed (${errorMessage(error)}).`,
      undefined,
      "upstream_unreachable",
    );
  }
  return readUpstreamJson(response);
}

/** POST JSON. Public upstreams: no Authorization header is attached. */
export function postJson(env: Env, baseUrl: string, path: string, body: unknown): Promise<unknown> {
  return requestUpstream(env, `${baseUrl}${path}`, {
    method: "POST",
    headers: upstreamHeaders(true),
    body: JSON.stringify(body),
  });
}

/** GET with an already-encoded query string in `path`. No Authorization header. */
export function getUpstream(env: Env, baseUrl: string, path: string): Promise<unknown> {
  return requestUpstream(env, `${baseUrl}${path}`, {
    method: "GET",
    headers: upstreamHeaders(false),
  });
}
