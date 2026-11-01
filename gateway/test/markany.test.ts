import { describe, expect, it } from "vitest";
import type { ChargeRequest } from "../src/mcp/charge";
import type { RuntimeDeps } from "../src/mcp/deps";
import { AppError } from "../src/mcp/http";
import { handleMcpBody, type McpResponse } from "../src/mcp/mcp";
import type { ToolContext } from "../src/mcp/tools";

const TRANSMONKEY = "https://mcp-transmonkey.test";
const MARKANY = "https://mcp-markany.test";
const PDF = "https://files.example.com/doc.pdf";

const ENV = {
  MCP_TRANSMONKEY_UPSTREAM: TRANSMONKEY,
  MCP_MARKANY_UPSTREAM: MARKANY,
  GATEWAY_SHARED_SECRET: "shared-secret",
  MINERU_S2S_BEARER: "test-s2s-bearer",
  MINERU_BASE_URL: "https://mineru.test/api/mineru",
  MINERU_CHANNEL: "ai",
  MCP_CHARGE_COST: "9",
} as unknown as Env;

const LOCAL_TOOL_NAMES = ["convert_to_markdown", "ocr_image", "extract_tables"];

const TRANSMONKEY_TOOL_NAMES = [
  "translate_text",
  "translate_document",
  "translate_image",
  "translate_subtitle",
  "detect_language",
];

const MARKANY_TOOL_NAMES = [
  "add_watermark",
  "remove_watermark",
  "embed_blind_watermark",
  "decode_blind_watermark",
];

const TRANSMONKEY_TOOLS = TRANSMONKEY_TOOL_NAMES.map((name) => ({
  name,
  description: `${name} via TransMonkey`,
  inputSchema: { type: "object", properties: {} },
}));

const MARKANY_TOOLS = MARKANY_TOOL_NAMES.map((name) => ({
  name,
  description: `${name} via MarkAny`,
  inputSchema: { type: "object", properties: {} },
}));

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

interface TestContext {
  context: ToolContext;
  events: string[];
  chargeRequests: ChargeRequest[];
}

function makeContext(
  fetchHandler: FetchHandler,
  env: Env = ENV,
  chargeError?: AppError,
): TestContext {
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
    env,
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

function rpcTools(payload: Record<string, any>, tools: unknown[]): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: payload.id,
    result: { tools },
  });
}

describe("MarkAny mount", () => {
  it("merges three local, five TransMonkey, and four MarkAny tools", async () => {
    const { context } = makeContext((url, init) => {
      const payload = JSON.parse(String(init.body)) as Record<string, any>;
      expect(payload).toMatchObject({ jsonrpc: "2.0", method: "tools/list" });

      if (url === `${TRANSMONKEY}/mcp`) return rpcTools(payload, TRANSMONKEY_TOOLS);
      if (url === `${MARKANY}/mcp`) {
        const headers = new Headers(init.headers);
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("accept")).toContain("text/event-stream");
        expect(headers.get("x-access-channel")).toBe("mcp-gateway");
        expect(headers.get("x-gateway-shared-secret")).toBe("shared-secret");

        // MarkAny may answer with SSE; the shared parser must unwrap it.
        const message = JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { tools: MARKANY_TOOLS },
        });
        return new Response(`event: message\ndata: ${message}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(listTools(context)).resolves.toEqual([
      ...LOCAL_TOOL_NAMES,
      ...TRANSMONKEY_TOOL_NAMES,
      ...MARKANY_TOOL_NAMES,
    ]);
  });

  it("fails open to local plus TransMonkey tools when MarkAny list is down", async () => {
    const { context } = makeContext((url, init) => {
      if (url === `${TRANSMONKEY}/mcp`) {
        return rpcTools(JSON.parse(String(init.body)) as Record<string, any>, TRANSMONKEY_TOOLS);
      }
      throw new Error("markany network down");
    });

    await expect(listTools(context)).resolves.toEqual([
      ...LOCAL_TOOL_NAMES,
      ...TRANSMONKEY_TOOL_NAMES,
    ]);
  });

  it("fails open to local tools when both upstream lists are down", async () => {
    const { context } = makeContext(() => {
      throw new Error("all upstreams down");
    });

    await expect(listTools(context)).resolves.toEqual(LOCAL_TOOL_NAMES);
  });

  it("charges exactly one credit then forwards add_watermark to MarkAny", async () => {
    const args = { file_url: PDF, text: "CONFIDENTIAL" };
    const { context, events, chargeRequests } = makeContext((url, init) => {
      expect(url).toBe(`${MARKANY}/mcp`);
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer sk_live_test");
      expect(headers.get("x-access-channel")).toBe("mcp-gateway");
      expect(headers.get("x-mcp-charge-id")).toBe("ch_test_1");
      expect(headers.get("x-gateway-shared-secret")).toBe("shared-secret");

      const payload = JSON.parse(String(init.body)) as Record<string, any>;
      expect(payload.method).toBe("tools/call");
      expect(payload.params).toEqual({ name: "add_watermark", arguments: args });
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [{ type: "text", text: "watermarked" }],
          structuredContent: { output_url: "https://files.example.com/out.pdf" },
          isError: false,
        },
      });
    });

    const response = await handleMcpBody(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "add_watermark", arguments: args },
      },
      context,
    );

    expect(events).toEqual(["charge add_watermark job_test_0001 1", `fetch POST ${MARKANY}/mcp`]);
    expect(chargeRequests[0]).toMatchObject({
      cost: 1,
      tool: "add_watermark",
      ref: "job_test_0001",
    });
    expect(bodyOf(response).result).toMatchObject({
      content: [{ type: "text", text: "watermarked" }],
      structuredContent: {
        output_url: "https://files.example.com/out.pdf",
        job_id: "job_test_0001",
        charged: true,
        charge_id: "ch_test_1",
        balance_after: 42,
      },
      isError: false,
    });
  });

  it("maps a MarkAny upstream error after charge to isError with charge metadata", async () => {
    const { context } = makeContext((url, init) => {
      expect(url).toBe(`${MARKANY}/mcp`);
      const payload = JSON.parse(String(init.body)) as Record<string, any>;
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        error: { code: -32000, message: "markany exploded at https://secret.test/x" },
      });
    });

    const response = await handleMcpBody(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "decode_blind_watermark", arguments: { file_url: PDF } },
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
});

describe("local tools stay local when both mounts are configured", () => {
  it("routes convert_to_markdown through MinerU and never calls MarkAny", async () => {
    const { context, events, chargeRequests } = makeContext((url, init) => {
      if (url === TRANSMONKEY || url === MARKANY) {
        throw new Error("local tool must not be forwarded");
      }
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
        id: 4,
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
      structuredContent: { tool: "convert_to_markdown", task_id: "task_123", charged: 9 },
    });
  });
});
