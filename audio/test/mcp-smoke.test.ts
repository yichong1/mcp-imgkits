import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { jsonResponse, testEnv } from "./helpers";

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function parseSse(text: string): Record<string, unknown> {
  const line = text.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (!line) throw new Error(`No SSE data line in response: ${text}`);
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

async function rpc(method: string, params: unknown, id: number, authenticated = true): Promise<Response> {
  return worker.fetch(
    new Request("https://example.workers.dev/mcp", {
      method: "POST",
      headers: {
        host: "example.workers.dev",
        ...(authenticated
          ? {
              authorization: "Bearer sk_live_test_0123456789abcdef",
              "x-access-channel": "mcp-gateway",
              "x-mcp-charge-id": "ch_smoke_gateway",
            }
          : {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
    testEnv,
    executionCtx,
  );
}

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "vitest", version: "1" },
};

describe("MCP smoke", () => {
  it("serves health and lists audio tools without Bearer", async () => {
    const health = await worker.fetch(
      new Request("https://example.workers.dev/health"),
      testEnv,
      executionCtx,
    );
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { service: string; tools: Record<string, unknown> };
    expect(healthBody.service).toBe("mcp-audio");
    expect(healthBody.tools).toHaveProperty("text_to_sound_effect");

    const init = await rpc("initialize", INITIALIZE_PARAMS, 1, false);
    expect(init.status).toBe(200);
    const initBody = parseSse(await init.text());
    expect((initBody.result as Record<string, unknown>).serverInfo).toMatchObject({ name: "mcp-audio" });

    const list = await rpc("tools/list", {}, 2, false);
    expect(list.status).toBe(200);
    const listBody = parseSse(await list.text());
    const tools = (listBody.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["text_to_sound_effect", "separate_stems", "transcribe_audio", "generate_subtitles", "text_to_speech", "clone_voice_tts"]);
  });

  it("rejects tools/call without Bearer", async () => {
    const call = await rpc(
      "tools/call",
      { name: "text_to_sound_effect", arguments: { prompt: "rain" } },
      1,
      false,
    );
    expect(call.status).toBe(401);
  });

  it("calls text_to_sound_effect end-to-end with stubbed upstream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/create")) {
          return jsonResponse({
            code: 0,
            data: { jobId: "job-smoke", status: 0, result: null, duration: 10, steps: 25 },
          });
        }
        return jsonResponse({
          code: 0,
          data: {
            jobId: "job-smoke",
            status: 10,
            status_str: "done",
            result: "https://cdn.example.net/tangoflux/job-smoke.wav",
            duration: 10,
            steps: 25,
          },
        });
      }),
    );

    const call = await rpc(
      "tools/call",
      { name: "text_to_sound_effect", arguments: { prompt: "gentle rain", wait_seconds: 5 } },
      3,
    );
    expect(call.status).toBe(200);
    const body = parseSse(await call.text());
    const result = body.result as {
      isError?: boolean;
      structuredContent: { ok: boolean; audio_url: string; job_id: string };
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      job_id: "job-smoke",
      audio_url: "https://cdn.example.net/tangoflux/job-smoke.wav",
    });
  });
});
