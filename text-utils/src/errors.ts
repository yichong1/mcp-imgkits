import type { CallToolResult } from "@modelcontextprotocol/server";

/** An error that is safe and useful to return to an MCP caller. */
export class ToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code = "tool_error", details?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof ToolError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return { ok: false, error: { code: "internal_error", message: errorMessage(error) } };
}

/** A successful MCP result: pretty JSON text plus structuredContent. */
export function toolJsonResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** A failed MCP result. The tool call stays protocol-successful, isError=true. */
export function toolErrorResult(error: unknown): CallToolResult {
  const payload = errorPayload(error);
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}
