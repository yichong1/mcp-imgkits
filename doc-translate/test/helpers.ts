import { vi } from "vitest";
import type { Env } from "../src/env";
import type { ToolContext } from "../src/env";

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
  UPSTREAM_ATTACH_AUTH: "1",
  ALLOW_DIRECT_MCP: "1",
  API_BASE_URL: "https://api.test",
  MINERU_BASE_PATH: "/api/mineru",
  TRANSLATE_TEXT_PATH: "/translate/text",
  UPSTREAM_TIMEOUT_MS: "5000",
  JOB_POLL_INTERVAL_MS: "50",
  COST_PDF_TO_MARKDOWN_THEN_TRANSLATE: "2",
};

export const testCtx: ToolContext = {
  env: testEnv,
  authToken: "sk_live_test_0123456789abcdef",
  chargeId: "ch_test_gateway",
  accessChannel: "mcp-gateway",
};

export function headerOf(init: RequestInit, name: string): string | null {
  const headers = new Headers(init.headers);
  return headers.get(name);
}
