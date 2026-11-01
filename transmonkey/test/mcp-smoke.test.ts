import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { testEnv } from "./helpers";

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function parseSse(text: string): Record<string, unknown> {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith("data: "));
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

describe("MCP smoke", () => {
  it("serves initialize and tools/list without Bearer", async () => {
    const init = await rpc(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
      1,
      false,
    );
    expect(init.status).toBe(200);
    const initBody = parseSse(await init.text());
    expect((initBody.result as Record<string, unknown>).serverInfo).toMatchObject({ name: "mcp-transmonkey" });

    const list = await rpc("tools/list", {}, 2, false);
    expect(list.status).toBe(200);
    const listBody = parseSse(await list.text());
    const tools = (listBody.result as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(5);
  });

  it("rejects tools/call without Bearer", async () => {
    const call = await rpc(
      "tools/call",
      { name: "detect_language", arguments: { text: "This should not run without auth." } },
      1,
      false,
    );
    expect(call.status).toBe(401);
    expect(call.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("initializes, lists the five required tools, and calls the free detector", async () => {
    const init = await rpc(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
      1,
    );
    expect(init.status).toBe(200);
    const initBody = parseSse(await init.text());
    expect((initBody.result as Record<string, unknown>).serverInfo).toMatchObject({ name: "mcp-transmonkey" });

    const list = await rpc("tools/list", {}, 2);
    expect(list.status).toBe(200);
    const listBody = parseSse(await list.text());
    const tools = (listBody.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "detect_language",
      "translate_document",
      "translate_image",
      "translate_subtitle",
      "translate_text",
    ]);

    const call = await rpc(
      "tools/call",
      { name: "detect_language", arguments: { text: "This is a test of the English language detector." } },
      3,
    );
    expect(call.status).toBe(200);
    const callBody = parseSse(await call.text());
    const result = callBody.result as {
      isError?: boolean;
      structuredContent: { language: string; billing: string };
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.language).toBe("en");
    expect(result.structuredContent.billing).toBe("free");
    expect(JSON.parse(result.content[0].text)).toMatchObject({ language: "en", billing: "free" });
  });
});
