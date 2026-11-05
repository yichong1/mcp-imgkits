import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { VISIBLE_TOOLS } from "../src/config";
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
  it("serves initialize and tools/list without Bearer, and hides erase_object", async () => {
    const init = await rpc("initialize", INITIALIZE_PARAMS, 1, false);
    expect(init.status).toBe(200);
    const initBody = parseSse(await init.text());
    expect((initBody.result as Record<string, unknown>).serverInfo).toMatchObject({ name: "mcp-imgkits-core" });

    const list = await rpc("tools/list", {}, 2, false);
    expect(list.status).toBe(200);
    const listBody = parseSse(await list.text());
    const tools = (listBody.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual([...VISIBLE_TOOLS].sort());
    expect(tools).toContain("colorize_photo");
    expect(tools).toContain("upscale_image");
    expect(tools).not.toContain("erase_object");
    expect(tools).not.toContain("enhance_photo");
    expect(tools).not.toContain("enhance_face");
  });

  it("rejects tools/call without Bearer", async () => {
    const call = await rpc(
      "tools/call",
      { name: "colorize_photo", arguments: { source_url: "https://cdn.example.net/a.jpg" } },
      1,
      false,
    );
    expect(call.status).toBe(401);
  });

  it("colorize_photo and upscale_image call the public upstream shapes", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.endsWith("/api/deoldify")) {
        expect(body).toEqual({ img: "https://cdn.example.net/bw.jpg" });
        expect(init?.headers && JSON.stringify(init.headers).toLowerCase()).not.toContain("authorization");
        return jsonResponse({ url: "https://cdn.example.net/color.jpg" });
      }
      if (url.endsWith("/api/restoration")) {
        expect(body).toEqual({ img: "https://cdn.example.net/small.jpg", upscale: 4, face_enhance: true });
        return jsonResponse({ url: "https://cdn.example.net/big.jpg" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const color = await rpc(
      "tools/call",
      { name: "colorize_photo", arguments: { source_url: "https://cdn.example.net/bw.jpg" } },
      3,
    );
    expect(color.status).toBe(200);
    const colorBody = parseSse(await color.text());
    const colorResult = colorBody.result as {
      isError?: boolean;
      structuredContent: { result_url: string; charge: { charged: number; charge_id: string } };
    };
    expect(colorResult.isError).not.toBe(true);
    expect(colorResult.structuredContent.result_url).toBe("https://cdn.example.net/color.jpg");
    expect(colorResult.structuredContent.charge).toEqual({ ok: true, charged: 2, charge_id: "ch_smoke_gateway" });

    const upscale = await rpc(
      "tools/call",
      {
        name: "upscale_image",
        arguments: { source_url: "https://cdn.example.net/small.jpg", scale: 4, face_enhance: true },
      },
      4,
    );
    expect(upscale.status).toBe(200);
    const upscaleBody = parseSse(await upscale.text());
    const upscaleResult = upscaleBody.result as {
      isError?: boolean;
      structuredContent: { result_url: string; scale: number; face_enhance: boolean };
    };
    expect(upscaleResult.isError).not.toBe(true);
    expect(upscaleResult.structuredContent.result_url).toBe("https://cdn.example.net/big.jpg");
    expect(upscaleResult.structuredContent.scale).toBe(4);
    expect(upscaleResult.structuredContent.face_enhance).toBe(true);

    const erase = await rpc(
      "tools/call",
      { name: "erase_object", arguments: { source_url: "https://cdn.example.net/a.jpg" } },
      5,
    );
    expect(erase.status).toBe(200);
    const eraseBody = parseSse(await erase.text());
    const eraseResult = eraseBody.result as { isError?: boolean } | undefined;
    const failed = Boolean(eraseBody.error || eraseResult?.isError);
    expect(failed).toBe(true);
    expect(JSON.stringify(eraseBody)).not.toContain("https://cdn.example.net/result");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
