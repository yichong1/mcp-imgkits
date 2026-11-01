import { describe, expect, it } from "vitest";
import type { ChargeRequest } from "../src/mcp/charge";
import type { RuntimeDeps } from "../src/mcp/deps";
import { AppError } from "../src/mcp/http";
import { handleMcpBody, type McpResponse } from "../src/mcp/mcp";
import type { ToolContext } from "../src/mcp/tools";

const UPSTREAM = "https://mcp-transmonkey.test";
const PDF = "https://files.example.com/doc.pdf";

const ENV = {
  MCP_TRANSMONKEY_UPSTREAM: UPSTREAM,
  GATEWAY_SHARED_SECRET: "shared-secret",
  MINERU_S2S_BEARER: "test-s2s-bearer",
  MINERU_BASE_URL: "https://mineru.test/api/mineru",
  MINERU_CHANNEL: "ai",
  MCP_CHARGE_COST: "9",
} as unknown as Env;

const UPSTREAM_TOOL_NAMES = [
  "translate_text",
  "translate_document",
  "translate_image",
  "translate_subtitle",
  "detect_language",
];

const UPSTREAM_TOOLS = UPSTREAM_TOOL_NAMES.map((name) => ({
  name,
  description: `${name} via TransMonkey`,
  inputSchema: { type: "object", properties: {} },
}));

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

interface TestContext {
  context: ToolContext;
  events: string[];
  chargeRequests: ChargeRequest[];
}

function makeContext(fetchHandler: FetchHandler, chargeError?: AppError): TestContext {
  const events: string[] = [];
  const chargeRequests: ChargeRequest[] = [];
  let jobCounter = 0;

  const deps: RuntimeDeps = {
    fetchImpl: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      events.push(`fetch ${init.method ?? "GET"} ${url}`);
      return fetchHandler(url, init);
    }) as typeof fetch,
    sleep: async () => undefined,
    now: () => 0,
    randomId: () => `job_test_000${++jobCounter}`,
  };

  const context: ToolContext = {
    env: ENV,
    bearer: "sk_live_test",
    deps,
    charge: async (request) => {
      events.push(`charge ${request.tool} ${request.ref} ${request.cost}`);
      chargeRequests.push(request);
      if (chargeError) throw chargeError;
      return { chargeId: "ch_test_1", balanceAfter: 42, charged: request.cost };
    },
  };

  return { context, events, chargeRequests };
}

function bodyOf(response: McpResponse): Record<string, any> {
  return response.body as Record<string, any>;
}

async function listTools(context: ToolContext): Promise<string[]> {
  const response = await handleMcpBody({ jsonrpc: "2.0", id: 1, method: "tools/list" }, context);
  expect(response.status).toBe(200);
  return bodyOf(response).result.tools.map((tool: { name: string }) => tool.name);
}

describe("TransMonkey mount", () => {
  it("merges three local tools with five upstream tools", async () => {
    const { context, events } = makeContext((url, init) => {
      expect(url).toBe(`${UPSTREAM}/mcp`);
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("accept")).toContain("application/json");
      expect(headers.get("accept")).toContain("text/event-stream");
      expect(headers.get("x-access-channel")).toBe("mcp-gateway");
      expect(headers.get("x-gateway-shared-secret")).toBe("shared-secret");

      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({ jsonrpc: "2.0", method: "tools/list" });
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: { tools: UPSTREAM_TOOLS },
      });
    });

    await expect(listTools(context)).resolves.toEqual([
      "convert_to_markdown",
      "ocr_image",
      "extract_tables",
      ...UPSTREAM_TOOL_NAMES,
    ]);
    expect(events).toEqual([`fetch POST ${UPSTREAM}/mcp`]);
  });

  it("fails open to local tools when the upstream list is down", async () => {
    const { context } = makeContext(() => {
      throw new Error("network down");
    });

    await expect(listTools(context)).resolves.toEqual([
      "convert_to_markdown",
      "ocr_image",
      "extract_tables",
    ]);
  });

  it("unwraps an SSE tools/list response", async () => {
    const { context } = makeContext((_url, init) => {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: { tools: UPSTREAM_TOOLS },
      });
      return new Response(`event: message\ndata: ${message}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });

    await expect(listTools(context)).resolves.toEqual([
      "convert_to_markdown",
      "ocr_image",
      "extract_tables",
      ...UPSTREAM_TOOL_NAMES,
    ]);
  });

  it("charges then forwards translate_text upstream", async () => {
    const args = { text: "hello", target_language: "zh" };
    const { context, events, chargeRequests } = makeContext((url, init) => {
      expect(url).toBe(`${UPSTREAM}/mcp`);
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer sk_live_test");
      expect(headers.get("x-access-channel")).toBe("mcp-gateway");
      expect(headers.get("x-mcp-charge-id")).toBe("ch_test_1");
      expect(headers.get("x-gateway-shared-secret")).toBe("shared-secret");

      const payload = JSON.parse(String(init.body)) as Record<string, any>;
      expect(payload.method).toBe("tools/call");
      expect(payload.params).toEqual({ name: "translate_text", arguments: args });
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [{ type: "text", text: "你好" }],
          structuredContent: { translation: "你好" },
          isError: false,
        },
      });
    });

    const response = await handleMcpBody(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "translate_text", arguments: args },
      },
      context,
    );

    expect(events).toEqual([
      "charge translate_text job_test_0001 1",
      `fetch POST ${UPSTREAM}/mcp`,
    ]);
    expect(chargeRequests[0]).toMatchObject({
      cost: 1,
      tool: "translate_text",
      ref: "job_test_0001",
    });
    expect(bodyOf(response).result).toMatchObject({
      content: [{ type: "text", text: "你好" }],
      structuredContent: {
        translation: "你好",
        job_id: "job_test_0001",
        charged: true,
        charge_id: "ch_test_1",
        balance_after: 42,
      },
      isError: false,
    });
  });

  it("uses the fixed upstream cost mapping instead of MCP_CHARGE_COST", async () => {
    const { context, chargeRequests } = makeContext((_url, init) => {
      const payload = JSON.parse(String(init.body)) as Record<string, any>;
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: { content: [{ type: "text", text: "ok" }], isError: false },
      });
    });

    await handleMcpBody(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "translate_document", arguments: { file_url: PDF } },
      },
      context,
    );

    expect(chargeRequests[0]).toMatchObject({ cost: 5, tool: "translate_document" });
  });

  it("unwraps an SSE tools/call response", async () => {
    const { context } = makeContext((_url, init) => {
      const payload = JSON.parse(String(init.body)) as Record<string, any>;
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [{ type: "text", text: "SSE result" }],
          structuredContent: { text: "SSE result" },
          isError: false,
        },
      });
      return new Response(`event: message\ndata: ${message}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const response = await handleMcpBody(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "detect_language", arguments: { text: "bonjour" } },
      },
      context,
    );

    expect(bodyOf(response).result).toMatchObject({
      content: [{ type: "text", text: "SSE result" }],
      structuredContent: { text: "SSE result", charged: true, charge_id: "ch_test_1" },
      isError: false,
    });
  });

  it("maps an upstream JSON-RPC error after charge to isError with charge metadata", async () => {
    const { context } = makeContext((_url, init) => {
      const payload = JSON.parse(String(init.body)) as Record<string, any>;
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        error: { code: -32000, message: "upstream exploded at https://secret.test/x" },
      });
    });

    const response = await handleMcpBody(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "translate_text", arguments: { text: "hi" } },
      },
      context,
    );

    expect(bodyOf(response).result).toMatchObject({
      isError: true,
      structuredContent: {
        charged: true,
        charge_id: "ch_test_1",
        job_id: "job_test_0001",
      },
    });
    expect(bodyOf(response).result.content[0].text).toContain("[upstream]");
  });

  it("does not charge when the upstream is unknown and the env is not configured", async () => {
    const { context, events } = makeContext(() => {
      throw new Error("should not fetch");
    });
    const envWithoutUpstream = { ...ENV, MCP_TRANSMONKEY_UPSTREAM: undefined } as unknown as Env;
    const response = await handleMcpBody(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "translate_text", arguments: { text: "hi" } },
      },
      { ...context, env: envWithoutUpstream },
    );

    expect(bodyOf(response).result).toMatchObject({ isError: true });
    expect(events).toEqual([]);
  });
});

describe("local tools stay local when the mount is configured", () => {
  it("routes convert_to_markdown through MinerU and never calls the upstream", async () => {
    const { context, events, chargeRequests } = makeContext((url, init) => {
      if (init.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": "1024" },
        });
      }
      if (url.endsWith("/create")) {
        return Response.json({ code: 0, data: { task_id: "task_123", backend: "pipeline" } });
      }
      if (url.includes("/result/")) {
        return Response.json({
          code: 0,
          data: {
            task_id: "task_123",
            status: 10,
            results: {
              "doc.pdf": {
                md_content: "# Hello",
                content_list: JSON.stringify([
                  { type: "text", text: "Hello", bbox: [1, 2, 3, 4], page_idx: 0 },
                ]),
              },
            },
          },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const response = await handleMcpBody(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "convert_to_markdown", arguments: { files: [PDF] } },
      },
      context,
    );

    expect(events).toEqual([
      `fetch HEAD ${PDF}`,
      "charge convert_to_markdown job_test_0001 9",
      "fetch POST https://mineru.test/api/mineru/create",
      "fetch GET https://mineru.test/api/mineru/result/task_123",
    ]);
    expect(chargeRequests[0]).toMatchObject({ tool: "convert_to_markdown", cost: 9 });
    expect(bodyOf(response).result).toMatchObject({
      isError: false,
      structuredContent: {
        tool: "convert_to_markdown",
        task_id: "task_123",
        charged: 9,
      },
    });
  });
});
