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
  UPSTREAM_ATTACH_AUTH: "1",
  ALLOW_DIRECT_MCP: "1",
  API_BASE_URL: "https://api.test",
  TANGOFLUX_CREATE_PATH: "/api/tangoflux/create",
  TANGOFLUX_RESULT_PATH: "/api/tangoflux/result",
  UPSTREAM_TIMEOUT_MS: "5000",
  JOB_POLL_INTERVAL_MS: "50",
  COST_TEXT_TO_SOUND_EFFECT: "2",
  COST_SEPARATE_STEMS: "3",
  COST_TRANSCRIBE_AUDIO: "2",
  COST_GENERATE_SUBTITLES: "2",
  COST_TEXT_TO_SPEECH: "2",
  COST_CLONE_VOICE_TTS: "3",
  SPLEETER_CREATE_PATH: "/api/spleeter/create",
  SPLEETER_RESULT_PATH: "/api/spleeter/result",
  WHISPER_CREATE_PATH: "/api/faster-whisper/create",
  WHISPER_RESULT_PATH: "/api/faster-whisper/result",
  QWEN_TTS_CREATE_PATH: "/api/qwen-tts/create",
  QWEN_TTS_RESULT_PATH: "/api/qwen-tts/result",
};

export const testCtx = {
  env: testEnv,
  authToken: "sk_live_test_0123456789abcdef",
  chargeId: "ch_test_123",
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
