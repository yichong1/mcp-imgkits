import type { RuntimeDeps } from "./deps";
import { AppError, isRecord, logEvent, sanitizeUpstreamMessage } from "./http";

export const UPSTREAM_LIST_TIMEOUT_MS = 8_000;
export const UPSTREAM_CALL_TIMEOUT_MS = 120_000;

export interface UpstreamTool {
  name: string;
  [key: string]: unknown;
}

/** Per-mount transport config. Shared by every mounted MCP upstream. */
export interface UpstreamMount {
  /** Human-readable name used in errors and logs, e.g. "TransMonkey". */
  label: string;
  /** Service binding name used in the CF 1042 hint, e.g. "TRANSMONKEY_MCP". */
  bindingName: string;
  /** Optional service binding; preferred over public workers.dev fetch. */
  binding?: Fetcher;
  /** Host fallback when no upstream base URL is configured. */
  fallbackHost: string;
  /** Upstream base URL (no trailing slash, no /mcp suffix). */
  upstream: string;
}

export interface MountInput {
  upstream: string;
  env: Env;
  deps: RuntimeDeps;
  bearer?: string;
}

export interface UpstreamContext {
  mount: UpstreamMount;
  env: Env;
  deps: RuntimeDeps;
  bearer?: string;
}

export interface UpstreamCallOptions extends UpstreamContext {
  jobId: string;
  chargeId: string | null;
  balanceAfter: number | null;
}

export type MountCallInput = MountInput & {
  jobId: string;
  chargeId: string | null;
  balanceAfter: number | null;
};

function baseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function headersOf(
  context: UpstreamContext,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": "mcp-credit-gateway/0.1 (+worker)",
    "X-Access-Channel": "mcp-gateway",
    ...extra,
  };
  const secret = (context.env.GATEWAY_SHARED_SECRET ?? "").trim();
  if (secret) headers["X-Gateway-Shared-Secret"] = secret;
  return headers;
}

async function postRpc(
  context: UpstreamContext,
  payload: Record<string, unknown>,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const base = baseUrl(context.mount.upstream);
  const binding = context.mount.binding;
  if (!base && !binding) {
    throw new AppError(503, "upstream_not_configured", "Upstream MCP server is not configured.");
  }
  const requestUrl = `${base || `https://${context.mount.fallbackHost}`}/mcp`;
  const init: RequestInit = {
    method: "POST",
    headers: headersOf(context, extraHeaders),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  };
  // Prefer service binding: public *.workers.dev subrequests return CF 1042.
  if (binding) {
    const headers = new Headers(init.headers);
    // Upstream Worker validates Host; service-binding fetch may omit it.
    if (!headers.has("Host")) {
      try {
        headers.set("Host", new URL(requestUrl).host);
      } catch {
        headers.set("Host", context.mount.fallbackHost);
      }
    }
    return binding.fetch(new Request(requestUrl, { ...init, headers }));
  }
  if (base.includes(".workers.dev")) {
    throw new AppError(
      503,
      "upstream_workers_dev_blocked",
      `Upstream is on workers.dev; configure ${context.mount.bindingName} service binding (CF error 1042).`,
    );
  }
  return context.deps.fetchImpl(requestUrl, init);
}

function parseSsePayloads(text: string): unknown[] {
  const payloads: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(data) as unknown);
    } catch {
      // Ignore malformed SSE data events; a later event may still be valid.
    }
  }
  return payloads;
}

function selectRpcMessage(messages: unknown[]): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && ("result" in message || "error" in message)) return message;
  }
  return messages[messages.length - 1] ?? null;
}

/** Upstream may answer with plain JSON or an SSE `data:` stream. Accept both. */
export function parseRpcResponse(response: Response, text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const looksLikeSse =
    contentType.includes("text/event-stream") || /(^|\n)(event|data):/.test(trimmed);
  if (looksLikeSse) {
    const messages = parseSsePayloads(text);
    if (messages.length > 0) return selectRpcMessage(messages);
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const messages = parseSsePayloads(text);
    if (messages.length > 0) return selectRpcMessage(messages);
    throw new Error("Upstream returned invalid JSON.");
  }
}

async function readRpcResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  return parseRpcResponse(response, text);
}

function toolsFromPayload(payload: unknown): UpstreamTool[] | null {
  if (!isRecord(payload)) return null;
  const result = isRecord(payload.result) ? payload.result : payload;
  if (!Array.isArray(result.tools)) return null;

  return result.tools.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name.trim()) return [];
    return [{ ...tool, name: tool.name.trim() }];
  });
}

/** Fail-open list: returns null on any error/timeout so one mount cannot break /mcp. */
export async function listMountedTools(context: UpstreamContext): Promise<UpstreamTool[] | null> {
  const extraHeaders: Record<string, string> = {};
  const bearer = (context.bearer ?? "").trim();
  if (bearer) extraHeaders.Authorization = `Bearer ${bearer}`;

  try {
    const response = await postRpc(
      context,
      { jsonrpc: "2.0", id: "gateway-tools-list", method: "tools/list" },
      UPSTREAM_LIST_TIMEOUT_MS,
      extraHeaders,
    );
    if (!response.ok) {
      logEvent("warn", "upstream_list_failed", {
        upstream: context.mount.label,
        status: response.status,
        request_url: `${baseUrl(context.mount.upstream)}/mcp`,
        response_url: response.url,
      });
      return null;
    }
    const tools = toolsFromPayload(await readRpcResponse(response));
    if (!tools) {
      logEvent("warn", "upstream_list_invalid_response", { upstream: context.mount.label });
      return null;
    }
    return tools;
  } catch {
    logEvent("warn", "upstream_list_unavailable", { upstream: context.mount.label });
    return null;
  }
}

function upstreamErrorResult(
  message: string,
  code: string,
  options: UpstreamCallOptions,
): Record<string, unknown> {
  const structured: Record<string, unknown> = {
    error: {
      code,
      message,
      charged: true,
      job_id: options.jobId,
      charge_id: options.chargeId,
    },
    charged: true,
    charge_id: options.chargeId,
    job_id: options.jobId,
  };
  if (options.balanceAfter !== null) structured.balance_after = options.balanceAfter;

  return {
    content: [
      {
        type: "text",
        text: `${message} The call was charged before the upstream request; no automatic refund is issued.`,
      },
    ],
    structuredContent: structured,
    isError: true,
  };
}

function normalizeUpstreamResult(
  result: Record<string, unknown>,
  options: UpstreamCallOptions,
): Record<string, unknown> {
  const upstreamStructured = isRecord(result.structuredContent) ? result.structuredContent : {};
  const structuredContent: Record<string, unknown> = {
    ...upstreamStructured,
    job_id: options.jobId,
    charged: true,
    charge_id: options.chargeId,
  };
  if (options.balanceAfter !== null) structuredContent.balance_after = options.balanceAfter;

  return {
    ...result,
    content: Array.isArray(result.content)
      ? result.content
      : [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: result.isError === true,
  };
}

export async function callMountedTool(
  name: string,
  args: Record<string, unknown>,
  options: UpstreamCallOptions,
): Promise<Record<string, unknown>> {
  const label = options.mount.label;
  const extraHeaders: Record<string, string> = {
    Authorization: `Bearer ${options.bearer ?? ""}`,
  };
  if (options.chargeId) extraHeaders["X-Mcp-Charge-Id"] = options.chargeId;

  let response: Response;
  try {
    response = await postRpc(
      options,
      {
        jsonrpc: "2.0",
        id: options.jobId,
        method: "tools/call",
        params: { name, arguments: args },
      },
      UPSTREAM_CALL_TIMEOUT_MS,
      extraHeaders,
    );
  } catch {
    logEvent("warn", "upstream_call_unavailable", {
      upstream: label,
      tool: name,
      job_id: options.jobId,
    });
    return upstreamErrorResult(
      `${label} upstream request failed or timed out.`,
      "upstream_unavailable",
      options,
    );
  }

  let payload: unknown;
  try {
    payload = await readRpcResponse(response);
  } catch {
    logEvent("warn", "upstream_call_invalid_response", {
      upstream: label,
      tool: name,
      status: response.status,
    });
    return upstreamErrorResult(
      `${label} upstream returned an invalid response.`,
      "upstream_invalid_response",
      options,
    );
  }

  if (isRecord(payload) && isRecord(payload.error)) {
    const detail = sanitizeUpstreamMessage(
      payload.error.message,
      `${label} tool call failed.`,
    );
    logEvent("warn", "upstream_call_rpc_error", {
      upstream: label,
      tool: name,
      job_id: options.jobId,
      code: typeof payload.error.code === "number" ? payload.error.code : null,
    });
    return upstreamErrorResult(
      `${label} tool call failed: ${detail}`,
      "upstream_rpc_error",
      options,
    );
  }

  if (!response.ok) {
    logEvent("warn", "upstream_call_http_error", {
      upstream: label,
      tool: name,
      status: response.status,
    });
    return upstreamErrorResult(
      `${label} upstream returned HTTP ${response.status}.`,
      "upstream_http_error",
      options,
    );
  }

  if (!isRecord(payload) || !isRecord(payload.result)) {
    logEvent("warn", "upstream_call_missing_result", {
      upstream: label,
      tool: name,
      status: response.status,
    });
    return upstreamErrorResult(
      `${label} upstream returned no tool result.`,
      "upstream_invalid_response",
      options,
    );
  }

  logEvent("info", "upstream_tool_ok", {
    upstream: label,
    tool: name,
    job_id: options.jobId,
  });
  return normalizeUpstreamResult(payload.result, options);
}
