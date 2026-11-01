import { env as bindings } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const env = bindings as unknown as Env;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://gateway.test${path}`, init);
}

const fetchWorker = worker.fetch as unknown as (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetchWorker(request(path, init), env, {} as ExecutionContext);
}

async function postMcp(body: unknown, token?: string | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return call("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("public pages", () => {
  it("serves an HTML landing page with tools, key, privacy, and MinerU attribution", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const html = await response.text();
    expect(html).toContain("convert_to_markdown");
    expect(html).toContain("ocr_image");
    expect(html).toContain("extract_tables");
    expect(html).toContain("/mcp");
    expect(html).toContain("小助理");
    expect(html).toContain("API Key");
    expect(html).toContain("https://www.imgkits.com/privacy");
    expect(html).toContain("/readme");
    expect(html).toContain("README");
    expect(html).toContain("Powered by MinerU");
    expect(html).toContain("MinerU/blob/master/LICENSE.md");
  });

  it("serves a privacy page and links back to the landing page", async () => {
    const response = await call("/privacy");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("隐私政策");
    expect(html).toContain("https://www.imgkits.com/privacy");
    expect(html).toContain("Powered by MinerU");
    expect(html).toContain('href="/"');
  });
});

describe("MCP transport", () => {
  it("serves README markdown at /readme", async () => {
    const response = await call("/readme");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const body = await response.text();
    expect(body).toContain("mcp.imgkits.com/mcp");
    expect(body).toContain("MINERU_S2S_BEARER");
  });

  it("rejects GET /mcp with 405", async () => {
    const response = await call("/mcp");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
  });

  it("initializes without requiring a key, with tools capability and MinerU attribution", async () => {
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as Record<string, any>;
    expect(payload.result.protocolVersion).toBe("2025-06-18");
    expect(payload.result.capabilities.tools).toEqual({ listChanged: false });
    expect(payload.result.serverInfo.name).toBe("mcp-doc-markdown-mcp");
    expect(payload.result.instructions).toContain("Powered by MinerU (opendatalab/MinerU)");
    expect(payload.result.instructions).toContain(
      "https://github.com/opendatalab/MinerU/blob/master/LICENSE.md",
    );
  });

  it("lists exactly the three local document tools when no upstream is configured", async () => {
    const withoutUpstream = {
      ...env,
      MCP_TRANSMONKEY_UPSTREAM: undefined,
      MCP_MARKANY_UPSTREAM: undefined,
    } as Env;
    const response = await fetchWorker(
      request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
      withoutUpstream,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as Record<string, any>;
    expect(payload.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "convert_to_markdown",
      "ocr_image",
      "extract_tables",
    ]);
    for (const tool of payload.result.tools) {
      expect(tool.description).toContain("Powered by MinerU (opendatalab/MinerU)");
      expect(tool.inputSchema).toMatchObject({ type: "object", required: ["files"] });
    }
  });

  it("answers ping and rejects unknown methods", async () => {
    const ping = await postMcp({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(ping.status).toBe(200);
    await expect(ping.json()).resolves.toMatchObject({ id: 3, result: {} });

    const unknown = await postMcp({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: -32601 } });
  });

  it("returns a parse error for invalid JSON", async () => {
    const response = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32700 } });
  });

  it("requires a Bearer for tools/call", async () => {
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "convert_to_markdown", arguments: { files: ["https://example.com/a.pdf"] } },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32001 } });
  });
});

describe("/v1 routes do not regress", () => {
  it("keeps /v1/charge authenticated and requires an idempotency key", async () => {
    const unauthenticated = await call("/v1/charge", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "job-1" },
      body: JSON.stringify({ cost: 1 }),
    });
    expect(unauthenticated.status).toBe(401);

    const missingKey = await call("/v1/charge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cost: 1 }),
    });
    expect(missingKey.status).toBe(400);
  });

  it("keeps admin mint and /v1/me working", async () => {
    const mintedResponse = await call("/v1/admin/keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": env.ADMIN_TOKEN,
      },
      body: JSON.stringify({
        usa_user_id: "user_test_1",
        from_app: "imgkit",
        ticket: "ticket_test_12345678",
        email_masked: null,
      }),
    });
    expect(mintedResponse.status).toBe(200);
    const minted = (await mintedResponse.json()) as Record<string, any>;
    expect(minted.key).toMatch(/^sk_live_[0-9a-f]{64}$/);

    const me = await call("/v1/me", {
      headers: { authorization: `Bearer ${minted.key}` },
    });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      ok: true,
      user: { app: "imgkit" },
    });
  });
});
