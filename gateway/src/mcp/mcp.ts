import { AppError, isRecord, logEvent, sanitizeUpstreamMessage } from "./http";
import {
  MARKANY_LABEL,
  MARKANY_TOOL_NAMES,
  callMarkAnyTool,
  listMarkAnyTools,
  markanyConfigured,
  markanyToolCost,
} from "./markany";
import { LOCAL_TOOL_NAMES, TOOLS, callTool, type ToolContext } from "./tools";
import {
  TRANSMONKEY_LABEL,
  callUpstreamTool,
  listUpstreamTools,
  transmonkeyConfigured,
  upstreamToolCost,
} from "./transmonkey";
import type { MountCallInput, MountInput, UpstreamTool } from "./upstream";

const SERVER_NAME = "mcp-doc-markdown-mcp";
const SERVER_VERSION = "0.1.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS = [
  "Document conversion, image OCR, and table extraction, powered by MinerU (opendatalab/MinerU).",
  "Supports PDF and image URLs only: pdf, png, jpeg, webp, bmp, tiff. DOCX is not supported in this release.",
  "Each call accepts 1-5 public https file URLs, ≤20 MiB per file. Private, local, and metadata hosts are rejected.",
  "Each call costs 1 credit by default, charged before the MinerU job is created. Results are not stored by this Worker.",
  "API keys are issued manually by the operator. There is no self-service key page.",
  "Attribution: Powered by MinerU (opendatalab/MinerU). License: https://github.com/opendatalab/MinerU/blob/master/LICENSE.md",
].join("\n");

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface McpResponse {
  status: number;
  body: unknown | null;
  headers?: HeadersInit;
}

export async function handleMcpBody(body: unknown, context: ToolContext): Promise<McpResponse> {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return {
        status: 400,
        body: rpcError(null, -32600, "Invalid Request: empty batch."),
      };
    }
    const responses: unknown[] = [];
    for (const item of body) {
      const response = await handleOne(item, context);
      if (response.body !== null) responses.push(response.body);
    }
    if (responses.length === 0) return { status: 202, body: null };
    return { status: 200, body: responses };
  }

  return handleOne(body, context);
}

async function handleOne(raw: unknown, context: ToolContext): Promise<McpResponse> {
  if (!isRecord(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string") {
    return {
      status: 400,
      body: rpcError(null, -32600, "Invalid Request."),
    };
  }

  const request = raw as unknown as JsonRpcRequest;
  const isNotification = !("id" in request) || request.id === undefined;
  const id = isNotification ? null : request.id ?? null;

  if (request.method.startsWith("notifications/")) {
    return { status: 202, body: null };
  }

  try {
    switch (request.method) {
      case "initialize":
        return ok(id, initializeResult(request.params), isNotification);
      case "ping":
        return ok(id, {}, isNotification);
      case "tools/list":
        return ok(id, { tools: await listTools(context) }, isNotification);
      case "tools/call":
        if (!context.bearer) {
          return {
            status: 401,
            body: rpcError(
              id,
              -32001,
              "Missing Authorization Bearer token. Use your MCP API key.",
            ),
          };
        }
        return ok(id, await handleToolCall(request.params, context), isNotification);
      default:
        return {
          status: 200,
          body: rpcError(id, -32601, `Method not found: ${request.method}`),
        };
    }
  } catch (error) {
    if (error instanceof AppError) {
      const rpcCode = error.code === "invalid_arguments" || error.code === "tool_not_found" ? -32602 : -32603;
      return {
        status: 200,
        body: rpcError(id, rpcCode, error.message, {
          code: error.code,
          status: error.status,
        }),
      };
    }
    logEvent("error", "mcp_internal_error", { method: request.method });
    return {
      status: 200,
      body: rpcError(id, -32603, "Internal error."),
    };
  }
}

interface ListMount {
  upstream: string;
  list: (input: MountInput) => Promise<UpstreamTool[] | null>;
}

/** Mount order is local tools, then TransMonkey, then MarkAny. */
async function listTools(context: ToolContext): Promise<unknown[]> {
  const mounts: ListMount[] = [];
  const transmonkey = transmonkeyConfigured(context.env);
  if (transmonkey) mounts.push({ upstream: transmonkey, list: listUpstreamTools });
  const markany = markanyConfigured(context.env);
  if (markany) mounts.push({ upstream: markany, list: listMarkAnyTools });

  if (mounts.length === 0) return TOOLS;

  // Each mount fails open independently; run them concurrently so two slow
  // upstreams do not double the tools/list latency.
  const inputs: MountInput[] = mounts.map((mount) => ({
    upstream: mount.upstream,
    env: context.env,
    deps: context.deps,
    bearer: context.bearer,
  }));
  const results = await Promise.all(mounts.map((mount, index) => mount.list(inputs[index])));

  const merged: unknown[] = [...TOOLS];
  const seen = new Set<string>(LOCAL_TOOL_NAMES);
  for (const tools of results) {
    if (!tools) continue;
    for (const tool of tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      merged.push(tool);
    }
  }
  return merged;
}

function initializeResult(params: unknown): Record<string, unknown> {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  const protocolVersion =
    typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "Document to Markdown, OCR & Tables (MinerU)",
    },
    instructions: INSTRUCTIONS,
  };
}

async function handleToolCall(params: unknown, context: ToolContext): Promise<Record<string, unknown>> {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new AppError(400, "invalid_arguments", "tools/call requires params.name.");
  }
  const name = params.name;
  const args = params.arguments ?? {};

  // Fixed-name routing keeps calls deterministic even when tools/list failed.
  // MarkAny names win first, then any remaining non-local name goes to
  // TransMonkey (which also accepts dynamic names returned by its tools/list).
  const markany = markanyConfigured(context.env);
  if (markany && MARKANY_TOOL_NAMES.has(name)) {
    return handleMountedToolCall(
      name,
      args,
      {
        label: MARKANY_LABEL,
        upstream: markany,
        cost: markanyToolCost(name),
        call: callMarkAnyTool,
      },
      context,
    );
  }

  const transmonkey = transmonkeyConfigured(context.env);
  if (transmonkey && !LOCAL_TOOL_NAMES.has(name)) {
    return handleMountedToolCall(
      name,
      args,
      {
        label: TRANSMONKEY_LABEL,
        upstream: transmonkey,
        cost: upstreamToolCost(name),
        call: callUpstreamTool,
      },
      context,
    );
  }

  try {
    const result = await callTool(name, args, context);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.structured, null, 2),
        },
      ],
      structuredContent: result.structured,
      isError: false,
    };
  } catch (error) {
    if (error instanceof AppError) {
      const charged = error.charged;
      const suffix = charged
        ? " The call was charged before the upstream job; no automatic refund is issued."
        : " No MinerU job was created by this failed call.";
      const structured = {
        error: {
          code: error.code,
          status: error.status,
          message: error.message,
          charged,
          job_id: error.jobId ?? null,
          task_id: error.taskId ?? null,
        },
      };
      logEvent("warn", "tool_error", {
        tool: name,
        code: error.code,
        status: error.status,
        charged,
        job_id: error.jobId ?? null,
      });
      return {
        content: [{ type: "text", text: `${error.message}${suffix}` }],
        structuredContent: structured,
        isError: true,
      };
    }
    logEvent("error", "tool_internal_error", { tool: name });
    return {
      content: [{ type: "text", text: "Internal error while running the tool." }],
      structuredContent: { error: { code: "internal_error", message: "Internal error." } },
      isError: true,
    };
  }
}

interface MountedRoute {
  label: string;
  upstream: string;
  cost: number;
  call: (
    name: string,
    args: Record<string, unknown>,
    input: MountCallInput,
  ) => Promise<Record<string, unknown>>;
}

async function handleMountedToolCall(
  name: string,
  args: unknown,
  route: MountedRoute,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  const jobId = context.deps.randomId();

  let charge;
  try {
    charge = await context.charge({ cost: route.cost, tool: name, ref: jobId });
  } catch (error) {
    if (error instanceof AppError) {
      logEvent("warn", "upstream_charge_error", {
        upstream: route.label,
        tool: name,
        code: error.code,
        status: error.status,
        job_id: jobId,
      });
      return {
        content: [
          {
            type: "text",
            text: `${error.message} No upstream tool call was made.`,
          },
        ],
        structuredContent: {
          error: {
            code: error.code,
            status: error.status,
            message: error.message,
            charged: false,
            job_id: jobId,
            charge_id: null,
          },
        },
        isError: true,
      };
    }
    logEvent("error", "upstream_charge_internal_error", {
      upstream: route.label,
      tool: name,
      job_id: jobId,
    });
    return {
      content: [{ type: "text", text: "Internal error while charging the tool call." }],
      structuredContent: { error: { code: "internal_error", message: "Internal error.", charged: false } },
      isError: true,
    };
  }

  const result = await route.call(name, isRecord(args) ? args : {}, {
    upstream: route.upstream,
    env: context.env,
    deps: context.deps,
    bearer: context.bearer,
    jobId,
    chargeId: charge.chargeId,
    balanceAfter: charge.balanceAfter,
  });

  logEvent("info", "upstream_tool_call", {
    upstream: route.label,
    tool: name,
    job_id: jobId,
    charge_id: charge.chargeId,
    is_error: result.isError === true,
  });
  return result;
}

function ok(id: JsonRpcId, result: unknown, isNotification: boolean): McpResponse {
  if (isNotification) return { status: 202, body: null };
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message: sanitizeUpstreamMessage(message, "Request failed.") };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}
