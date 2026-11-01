import { describe, expect, it } from "vitest";
import { AppError } from "../src/mcp/http";
import { callTool, type ToolContext } from "../src/mcp/tools";
import type { ChargeRequest, ChargeResult } from "../src/mcp/charge";
import type { RuntimeDeps } from "../src/mcp/deps";

const MINERU_ENV = {
  MINERU_S2S_BEARER: "test-s2s-bearer",
  MINERU_BASE_URL: "https://mineru.test/api/mineru",
  MINERU_CHANNEL: "ai",
  MCP_CHARGE_COST: "1",
} as unknown as Env;

const PDF = "https://files.example.com/doc.pdf";

function fakeDeps(events: string[]): RuntimeDeps {
  return {
    fetchImpl: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      events.push(`fetch ${init.method ?? "GET"} ${url}`);
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
                md_content: "# Hello\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
                content_list: JSON.stringify([
                  { type: "text", text: "Hello", bbox: [1, 2, 3, 4], page_idx: 0 },
                ]),
              },
            },
          },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch,
    sleep: async () => undefined,
    now: () => 0,
    randomId: () => "job_test_0001",
  };
}

function context(
  events: string[],
  charge: (request: ChargeRequest) => Promise<ChargeResult>,
): ToolContext {
  return {
    env: MINERU_ENV,
    bearer: "sk_live_test",
    deps: fakeDeps(events),
    charge: async (input) => {
      events.push(`charge ${input.tool} ${input.ref}`);
      return charge(input);
    },
  };
}

describe("MCP tools charge through the gateway before MinerU", () => {
  it("charges first, then creates and polls a MinerU task", async () => {
    const events: string[] = [];
    const result = await callTool(
      "convert_to_markdown",
      { files: [PDF] },
      context(events, async (input) => ({
        chargeId: "ch_test_1",
        balanceAfter: 9,
        charged: input.cost,
      })),
    );

    expect(events).toEqual([
      `fetch HEAD ${PDF}`,
      "charge convert_to_markdown job_test_0001",
      "fetch POST https://mineru.test/api/mineru/create",
      "fetch GET https://mineru.test/api/mineru/result/task_123",
    ]);
    expect(result.structured).toMatchObject({
      job_id: "job_test_0001",
      task_id: "task_123",
      tool: "convert_to_markdown",
      charged: 1,
      balance_after: 9,
      charge_id: "ch_test_1",
      backend: "pipeline",
    });
    expect(result.structured.attribution).toContain("MinerU");
    const files = result.structured.files as Array<Record<string, unknown>>;
    expect(files[0]?.markdown).toContain("# Hello");
  });

  it("never calls MinerU when the charge is rejected", async () => {
    const events: string[] = [];
    const error = await callTool(
      "ocr_image",
      { files: [PDF] },
      context(events, async () => {
        throw new AppError(402, "insufficient_credits", "Insufficient credits.");
      }),
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "insufficient_credits", status: 402, charged: false });
    expect(events.some((event) => event.includes("/create"))).toBe(false);
  });

  it("rejects unsupported file types before charging", async () => {
    const events: string[] = [];
    await expect(
      callTool(
        "convert_to_markdown",
        { files: ["https://example.com/a.docx"] },
        context(events, async (input) => ({ chargeId: null, balanceAfter: null, charged: input.cost })),
      ),
    ).rejects.toMatchObject({ code: "unsupported_file_type" });
    expect(events).toEqual([]);
  });
});
