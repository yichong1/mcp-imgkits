import { vi } from "vitest";
import type { Env } from "../src/env";

export interface FetchCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

export type FetchHandler = (url: string, init: RequestInit, body: unknown) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function imageResponse(bytes: Uint8Array, contentType = "image/jpeg", status = 200): Response {
  return new Response(bytes, {
    status,
    headers: { "content-type": contentType, "content-length": String(bytes.byteLength) },
  });
}

export function mockFetch(handler: FetchHandler): { calls: FetchCall[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown;
    if (init?.body) {
      const raw = String(init.body);
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    calls.push({ url, init: init ?? {}, body });
    return handler(url, init ?? {}, body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export const testEnv: Env = {
  ALLOW_DIRECT_MCP: "1",
  AI_BASE_URL: "https://ai.test",
  API_BASE_URL: "https://api.test",
  USA_BASE_URL: "https://usa.test",
  UPSTREAM_TIMEOUT_MS: "5000",
  COST_COLORIZE_PHOTO: "2",
  COST_UPSCALE_IMAGE: "2",
  COST_REMOVE_BACKGROUND: "2",
  COST_CARTOONIZE: "2",
  COST_EXTEND_IMAGE: "2",
  COST_RESIZE_IMAGE: "1",
  COST_COMPRESS_IMAGE: "1",
};

export const testCtx = {
  env: testEnv,
  authToken: "sk_live_test_0123456789abcdef",
  chargeId: "ch_test_123",
  accessChannel: "mcp-gateway",
};

export const SOURCE = "https://cdn.example.net/photo.jpg";

export function headerOf(call: FetchCall, name: string): string | undefined {
  const headers = call.init.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const hit = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return hit?.[1];
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? record[key] : undefined;
}

export function expectNoChargeCall(calls: FetchCall[]): void {
  for (const call of calls) {
    if (call.url.includes("/v1/charge")) {
      throw new Error(`unexpected charge request: ${call.url}`);
    }
  }
}
