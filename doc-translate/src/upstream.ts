import {
  MAX_UPSTREAM_TEXT_CHARS,
  MAX_UPSTREAM_TEXTS_PER_CALL,
  apiBaseUrl,
  jobPollIntervalMs,
  mineruBasePath,
  translateTextPath,
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
        `Upstream rejected the request: ${upstreamRemark(record) ?? `code ${String(code)}`}`,
        undefined,
        "upstream_rejected",
        { upstream_code: code },
      );
    }
  }

  if (record.ok === false || record.success === false) {
    throw new UpstreamError(
      `Upstream rejected the request: ${upstreamRemark(record) ?? "unknown error"}`,
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

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function extractTaskId(payload: unknown): string | undefined {
  return deepFindString(payload, ["task_id", "taskId", "jobId", "job_id", "upstream_task_id", "id"]);
}

export interface MineruFileResult {
  name: string;
  markdown: string;
}

/** Pull markdown from MinerU done payload (results map or files array). */
export function collectMineruMarkdown(data: unknown): MineruFileResult[] {
  const record = asRecord(data) ?? {};
  const output: MineruFileResult[] = [];
  const results = parseMaybeJson(record.results);

  if (asRecord(results)) {
    for (const [name, value] of Object.entries(asRecord(results)!)) {
      const row = asRecord(value);
      if (!row) continue;
      const md =
        stringField(row.md_content) || stringField(row.md) || stringField(row.markdown);
      output.push({ name, markdown: md });
    }
  } else if (Array.isArray(record.files)) {
    record.files.forEach((value, index) => {
      const row = asRecord(value);
      if (!row) return;
      const md =
        stringField(row.markdown) || stringField(row.md_content) || stringField(row.md);
      output.push({ name: `file-${index + 1}`, markdown: md });
    });
  }

  return output;
}

export type MineruTaskState =
  | { state: "pending"; task_id?: string }
  | { state: "failed"; message: string; task_id?: string }
  | { state: "done"; data: JsonRecord; task_id?: string };

function numericStatus(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

export function normalizeMineruState(payload: unknown): MineruTaskState {
  const data = asRecord(payload) ?? {};
  const taskId = extractTaskId(data);
  const results = parseMaybeJson(data.results);
  if (asRecord(results) && Object.keys(asRecord(results)!).length > 0) {
    return { state: "done", data: { ...data, results }, ...(taskId ? { task_id: taskId } : {}) };
  }
  if (
    Array.isArray(data.files) &&
    data.files.length > 0 &&
    data.files.every((file) => asRecord(file))
  ) {
    return { state: "done", data, ...(taskId ? { task_id: taskId } : {}) };
  }

  const statusNumber = numericStatus(data.status);
  const statusText = String(data.status_str ?? data.status ?? "").toLowerCase();
  const result = parseMaybeJson(data.result);
  const resultRecord = asRecord(result);

  if (
    statusNumber === -1 ||
    ["failed", "fail", "error", "cancelled", "canceled"].includes(statusText)
  ) {
    return {
      state: "failed",
      message: upstreamRemark(data) ?? upstreamRemark(resultRecord) ?? "MinerU task failed.",
      ...(taskId ? { task_id: taskId } : {}),
    };
  }

  if (
    statusNumber === 0 ||
    statusNumber === 4 ||
    ["waiting", "pending", "processing", "running", "queued"].includes(statusText)
  ) {
    return { state: "pending", ...(taskId ? { task_id: taskId } : {}) };
  }

  if (statusNumber === 10 || ["completed", "succeeded", "success", "done"].includes(statusText)) {
    const resultResults = resultRecord ? parseMaybeJson(resultRecord.results) : null;
    if (resultRecord && asRecord(resultResults) && Object.keys(asRecord(resultResults)!).length > 0) {
      const nestedId = extractTaskId(resultRecord) ?? taskId;
      return {
        state: "done",
        data: { ...resultRecord, results: resultResults, task_id: nestedId },
        ...(nestedId ? { task_id: nestedId } : {}),
      };
    }
    // Also accept markdown directly on result
    const files = collectMineruMarkdown(resultRecord ?? data);
    if (files.some((f) => f.markdown.trim())) {
      return {
        state: "done",
        data: resultRecord ?? data,
        ...(taskId ? { task_id: taskId } : {}),
      };
    }
    return {
      state: "failed",
      message: upstreamRemark(resultRecord) ?? upstreamRemark(data) ?? "MinerU completed without results.",
      ...(taskId ? { task_id: taskId } : {}),
    };
  }

  return { state: "pending", ...(taskId ? { task_id: taskId } : {}) };
}

export interface PollResult<T> {
  state: T;
  timed_out: boolean;
}

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

/** MinerU S2S: Bearer when UPSTREAM_API_TOKEN + UPSTREAM_ATTACH_AUTH=1. */
function mineruHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "mcp-doc-translate/0.1.0",
  };
  const token = optionalUpstreamToken(env);
  if (token && env.UPSTREAM_ATTACH_AUTH?.trim() === "1") {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Public translate/text: never attach Authorization. */
function translateHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    channel: "ai",
    "user-agent": "mcp-doc-translate/0.1.0",
  };
}

async function readUpstreamJson(response: Response, label: string): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError(
      `${label} returned a redirect (HTTP ${response.status}); redirects are not followed.`,
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
      `${label} returned non-JSON (HTTP ${response.status}).`,
      response.status,
      "invalid_upstream_response",
    );
  }

  if (!response.ok) {
    throw new UpstreamError(
      `${label} returned HTTP ${response.status}: ${upstreamRemark(payload) ?? "unknown error"}.`,
      response.status,
      "upstream_http_error",
    );
  }
  if (payload === undefined) {
    throw new UpstreamError(`${label} returned an empty body.`, response.status, "invalid_upstream_response");
  }
  return unwrapUpstream(payload);
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UpstreamError(
      `${label} request failed (${errorMessage(error)}).`,
      undefined,
      "upstream_unreachable",
    );
  }
  return readUpstreamJson(response, label);
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UpstreamError(
      `${label} request failed (${errorMessage(error)}).`,
      undefined,
      "upstream_unreachable",
    );
  }
  return readUpstreamJson(response, label);
}

export async function mineruCreate(
  env: Env,
  files: string[],
  fromApp: string,
): Promise<{ taskId: string; payload: unknown }> {
  const base = `${apiBaseUrl(env)}${mineruBasePath(env)}`;
  const payload = await postJson(
    `${base}/create`,
    mineruHeaders(env),
    {
      files,
      from_app: fromApp,
      return_md: true,
      return_content_list: true,
      return_middle_json: false,
      return_model_output: false,
    },
    upstreamTimeoutMs(env),
    "MinerU create",
  );
  const taskId = extractTaskId(payload);
  if (!taskId || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
    throw new UpstreamError("MinerU create returned no usable task id.", undefined, "mineru_failed");
  }
  return { taskId, payload };
}

export async function mineruResult(env: Env, taskId: string): Promise<unknown> {
  const base = `${apiBaseUrl(env)}${mineruBasePath(env)}`;
  return getJson(
    `${base}/result/${encodeURIComponent(taskId)}`,
    mineruHeaders(env),
    upstreamTimeoutMs(env),
    "MinerU result",
  );
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
    `Translate returned ${closest?.length ?? 0} result(s) for ${expected} input item(s).`,
    undefined,
    "translate_failed",
    { expected, received: closest?.length ?? 0 },
  );
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

/** Translate one or more strings via public /translate/text (no Authorization). */
export async function translateTexts(
  env: Env,
  options: { from: string; to: string; texts: string[] },
): Promise<string[]> {
  const plans = options.texts.map((text) =>
    text.trim() === ""
      ? { empty: true, chunks: [] as string[], separators: [] as string[] }
      : { empty: false, ...chunkTextForUpstream(text) },
  );

  const flat: string[] = [];
  for (const plan of plans) for (const chunk of plan.chunks) flat.push(chunk);

  const translatedChunks: string[] = [];
  const url = `${apiBaseUrl(env)}${translateTextPath(env)}`;
  for (let offset = 0; offset < flat.length; offset += MAX_UPSTREAM_TEXTS_PER_CALL) {
    const batch = flat.slice(offset, offset + MAX_UPSTREAM_TEXTS_PER_CALL);
    try {
      const payload = await postJson(
        url,
        translateHeaders(),
        { from: options.from, to: options.to, contents: batch },
        upstreamTimeoutMs(env),
        "Translate text",
      );
      translatedChunks.push(...extractTranslations(payload, batch.length));
    } catch (error) {
      if (error instanceof UpstreamError) {
        throw new UpstreamError(error.message, error.status, "translate_failed", error.details);
      }
      throw new UpstreamError(errorMessage(error), undefined, "translate_failed");
    }
  }

  let cursor = 0;
  return plans.map((plan, index) => {
    if (plan.empty) return options.texts[index];
    const pieces = translatedChunks.slice(cursor, cursor + plan.chunks.length);
    cursor += plan.chunks.length;
    return pieces.map((piece, i) => piece + (plan.separators[i] ?? "")).join("");
  });
}

export function defaultPollInterval(env: Env): number {
  return jobPollIntervalMs(env);
}
