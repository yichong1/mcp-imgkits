import { chargeCost, type ChargeFn } from "./charge";
import { createMineruTask, waitForMineruResult } from "./mineru";
import { AppError, isRecord, logEvent } from "./http";
import type { RuntimeDeps } from "./deps";
import { collectFileResults, convertFileOutput, extractOcrBlocks, extractTables } from "./result";
import { MAX_FILES, MAX_FILE_BYTES, preflightFileUrls, validateFileUrls } from "./urls";

const ATTRIBUTION =
  "Powered by MinerU (opendatalab/MinerU). License: https://github.com/opendatalab/MinerU/blob/master/LICENSE.md";
const RETENTION =
  "This Worker does not store uploaded files or results. Upstream MinerU task data is temporary (≤24h).";
const LIMITS =
  "Input: 1-5 public https file URLs, each ≤20 MiB. Supported: pdf, png, jpeg, webp, bmp, tiff. DOCX is not supported in this release. Private, local, and metadata hosts are rejected.";
const BILLING =
  "Billing: charged before the MinerU job is created (default 1 credit per tool call). No automatic refunds.";

type ToolName = "convert_to_markdown" | "ocr_image" | "extract_tables";

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

const filesSchema = {
  type: "array",
  minItems: 1,
  maxItems: MAX_FILES,
  items: {
    type: "string",
    format: "uri",
    description: "Public https URL pointing directly to a supported PDF or image file.",
  },
  description: "1-5 public https file URLs.",
};

export const TOOLS: ToolDefinition[] = [
  {
    name: "convert_to_markdown",
    title: "Convert PDF or image to Markdown",
    description: [
      "Convert PDF and image files to clean Markdown for RAG, LLM ingestion, and knowledge bases. Optionally include MinerU layout JSON (content list with blocks and bounding boxes).",
      LIMITS,
      "Processing is asynchronous upstream; this call polls until done or times out after about 75 seconds.",
      RETENTION,
      BILLING,
      ATTRIBUTION,
    ].join("\n\n"),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        files: filesSchema,
        include_layout_json: {
          type: "boolean",
          default: false,
          description: "When true, also return MinerU layout JSON (content_list) for each file.",
        },
      },
      required: ["files"],
    },
    annotations: {
      title: "Convert PDF or image to Markdown",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "ocr_image",
    title: "Image OCR with bounding boxes",
    description: [
      "Extract text from images, screenshots, and scanned PDF pages. Returns text blocks with block-level bounding boxes [x0, y0, x1, y1] and page indexes. Coordinates are MinerU content-list coordinates, not character-level boxes and not rescaled to pixels.",
      LIMITS,
      "Tables inside an image are returned as positioned table_cell blocks. Processing is asynchronous and this call polls until done or times out after about 75 seconds.",
      RETENTION,
      BILLING,
      ATTRIBUTION,
    ].join("\n\n"),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { files: filesSchema },
      required: ["files"],
    },
    annotations: {
      title: "Image OCR with bounding boxes",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "extract_tables",
    title: "Extract tables from PDF or image",
    description: [
      "Extract tables from PDFs and images as HTML plus a row/column matrix. Merged cells are expanded; only the top-left cell carries content and other covered cells are empty strings. Returns row_count, column_count, page_idx, and bbox for each table.",
      LIMITS,
      "Table structure is model-recognized, so complex, borderless, or handwritten tables may contain errors. Processing is asynchronous and this call polls until done or times out after about 75 seconds.",
      RETENTION,
      BILLING,
      ATTRIBUTION,
    ].join("\n\n"),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { files: filesSchema },
      required: ["files"],
    },
    annotations: {
      title: "Extract tables from PDF or image",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

export const LOCAL_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((tool) => tool.name));

export interface ToolContext {
  env: Env;
  bearer: string;
  deps: RuntimeDeps;
  charge: ChargeFn;
}

export interface ToolCallResult {
  structured: Record<string, unknown>;
  summary: string;
}

export async function callTool(name: string, rawArguments: unknown, context: ToolContext): Promise<ToolCallResult> {
  if (name !== "convert_to_markdown" && name !== "ocr_image" && name !== "extract_tables") {
    throw new AppError(404, "tool_not_found", `Unknown tool: ${name.slice(0, 100)}`);
  }
  const toolName: ToolName = name;
  const args = isRecord(rawArguments) ? rawArguments : {};
  assertAllowedKeys(args, toolName);
  assertMineruConfigured(context.env);

  const files = validateFileUrls(args.files);
  const includeLayoutJson =
    toolName === "convert_to_markdown" ? booleanArg(args.include_layout_json, false) : false;

  await preflightFileUrls(files, {
    fetchImpl: context.deps.fetchImpl,
    maxBytes: MAX_FILE_BYTES,
  });

  const jobId = context.deps.randomId();
  const cost = chargeCost(context.env.MCP_CHARGE_COST);
  const charge = await context.charge({ cost, tool: toolName, ref: jobId });

  let taskId: string | undefined;
  let output: Record<string, unknown> = {};
  try {
    const created = await createMineruTask(files, mineruOptions(context));
    taskId = created.taskId;
    const finished = await waitForMineruResult(created.taskId, mineruOptions(context));
    taskId = finished.taskId;

    const fileResults = collectFileResults(finished.data);
    if (fileResults.length === 0) {
      throw new AppError(502, "mineru_result_missing", "MinerU returned no file results.");
    }

    output = buildOutput(toolName, fileResults, includeLayoutJson);
    output.task_id = taskId;
    output.backend = created.backend;
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError(error.status, error.code, error.message, true, jobId, taskId ?? error.taskId);
    }
    throw new AppError(502, "mineru_failed", "MinerU request failed.", true, jobId, taskId);
  }

  logEvent("info", "tool_ok", {
    tool: toolName,
    job_id: jobId,
    charged: charge.charged,
    files: files.length,
  });

  return {
    structured: {
      job_id: jobId,
      tool: toolName,
      charged: charge.charged,
      charge_id: charge.chargeId,
      balance_after: charge.balanceAfter,
      ...output,
      retention: RETENTION,
      attribution: ATTRIBUTION,
    },
    summary: `${toolName} completed (job ${jobId}, ${files.length} file${files.length === 1 ? "" : "s"}).`,
  };
}

function assertMineruConfigured(env: Env): void {
  if (!env.MINERU_S2S_BEARER?.trim() || !env.MINERU_BASE_URL?.trim()) {
    throw new AppError(503, "mineru_not_configured", "MinerU upstream is not configured on this server.");
  }
}

function mineruOptions(context: ToolContext) {
  return {
    deps: context.deps,
    baseUrl: context.env.MINERU_BASE_URL ?? "",
    token: context.env.MINERU_S2S_BEARER ?? "",
    channel: context.env.MINERU_CHANNEL,
  };
}

function buildOutput(
  toolName: ToolName,
  fileResults: ReturnType<typeof collectFileResults>,
  includeLayoutJson: boolean,
): Record<string, unknown> {
  if (toolName === "convert_to_markdown") {
    return {
      files: fileResults.map((file, index) => convertFileOutput(file, index, includeLayoutJson)),
    };
  }

  if (toolName === "ocr_image") {
    const files = fileResults.map((file, index) => {
      const ocr = extractOcrBlocks(file);
      return {
        file_index: index,
        source: ocr.source,
        bbox_available: ocr.bbox_available,
        blocks: ocr.blocks,
      };
    });
    return {
      files,
      block_count: files.reduce((total, file) => total + file.blocks.length, 0),
    };
  }

  const files = fileResults.map((file, index) => ({
    file_index: index,
    tables: extractTables(file),
  }));
  return {
    files,
    table_count: files.reduce((total, file) => total + file.tables.length, 0),
  };
}

function assertAllowedKeys(args: Record<string, unknown>, toolName: ToolName): void {
  const allowed = toolName === "convert_to_markdown" ? new Set(["files", "include_layout_json"]) : new Set(["files"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new AppError(400, "invalid_arguments", `Unknown argument for ${toolName}: ${key.slice(0, 100)}`);
    }
  }
}

function booleanArg(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new AppError(400, "invalid_arguments", "include_layout_json must be a boolean.");
  }
  return value;
}
