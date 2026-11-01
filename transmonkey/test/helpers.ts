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

export function mockFetch(handler: FetchHandler): { calls: FetchCall[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init: init ?? {}, body });
    return handler(url, init ?? {}, body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export const testEnv: Env = {
  UPSTREAM_API_TOKEN: "test-upstream-token",
  ALLOW_DIRECT_MCP: "1",
  TRANSLATE_TEXT_BASE_URL: "https://text.test",
  DOC_TRANSLATE_BASE_URL: "https://doc.test",
  IMAGE_TRANSLATE_BASE_URL: "https://image.test",
  UPSTREAM_TIMEOUT_MS: "5000",
  JOB_POLL_INTERVAL_MS: "200",
  COST_TRANSLATE_TEXT: "1",
  COST_TRANSLATE_DOCUMENT: "5",
  COST_TRANSLATE_IMAGE: "2",
  COST_TRANSLATE_SUBTITLE: "3",
  COST_DETECT_LANGUAGE: "0",
};

export const testCtx = {
  env: testEnv,
  authToken: "sk_live_test_0123456789abcdef",
};

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
