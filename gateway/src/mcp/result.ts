import { AppError, isRecord, sanitizeUpstreamMessage } from "./http";
import { extractHtmlTables, extractMarkdownPipeTables, type ParsedTable } from "./tables";

export interface UpstreamFileResult {
  name: string;
  markdown: string;
  contentList: unknown[];
}

export interface OcrBlock {
  type: string;
  text: string;
  bbox: [number, number, number, number] | null;
  page_idx: number | null;
}

export interface ExtractedTable extends ParsedTable {
  page_idx: number | null;
  bbox: [number, number, number, number] | null;
}

export interface ConvertFileOutput {
  file_index: number;
  markdown: string;
  markdown_truncated: boolean;
  layout_json?: unknown[];
  layout_json_omitted?: boolean;
}

const MAX_MARKDOWN_CHARS = 1_500_000;
const MAX_LAYOUT_JSON_CHARS = 1_500_000;
const NON_TEXT_TYPES = new Set(["image", "image_body", "chart"]);

export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export class UpstreamBusinessError extends Error {
  constructor(
    message: string,
    readonly code: unknown,
    readonly pending: boolean,
  ) {
    super(message);
    this.name = "UpstreamBusinessError";
  }
}

function isPendingMessage(message: string): boolean {
  return /(?:pending|processing|running|in[\s_-]*progress|not[\s_-]*(?:ready|done|completed|finished)|task[\s_-]*is[\s_-]*not[\s_-]*(?:ready|done|completed|finished)|http_status:(?:202|409|425))/i.test(
    message,
  );
}

/** Unwrap {code,data,msg} and surface upstream business errors. */
export function unwrapGatewayData(payload: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new AppError(502, "mineru_invalid_response", `MinerU ${operation} returned an invalid response.`);
  }
  if (payload.code !== undefined && Number(payload.code) !== 0) {
    const message = sanitizeUpstreamMessage(payload.msg, `MinerU ${operation} failed.`);
    throw new UpstreamBusinessError(message, payload.code, isPendingMessage(message));
  }
  if (isRecord(payload.data)) return payload.data;
  if (isRecord(payload.results) || Array.isArray(payload.files) || payload.status !== undefined) {
    return payload;
  }
  throw new AppError(502, "mineru_invalid_response", `MinerU ${operation} returned no data.`);
}

export type TaskState =
  | { state: "pending" }
  | { state: "failed"; message: string }
  | { state: "done"; data: Record<string, unknown>; taskId: string | null };

export function normalizeTaskState(data: Record<string, unknown>): TaskState {
  const results = parseMaybeJson(data.results);
  if (isRecord(results) && Object.keys(results).length > 0) {
    return { state: "done", data: { ...data, results }, taskId: taskIdOf(data) };
  }
  if (Array.isArray(data.files) && data.files.length > 0) {
    return { state: "done", data, taskId: taskIdOf(data) };
  }

  const statusNumber = Number(data.status);
  const statusText = String(data.status_str ?? data.status ?? "").toLowerCase();
  const result = parseMaybeJson(data.result);
  const resultRecord = isRecord(result) ? result : null;

  if (
    statusNumber === -1 ||
    ["failed", "fail", "error", "cancelled", "canceled"].includes(statusText) ||
    (resultRecord && ["failed", "fail", "error", "cancelled", "canceled"].includes(String(resultRecord.status).toLowerCase()))
  ) {
    const message = resultRecord
      ? resultRecord.error ?? resultRecord.message ?? data.remark
      : data.remark;
    return {
      state: "failed",
      message: sanitizeUpstreamMessage(message, "MinerU task failed."),
    };
  }

  if (
    statusNumber === 0 ||
    statusNumber === 4 ||
    ["waiting", "pending", "processing", "running", "queued"].includes(statusText)
  ) {
    return { state: "pending" };
  }

  if (statusNumber === 10 || ["completed", "succeeded", "success", "done"].includes(statusText)) {
    const resultResults = resultRecord ? parseMaybeJson(resultRecord.results) : null;
    if (resultRecord && isRecord(resultResults) && Object.keys(resultResults).length > 0) {
      return {
        state: "done",
        data: { ...resultRecord, results: resultResults, task_id: taskIdOf(resultRecord) ?? taskIdOf(data) },
        taskId: taskIdOf(resultRecord) ?? taskIdOf(data),
      };
    }
    return {
      state: "failed",
      message: sanitizeUpstreamMessage(
        resultRecord ? resultRecord.error ?? resultRecord.message ?? data.remark : data.remark,
        "MinerU completed without results.",
      ),
    };
  }

  return { state: "pending" };
}

export function taskIdOf(data: Record<string, unknown>): string | null {
  for (const key of ["task_id", "taskId", "jobId", "upstream_task_id", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function collectFileResults(data: Record<string, unknown>): UpstreamFileResult[] {
  const output: UpstreamFileResult[] = [];
  const results = parseMaybeJson(data.results);

  if (isRecord(results)) {
    for (const [name, value] of Object.entries(results)) {
      if (!isRecord(value)) continue;
      const contentList = parseMaybeJson(value.content_list);
      output.push({
        name,
        markdown: stringField(value.md_content) || stringField(value.md) || stringField(value.markdown),
        contentList: Array.isArray(contentList) ? contentList : [],
      });
    }
  } else if (Array.isArray(data.files)) {
    data.files.forEach((value, index) => {
      if (!isRecord(value)) return;
      const contentList = parseMaybeJson(value.content_list);
      output.push({
        name: `file-${index + 1}`,
        markdown: stringField(value.markdown) || stringField(value.md_content) || stringField(value.md),
        contentList: Array.isArray(contentList) ? contentList : [],
      });
    });
  }

  return output;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function validBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map((part) => Number(part));
  if (numbers.some((part) => !Number.isFinite(part))) return null;
  const [x0, y0, x1, y1] = numbers as [number, number, number, number];
  if (x1 < x0 || y1 < y0) return null;
  return [x0, y0, x1, y1];
}

function pageIndexOf(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function tableCellBlocks(table: ParsedTable, bbox: [number, number, number, number] | null, pageIdx: number | null): OcrBlock[] {
  if (!bbox) {
    return table.rows.flatMap((row) =>
      row
        .filter((cell) => normalizeText(cell))
        .map((cell) => ({ type: "table_cell", text: normalizeText(cell), bbox: null, page_idx: pageIdx })),
    );
  }
  const [left, top, right, bottom] = bbox;
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return [];
  return table.rows.flatMap((row, rowIndex) =>
    row.flatMap((cell, columnIndex) => {
      const text = normalizeText(cell);
      if (!text) return [];
      const cellBbox: [number, number, number, number] = [
        left + (width * columnIndex) / table.column_count,
        top + (height * rowIndex) / table.row_count,
        left + (width * (columnIndex + 1)) / table.column_count,
        top + (height * (rowIndex + 1)) / table.row_count,
      ];
      return [{ type: "table_cell", text, bbox: cellBbox, page_idx: pageIdx }];
    }),
  );
}

function blocksFromContentList(contentList: unknown[]): OcrBlock[] {
  const blocks: OcrBlock[] = [];

  for (const item of contentList) {
    if (!isRecord(item)) continue;
    const type = String(item.type ?? "text").toLowerCase();
    if (NON_TEXT_TYPES.has(type)) continue;
    const pageIdx = pageIndexOf(item.page_idx);
    const bbox = validBbox(item.bbox);

    if (type === "table") {
      const body = stringField(item.table_body) || stringField(item.text) || stringField(item.md);
      let tables = extractHtmlTables(body);
      if (tables.length === 0) tables = extractMarkdownPipeTables(body);
      if (tables.length > 0) {
        for (const table of tables) blocks.push(...tableCellBlocks(table, bbox, pageIdx));
        continue;
      }
    }

    const text = normalizeText(item.text ?? item.content ?? item.title ?? item.caption);
    if (!text) continue;
    blocks.push({ type, text, bbox, page_idx: pageIdx });
  }

  return dedupeBlocks(blocks);
}

function blocksFromMarkdown(markdown: string): OcrBlock[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .map((text) => ({ type: "text", text, bbox: null, page_idx: 0 }));
}

function dedupeBlocks(blocks: OcrBlock[]): OcrBlock[] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    if (!block.text) return false;
    const bboxKey = block.bbox ? block.bbox.map((value) => Math.round(value)).join(",") : "null";
    const key = `${block.text}|${bboxKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractOcrBlocks(file: UpstreamFileResult): {
  blocks: OcrBlock[];
  source: "content_list" | "markdown";
  bbox_available: boolean;
} {
  const fromContent = blocksFromContentList(file.contentList);
  if (fromContent.length > 0) {
    return {
      blocks: fromContent,
      source: "content_list",
      bbox_available: fromContent.every((block) => block.bbox !== null),
    };
  }
  const fallback = dedupeBlocks(blocksFromMarkdown(file.markdown));
  return {
    blocks: fallback,
    source: "markdown",
    bbox_available: false,
  };
}

export function extractTables(file: UpstreamFileResult): ExtractedTable[] {
  const tables: ExtractedTable[] = [];

  for (const item of file.contentList) {
    if (!isRecord(item) || String(item.type ?? "").toLowerCase() !== "table") continue;
    const pageIdx = pageIndexOf(item.page_idx);
    const bbox = validBbox(item.bbox);
    const body = stringField(item.table_body);
    const text = stringField(item.text) || stringField(item.md);

    let parsed: ParsedTable[] = [];
    if (body) {
      parsed = extractHtmlTables(body);
      if (parsed.length === 0) parsed = extractMarkdownPipeTables(body);
    }
    if (parsed.length === 0 && text) {
      parsed = extractHtmlTables(text);
      if (parsed.length === 0) parsed = extractMarkdownPipeTables(text);
    }
    for (const table of parsed) tables.push({ ...table, page_idx: pageIdx, bbox });
  }

  if (tables.length === 0) {
    const fromMarkdownHtml = extractHtmlTables(file.markdown);
    const fromMarkdownPipes = fromMarkdownHtml.length === 0 ? extractMarkdownPipeTables(file.markdown) : [];
    for (const table of [...fromMarkdownHtml, ...fromMarkdownPipes]) {
      tables.push({ ...table, page_idx: 0, bbox: null });
    }
  }

  return dedupeTables(tables);
}

function dedupeTables(tables: ExtractedTable[]): ExtractedTable[] {
  const seen = new Set<string>();
  return tables.filter((table) => {
    const key = `${table.page_idx ?? "null"}|${table.html}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function convertFileOutput(
  file: UpstreamFileResult,
  fileIndex: number,
  includeLayoutJson: boolean,
): ConvertFileOutput {
  let markdown = file.markdown;
  let markdownTruncated = false;
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    markdown = `${markdown.slice(0, MAX_MARKDOWN_CHARS)}\n\n[Output truncated by mcp-doc-markdown-mcp]`;
    markdownTruncated = true;
  }

  const output: ConvertFileOutput = {
    file_index: fileIndex,
    markdown,
    markdown_truncated: markdownTruncated,
  };

  if (includeLayoutJson) {
    if (JSON.stringify(file.contentList).length > MAX_LAYOUT_JSON_CHARS) {
      output.layout_json_omitted = true;
    } else {
      output.layout_json = file.contentList;
    }
  }

  return output;
}
