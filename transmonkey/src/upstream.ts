import {
  MAX_UPSTREAM_TEXT_CHARS,
  MAX_UPSTREAM_TEXTS_PER_CALL,
  docBaseUrl,
  imageBaseUrl,
  jobPollIntervalMs,
  textBaseUrl,
  upstreamTimeoutMs,
} from "./config";
import type { Env } from "./env";
import { errorMessage, UpstreamError } from "./errors";

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function deepGet(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    const record = asRecord(current);
    if (!record || !(part in record)) return undefined;
    current = record[part];
  }
  return current;
}

function deepFindString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 4) return undefined;
  const record = asRecord(value);
  if (record) {
    for (const key of keys) {
      const hit = record[key];
      if (typeof hit === "string" && hit.trim()) return hit;
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
  for (const key of ["remark", "message", "msg", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * ImgKits-style envelope: `{code:0,msg:"ok",data:...}`. Treat only explicit
 * failure signals as errors; unknown success shapes are passed through so an
 * upstream addition does not break the Worker.
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
        `Translation upstream rejected the request: ${upstreamRemark(record) ?? `code ${String(code)}`}`,
        undefined,
        "upstream_rejected",
        { upstream_code: code },
      );
    }
  }

  if (record.ok === false || record.success === false) {
    throw new UpstreamError(
      `Translation upstream rejected the request: ${upstreamRemark(record) ?? "unknown error"}`,
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

function translationValue(item: unknown): string | undefined {
  if (typeof item === "string") return item;
  const record = asRecord(item);
  if (!record) return undefined;
  for (const key of ["translated", "translation", "text", "content", "target", "value"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function collectArrays(value: unknown, out: unknown[][], depth = 0): void {
  if (depth > 4) return;
  if (Array.isArray(value)) {
    out.push(value);
    for (const item of value) {
      if (item !== null && typeof item === "object") collectArrays(item, out, depth + 1);
    }
    return;
  }
  const record = asRecord(value);
  if (record) {
    for (const child of Object.values(record)) {
      if (child !== null && typeof child === "object") collectArrays(child, out, depth + 1);
    }
  }
}

function mapTranslationArray(candidate: unknown[]): string[] | undefined {
  const mapped = candidate.map((item, fallbackIndex) => {
    const value = translationValue(item);
    if (value === undefined) return undefined;
    const record = asRecord(item);
    const rawIndex = record?.index;
    const index =
      typeof rawIndex === "number"
        ? rawIndex
        : typeof rawIndex === "string" && rawIndex.trim() !== "" && Number.isFinite(Number(rawIndex))
          ? Number(rawIndex)
          : undefined;
    return { value, index, fallbackIndex };
  });
  if (mapped.some((item) => item === undefined)) return undefined;

  const items = mapped as Array<{ value: string; index?: number; fallbackIndex: number }>;
  if (items.every((item) => item.index !== undefined)) {
    items.sort((a, b) => (a.index as number) - (b.index as number));
  }
  return items.map((item) => item.value);
}

/**
 * Pull the translated string array out of the various shapes returned by the
 * text endpoint (`{result:[{index,translated}]}`, `{result:[string]}`, or a
 * bare array).
 */
export function extractTranslations(payload: unknown, expected: number): string[] {
  if (typeof payload === "string" && expected === 1) return [payload];

  const candidates: unknown[][] = [];
  collectArrays(payload, candidates);

  let closest: string[] | undefined;
  for (const candidate of candidates) {
    const mapped = mapTranslationArray(candidate);
    if (!mapped) continue;
    if (mapped.length === expected) return mapped;
    if (!closest) closest = mapped;
  }

  // Some APIs return an object keyed by index.
  const record = asRecord(payload);
  if (record) {
    const numericKeys = Object.keys(record).filter((key) => /^\d+$/.test(key));
    if (numericKeys.length === expected) {
      const values = numericKeys
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => translationValue(record[key]));
      if (values.every((value): value is string => value !== undefined)) return values;
    }
  }

  throw new UpstreamError(
    `Translation upstream returned ${closest?.length ?? 0} result(s) for ${expected} input item(s).`,
    undefined,
    "invalid_upstream_response",
    { expected, received: closest?.length ?? 0, remark: upstreamRemark(payload) },
  );
}

export function extractJobId(payload: unknown): string | undefined {
  return deepFindString(payload, ["jobId", "job_id", "uuid", "taskId", "task_id"]) ?? deepFindString(payload, ["id"]);
}

export function extractTaskId(payload: unknown): string | undefined {
  return deepFindString(payload, ["taskId", "task_id", "jobId", "job_id", "uuid"]) ?? deepFindString(payload, ["id"]);
}

/** Collect only result-looking URLs; never walk the original input file URL. */
export function collectResultUrls(value: unknown): string[] {
  const urls = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (/^https?:\/\//i.test(node.trim())) urls.add(node.trim());
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = asRecord(node);
    if (record) {
      for (const child of Object.values(record)) walk(child);
    }
  };
  walk(value);
  return [...urls].slice(0, 50);
}

export type JobState = {
  state: "pending" | "done" | "failed";
  status?: number | string;
  status_str?: string;
  result?: unknown;
  result_urls: string[];
  remark?: string;
  payload: unknown;
};

const DONE_WORDS = new Set(["done", "success", "succeeded", "complete", "completed", "finished", "ready", "ok"]);
const FAILED_WORDS = new Set([
  "fail",
  "failed",
  "error",
  "expired",
  "pay_expired",
  "cancelled",
  "canceled",
  "timeout",
  "rejected",
]);

function statusToState(raw: unknown, statusStr?: string): JobState["state"] | undefined {
  const word = statusStr?.trim().toLowerCase();
  if (word) {
    if (DONE_WORDS.has(word)) return "done";
    if (FAILED_WORDS.has(word)) return "failed";
  }
  if (typeof raw === "number" || (typeof raw === "string" && /^-?\d+$/.test(raw.trim()))) {
    const numeric = Number(raw);
    if (numeric === 10) return "done";
    if (numeric === -1 || numeric === -2) return "failed";
    if (numeric >= 0 && numeric < 10) return "pending";
  }
  if (typeof raw === "string" && raw.trim()) {
    const value = raw.trim().toLowerCase();
    if (DONE_WORDS.has(value)) return "done";
    if (FAILED_WORDS.has(value)) return "failed";
  }
  return undefined;
}

/**
 * Map doc/image job status to a small stable state. Doc: -2 expired, -1 fail,
 * 0 waiting, 1 queried, 2 translating, 10 done. Image: -1 fail, 0 waiting,
 * 2 processing, 10 done.
 */
export function normalizeJobState(payload: unknown): JobState {
  const record = asRecord(payload) ?? {};
  const rawStatus = record.status ?? record.state ?? record.status_code ?? record.statusCode;
  const statusStr =
    typeof record.status_str === "string"
      ? record.status_str
      : typeof record.statusStr === "string"
        ? record.statusStr
        : undefined;

  let state = statusToState(rawStatus, statusStr);
  if (!state) {
    if (record.done === true || record.finished === true || record.completed === true) state = "done";
    else if (record.failed === true || record.error === true) state = "failed";
    else if (typeof record.progress === "number" && record.progress >= 100) state = "done";
    else state = "pending";
  }

  const result =
    record.result ??
    record.output ??
    record.translated ??
    record.translatedFileUrl ??
    record.resultUrl ??
    record.result_url;

  const urls = collectResultUrls(result);
  for (const key of ["translatedFileUrl", "resultUrl", "result_url", "downloadUrl", "output", "files"]) {
    for (const url of collectResultUrls(record[key])) if (!urls.includes(url)) urls.push(url);
  }

  return {
    state,
    ...(typeof rawStatus === "number" || typeof rawStatus === "string" ? { status: rawStatus } : {}),
    ...(statusStr ? { status_str: statusStr } : {}),
    ...(result !== undefined ? { result } : {}),
    result_urls: urls,
    ...(upstreamRemark(payload) ? { remark: upstreamRemark(payload) } : {}),
    payload,
  };
}

export interface PollResult {
  state: JobState;
  timed_out: boolean;
}

/**
 * Poll a status function until done/failed or the deadline. The first poll is
 * immediate so `timeoutMs: 0` still returns a fresh status snapshot.
 */
export async function pollJob(
  poll: () => Promise<unknown>,
  options: { timeoutMs: number; intervalMs: number },
): Promise<PollResult> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  let last: JobState | undefined;

  for (;;) {
    last = normalizeJobState(await poll());
    if (last.state !== "pending") return { state: last, timed_out: false };

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: last, timed_out: true };

    const sleepMs = Math.min(Math.max(50, options.intervalMs), remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
  }
}

export interface TextChunkPlan {
  chunks: string[];
  separators: string[];
}

function isLowSurrogate(code: number): boolean {
  return (code & 0xfc00) === 0xdc00;
}

function chooseBoundary(window: string): { cut: number; separator: string } | undefined {
  const minUseful = Math.max(1, Math.floor(window.length * 0.4));

  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= minUseful) return { cut: paragraph, separator: "\n\n" };

  const line = window.lastIndexOf("\n");
  if (line >= minUseful) return { cut: line, separator: "\n" };

  let best: { cut: number; separator: string } | undefined;
  const sentence = /[.!?。！？；;]\s+/gu;
  for (let match = sentence.exec(window); match; match = sentence.exec(window)) {
    if (match.index >= minUseful) {
      best = { cut: match.index + 1, separator: match[0].slice(1) };
    }
  }
  if (best) return best;

  const whitespace = /\s+/gu;
  for (let match = whitespace.exec(window); match; match = whitespace.exec(window)) {
    if (match.index >= minUseful) {
      best = { cut: match.index, separator: match[0] };
    }
  }
  return best;
}

/**
 * Split long text into upstream-safe pieces (<=1,900 characters) while keeping
 * the original whitespace in `separators` so the translated pieces can be
 * joined back without losing spaces or paragraph breaks.
 */
export function chunkTextForUpstream(text: string, maxChars = MAX_UPSTREAM_TEXT_CHARS): TextChunkPlan {
  if (text.length <= maxChars) return { chunks: [text], separators: [""] };

  const chunks: string[] = [];
  const separators: string[] = [];
  let start = 0;

  while (start < text.length) {
    let hardEnd = Math.min(start + maxChars, text.length);
    if (hardEnd < text.length && isLowSurrogate(text.charCodeAt(hardEnd))) hardEnd -= 1;
    if (hardEnd <= start) hardEnd = Math.min(start + 1, text.length);

    let cut = hardEnd - start;
    let separator = "";
    if (hardEnd < text.length) {
      const window = text.slice(start, hardEnd);
      const boundary = chooseBoundary(window);
      if (boundary && boundary.cut > 0 && boundary.cut < cut) {
        cut = boundary.cut;
        separator = boundary.separator;
      }
    }

    const chunk = text.slice(start, start + cut);
    if (chunk.length > 0) {
      chunks.push(chunk);
      separators.push(separator);
    }
    start = start + cut + separator.length;
  }

  if (chunks.length === 0) return { chunks: [text], separators: [""] };
  separators[separators.length - 1] = "";
  return { chunks, separators };
}

function requireUpstreamToken(env: Env): string {
  const token = env.UPSTREAM_API_TOKEN?.trim();
  if (!token) {
    throw new UpstreamError(
      "UPSTREAM_API_TOKEN is not configured on this Worker. Set it with `wrangler secret put UPSTREAM_API_TOKEN` before using paid translation tools.",
      undefined,
      "upstream_not_configured",
    );
  }
  return token;
}

export async function postUpstream(env: Env, baseUrl: string, path: string, body: unknown): Promise<unknown> {
  const token = requireUpstreamToken(env);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        channel: "ai",
        "user-agent": "mcp-transmonkey/0.1.0",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(upstreamTimeoutMs(env)),
    });
  } catch (error) {
    throw new UpstreamError(
      `Translation upstream request failed (${errorMessage(error)}).`,
      undefined,
      "upstream_unreachable",
    );
  }

  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError(
      `Translation upstream returned a redirect (HTTP ${response.status}); redirects are not followed.`,
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
      `Translation upstream returned non-JSON (HTTP ${response.status}).`,
      response.status,
      "invalid_upstream_response",
    );
  }

  if (!response.ok) {
    throw new UpstreamError(
      `Translation upstream returned HTTP ${response.status}: ${upstreamRemark(payload) ?? "unknown error"}.`,
      response.status,
      "upstream_http_error",
    );
  }
  if (payload === undefined) {
    throw new UpstreamError(
      "Translation upstream returned an empty body.",
      response.status,
      "invalid_upstream_response",
    );
  }

  return unwrapUpstream(payload);
}

/** Translate one or more strings, splitting long inputs into <=1,900 chars. */
export async function translateTexts(
  env: Env,
  options: { from: string; to: string; texts: string[] },
): Promise<string[]> {
  requireUpstreamToken(env);

  const plans = options.texts.map((text) =>
    text.trim() === "" ? { empty: true, chunks: [] as string[], separators: [] as string[] } : {
      empty: false,
      ...chunkTextForUpstream(text),
    },
  );

  const flat: string[] = [];
  for (const plan of plans) for (const chunk of plan.chunks) flat.push(chunk);

  const translatedChunks: string[] = [];
  for (let offset = 0; offset < flat.length; offset += MAX_UPSTREAM_TEXTS_PER_CALL) {
    const batch = flat.slice(offset, offset + MAX_UPSTREAM_TEXTS_PER_CALL);
    const payload = await postUpstream(env, textBaseUrl(env), "/translate/text", {
      from: options.from,
      to: options.to,
      contents: batch,
    });
    translatedChunks.push(...extractTranslations(payload, batch.length));
  }

  let cursor = 0;
  return plans.map((plan, index) => {
    if (plan.empty) return options.texts[index];
    const pieces = translatedChunks.slice(cursor, cursor + plan.chunks.length);
    cursor += plan.chunks.length;
    return pieces.map((piece, i) => piece + (plan.separators[i] ?? "")).join("");
  });
}

export interface DocCostInput {
  doc: string;
  from: string;
  to: string;
  fileName: string;
  userId: string;
}

export function docCost(env: Env, input: DocCostInput): Promise<unknown> {
  return postUpstream(env, docBaseUrl(env), "/doc-translate/cost", {
    doc: input.doc,
    from: input.from,
    to: input.to,
    fileName: input.fileName,
    userId: input.userId,
    previewCredits: 1,
    fastCreation: 1,
  });
}

export function docPreview(env: Env, taskId: string): Promise<unknown> {
  return postUpstream(env, docBaseUrl(env), "/doc-translate/preview", { taskId });
}

export function docCreate(env: Env, input: DocCostInput): Promise<unknown> {
  return postUpstream(env, docBaseUrl(env), "/doc-translate/create", {
    doc: input.doc,
    from: input.from,
    to: input.to,
    fileName: input.fileName,
    userId: input.userId,
  });
}

export function docStatus(env: Env, jobId: string): Promise<unknown> {
  return postUpstream(env, docBaseUrl(env), "/doc-translate/status", { jobId });
}

export interface ImageCreateInput {
  imgs: string[];
  from: string;
  to: string;
  userId: string;
  font: string;
  paste: number;
}

export function imageCreate(env: Env, input: ImageCreateInput): Promise<unknown> {
  return postUpstream(env, imageBaseUrl(env), "/img-translate/create", {
    imgs: input.imgs,
    from: input.from,
    to: input.to,
    paste: input.paste,
    font: input.font,
    userId: input.userId,
  });
}

export function imageStatus(env: Env, jobId: string): Promise<unknown> {
  return postUpstream(env, imageBaseUrl(env), "/img-translate/status", { jobId });
}

export function defaultPollInterval(env: Env): number {
  return jobPollIntervalMs(env);
}
