import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { testEnv } from "./helpers";

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

describe("mcp smoke", () => {
  it("health lists the tool", async () => {
    const res = await worker.fetch(
      new Request("https://example.workers.dev/health"),
      testEnv,
      executionCtx,
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.tools.pdf_to_markdown_then_translate.cost).toBe(2);
  });

  it("tools/list is public and includes pdf_to_markdown_then_translate", async () => {
    const res = await rpc("tools/list", {}, 1, false);
    expect(res.status).toBe(200);
    const text = await res.text();
    const payload = text.includes("data: ") ? parseSse(text) : (JSON.parse(text) as Record<string, unknown>);
    const result = (payload.result ?? payload) as { tools?: Array<{ name: string }> };
    const names = (result.tools ?? []).map((t) => t.name);
    expect(names).toContain("pdf_to_markdown_then_translate");
  });
});
