import { USA_DOWNLOAD_PATH, USA_STATUS_PATH } from "./constants";

export type UsaFailureCode = "timeout" | "network" | "http" | "invalid" | "redirect" | "rejected";

export class UsaError extends Error {
  constructor(
    readonly code: UsaFailureCode,
    readonly httpStatus: number | null = null,
  ) {
    super(code);
    this.name = "UsaError";
  }
}

export type UsaBalance = {
  freeCnt: number;
  subscribed: boolean;
};

type Outcome = "success" | "failure" | "absent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function usaOutcome(body: unknown): Outcome {
  if (!isRecord(body)) return "failure";
  if ("ok" in body) {
    if (body.ok === 0 || body.ok === true || body.ok === "0") return "success";
    return "failure";
  }
  if ("success" in body) {
    if (body.success === true || body.success === 1 || body.success === "1") return "success";
    return "failure";
  }
  if ("errno" in body) {
    if (body.errno === 0 || body.errno === "0") return "success";
    return "failure";
  }
  if ("code" in body) {
    if (body.code === 0 || body.code === "0") return "success";
    return "failure";
  }
  return "absent";
}

function parseCredit(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function parseFlag(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function walk(node: unknown, depth: number, visit: (key: string, value: unknown) => void): void {
  if (depth > 8 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, visit);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    visit(key, value);
    if (value !== null && typeof value === "object") walk(value, depth + 1, visit);
  }
}

export function extractBalance(body: unknown): UsaBalance | null {
  const outcome = usaOutcome(body);
  if (outcome === "failure") return null;
  let freeCnt: number | null = null;
  let subscribed: boolean | null = null;
  walk(body, 0, (key, value) => {
    if (key === "free_cnt" && freeCnt === null) freeCnt = parseCredit(value);
    if ((key === "is_subscribed" || key === "subscribed") && subscribed === null) {
      subscribed = parseFlag(value);
    }
  });
  if (freeCnt === null || freeCnt < 0) return null;
  return { freeCnt, subscribed: subscribed ?? false };
}

export function isDebitSuccess(body: unknown): boolean {
  return usaOutcome(body) === "success";
}

export function assertUsaBaseUrl(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("usa_base_url");
  }
  const host = url.hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host.endsWith(".test");
  if (url.protocol === "https:") return base.replace(/\/+$/, "");
  if (url.protocol === "http:" && local) return base.replace(/\/+$/, "");
  throw new Error("usa_base_url");
}

async function readJsonBody(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 1_000_000) throw new UsaError("invalid", response.status);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 1_000_000) throw new UsaError("invalid", response.status);
  const text = new TextDecoder().decode(buffer).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UsaError("invalid", response.status);
  }
}

function classifyFetchError(error: unknown): UsaError {
  if (error instanceof UsaError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new UsaError("timeout");
  return new UsaError("network");
}

export class UsaClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly timeoutMs: number,
  ) {
    this.baseUrl = assertUsaBaseUrl(baseUrl);
  }

  async balance(ticket: string, channel: string): Promise<UsaBalance> {
    const body = await this.post(USA_STATUS_PATH, ticket, channel, "{}", "application/json");
    const parsed = extractBalance(body);
    if (!parsed) throw new UsaError("invalid");
    return parsed;
  }

  async debit(ticket: string, channel: string, cost: number): Promise<void> {
    const body = await this.post(
      USA_DOWNLOAD_PATH,
      ticket,
      channel,
      `cnt=${cost}`,
      "application/x-www-form-urlencoded",
    );
    const outcome = usaOutcome(body);
    if (outcome === "success") return;
    if (outcome === "failure") throw new UsaError("rejected");
    throw new UsaError("invalid");
  }

  private async post(
    path: string,
    ticket: string,
    channel: string,
    body: string,
    contentType: string,
  ): Promise<unknown> {
    if (path !== USA_STATUS_PATH && path !== USA_DOWNLOAD_PATH) {
      throw new UsaError("invalid");
    }
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "Content-Type": contentType,
          "X-Access-Ticket": ticket,
          "X-Access-Channel": channel,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw classifyFetchError(error);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new UsaError("redirect", response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new UsaError("http", response.status);
    }
    try {
      return await readJsonBody(response);
    } catch (error) {
      throw classifyFetchError(error);
    }
  }
}
