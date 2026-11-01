export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "HttpError";
  }
}

export function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

export async function readJson(request: Request, maxBytes = 8_192): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new HttpError(400, "payload_too_large");
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) throw new HttpError(400, "invalid_json");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(400, "payload_too_large");
  if (!text.trim()) throw new HttpError(400, "invalid_json");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function logEvent(level: "info" | "error" | "warn", fields: Record<string, string | number | boolean | null>): void {
  const line = JSON.stringify({ service: "mcp-credit-gateway", ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
