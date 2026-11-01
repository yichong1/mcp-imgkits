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
  it("serves initialize and tools/list without Bearer", async () => {
    const init = await rpc("initialize", INITIALIZE_PARAMS, 1, false);
    expect(init.status).toBe(200);
    const initBody = parseSse(await init.text());
    expect((initBody.result as Record<string, unknown>).serverInfo).toMatchObject({ name: "mcp-markany" });

    const list = await rpc("tools/list", {}, 2, false);
    expect(list.status).toBe(200);
    const listBody = parseSse(await list.text());
    const tools = (listBody.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_watermark",
      "decode_blind_watermark",
      "embed_blind_watermark",
      "remove_watermark",
    ]);
  });

  it("rejects tools/call without Bearer", async () => {
    const call = await rpc(
      "tools/call",
      {
        name: "add_watermark",
        arguments: { source_url: "https://assets.imgkits.com/a.png", watermark_type: "text", text: "x" },
      },
      1,
      false,
    );
    expect(call.status).toBe(401);
    expect(call.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("returns a tool-level validation error before any upstream call", async () => {
    const call = await rpc(
      "tools/call",
      {
        name: "add_watermark",
        arguments: { source_url: "https://assets.imgkits.com/a.png", watermark_type: "text" },
      },
      2,
    );
    expect(call.status).toBe(200);
    const body = parseSse(await call.text());
    const result = body.result as {
      isError?: boolean;
      structuredContent: { ok: boolean; error: { code: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("invalid_arguments");
  });

  it("initializes, lists the four required tools, and calls add_watermark", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          success: true,
          message: "",
          data: { targetUrl: "https://cdn.imgkits.com/out.png" },
        }),
      ),
    );

    const init = await rpc("initialize", INITIALIZE_PARAMS, 1);
    expect(init.status).toBe(200);
    const initBody = parseSse(await init.text());
    expect((initBody.result as Record<string, unknown>).serverInfo).toMatchObject({ name: "mcp-markany" });

    const list = await rpc("tools/list", {}, 2);
    expect(list.status).toBe(200);
    const listBody = parseSse(await list.text());
    const tools = (listBody.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_watermark",
      "decode_blind_watermark",
      "embed_blind_watermark",
      "remove_watermark",
    ]);

    const call = await rpc(
      "tools/call",
      {
        name: "add_watermark",
        arguments: {
          source_url: "https://assets.imgkits.com/source.png",
          watermark_type: "text",
          text: "© Acme",
        },
      },
      3,
    );
    expect(call.status).toBe(200);
    const callBody = parseSse(await call.text());
    const result = callBody.result as {
      isError?: boolean;
      structuredContent: {
        result_url: string;
        watermark_type: string;
        charge: { charged: number; charge_id: string };
      };
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.result_url).toBe("https://cdn.imgkits.com/out.png");
    expect(result.structuredContent.watermark_type).toBe("text");
    expect(result.structuredContent.charge).toEqual({ ok: true, charged: 2, charge_id: "ch_smoke_gateway" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      result_url: "https://cdn.imgkits.com/out.png",
    });
  });
});
