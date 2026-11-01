export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly charged = false,
    readonly jobId?: string,
    readonly taskId?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COMMON_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  for (const [key, value] of Object.entries(COMMON_HEADERS)) headers.set(key, value);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  headers.set("access-control-allow-origin", origin ?? "*");
  headers.set("vary", "origin");
  headers.set(
    "access-control-allow-headers",
    "authorization, content-type, mcp-protocol-version, mcp-session-id, idempotency-key",
  );
  headers.set("access-control-allow-methods", "POST, GET, OPTIONS");
  headers.set("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
  headers.set("access-control-max-age", "86400");
  return headers;
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new AppError(413, "payload_too_large", "Request body is too large.");
  }
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("application/json")) {
    throw new AppError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new AppError(413, "payload_too_large", "Request body is too large.");
  }
  if (!text.trim()) {
    throw new AppError(400, "invalid_json", "Request body must be JSON.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

/**
 * Logs metadata only. Never log API keys, Authorization headers, file URLs,
 * file names, extracted text, or full upstream responses.
 */
export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  const line = JSON.stringify({ service: "mcp-credit-gateway", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function bearerToken(request: Request): string | null {
  const header = (request.headers.get("authorization") ?? "").trim();
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1] ?? "";
  if (!token || token.length > 512) return null;
  return token;
}

/** Remove URLs and IP literals from upstream error text before returning it. */
export function sanitizeUpstreamMessage(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, "[upstream]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .replace(/\b(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}\b/gi, "[ip]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return cleaned || fallback;
}
