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

export class ChargeError extends ToolError {
  readonly status?: number;

  constructor(message: string, status?: number, code = "charge_failed", details?: unknown) {
    super(message, code, details);
    this.name = "ChargeError";
    this.status = status;
  }
}

export class UpstreamError extends ToolError {
  readonly status?: number;

  constructor(message: string, status?: number, code = "upstream_error", details?: unknown) {
    super(message, code, details);
    this.name = "UpstreamError";
    this.status = status;
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

/** Add charge metadata to an error raised after the charge already succeeded. */
export function withChargeContext(error: unknown, chargeId: string): ToolError {
  const message = errorMessage(error);
  return new ToolError(
    `${message} The credit charge already succeeded (charge_id=${chargeId}); ` +
      "there is no automatic refund API. Contact support with this charge_id.",
    "tool_failed_after_charge",
    { charge_id: chargeId },
  );
}
