import type { CallToolResult } from "@modelcontextprotocol/server";

/** An error that is safe and useful to return to an MCP caller. */
export class ToolError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly status?: number;

  constructor(message: string, code = "tool_error", details?: unknown, status?: number) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export class ChargeError extends ToolError {
  constructor(message: string, status?: number, code = "charge_failed", details?: unknown) {
    super(message, code, details, status);
    this.name = "ChargeError";
  }
}

export class UpstreamError extends ToolError {
  constructor(message: string, status?: number, code = "upstream_error", details?: unknown) {
    super(message, code, details, status);
    this.name = "UpstreamError";
  }
}

/** HTTP statuses that must surface as stable tool codes, never as raw upstream bodies. */
const STABLE_UPSTREAM_HTTP_CODES = new Set([
  "upstream_unauthorized",
  "upstream_forbidden",
  "upstream_not_found",
  "upstream_rate_limited",
  "upstream_unavailable",
  "upstream_http_error",
]);

/**
 * Map an upstream HTTP status onto a stable tool error.
 * The message is fixed and does not include the response body, so Authorization
 * headers and tokens cannot leak through a remark or error payload.
 */
export function mapUpstreamHttpStatus(status: number, subject: string): UpstreamError {
  if (status === 401) {
    return new UpstreamError(`${subject} rejected the credentials (HTTP 401).`, 401, "upstream_unauthorized");
  }
  if (status === 403) {
    return new UpstreamError(`${subject} refused the request (HTTP 403).`, 403, "upstream_forbidden");
  }
  if (status === 404) {
    return new UpstreamError(`${subject} path was not found (HTTP 404).`, 404, "upstream_not_found");
  }
  if (status === 429) {
    return new UpstreamError(`${subject} rate limited the request (HTTP 429).`, 429, "upstream_rate_limited");
  }
  if (status >= 500 && status <= 599) {
    return new UpstreamError(`${subject} is unavailable (HTTP ${status}).`, status, "upstream_unavailable");
  }
  return new UpstreamError(`${subject} returned HTTP ${status}.`, status, "upstream_http_error");
}

/** Strip bearer tokens and caller-supplied secrets from a string that might be returned to a client. */
export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value || value.length < 4) continue;
    out = out.split(value).join("[redacted]");
  }
  return out
    .replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/authorization\s*[:=]\s*[^\s,;]+/gi, "authorization [redacted]");
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
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return { ok: false, error: { code: "internal_error", message: redactSecrets(errorMessage(error)) } };
}

/**
 * Keep stable upstream HTTP codes visible to the MCP caller after a gateway
 * charge, and still attach the charge id for reconciliation.
 */
export function rethrowWithCharge(error: unknown, chargeId: string): never {
  if (error instanceof ToolError && STABLE_UPSTREAM_HTTP_CODES.has(error.code)) {
    const prior =
      error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : {};
    throw new ToolError(
      `${error.message} The credit charge already succeeded (charge_id=${chargeId}); ` +
        "there is no automatic refund API. Contact support with this charge_id.",
      error.code,
      { ...prior, charge_id: chargeId },
      error.status,
    );
  }
  throw withChargeContext(error, chargeId);
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
