import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { VISIBLE_TOOLS } from "../src/config";
import { testEnv } from "./helpers";

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const VALID_KEY = "Bearer sk_live_test_0123456789abcdef";

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "vitest", version: "1" },
};

const TOOL_CALL_PARAMS = {
  name: "colorize_photo",
  arguments: {},
};

function rpcRequest(
  method: string,
  headers: Record<string, string> = {},
  params: unknown = {},
  id: number | null = 1,
): Request {
  return new Request("https://example.workers.dev/mcp", {
    method: "POST",
    headers: {
      host: "example.workers.dev",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

function toolCallRequest(headers: Record<string, string> = {}): Request {
  return rpcRequest("tools/call", headers, TOOL_CALL_PARAMS, 2);
}

function batchRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.workers.dev/mcp", {
    method: "POST",
    headers: {
      host: "example.workers.dev",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: TOOL_CALL_PARAMS },
    ]),
  });
}

describe("Worker entry", () => {
  it("serves health without secrets and hides erase_object from ready tools", async () => {
    const response = await worker.fetch(
      new Request("https://mcp-imgkits-core.example.workers.dev/health"),
      testEnv,
      executionCtx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.service).toBe("mcp-imgkits-core");
    expect(body.mcp_endpoint).toBe("/mcp");
    expect(body.upstream_auth).toBe("none");
    expect(body.billing).toBe("gateway-only");
    expect(body.direct_mcp_allowed).toBe(true);
    expect(body.workers_dev_only).toBe(true);
    expect(body.privacy).toBe("https://mcp.imgkits.com");
    expect((body.gateway as Record<string, unknown>).required_channel).toBe("mcp-gateway");
    expect((body.gateway as Record<string, unknown>).service_binding).toBe("IMGKITS_CORE_MCP");
    expect((body.gateway as Record<string, unknown>).upstream_var).toBe("MCP_IMGKITS_CORE_UPSTREAM");

    const tools = body.tools as Record<string, { cost: number; type: string }>;
    expect(Object.keys(tools).sort()).toEqual([...VISIBLE_TOOLS].sort());
    expect(tools.colorize_photo).toEqual({ cost: 2, type: "sync" });
    expect(tools.upscale_image).toEqual({ cost: 2, type: "sync" });
    expect(tools.erase_object).toBeUndefined();
    expect(body.hidden_tools).toEqual(["erase_object"]);
    expect((body.compress as Record<string, unknown>).mode).toBe("worker");
    expect(JSON.stringify(body.tools)).not.toContain("erase_object");
  });

  it("does not expose /api/mcp", async () => {
    const response = await worker.fetch(new Request("https://example.workers.dev/api/mcp"), testEnv, executionCtx);
    expect(response.status).toBe(404);
  });

  it("rejects an empty /mcp POST without a Bearer key", async () => {
    const response = await worker.fetch(
      new Request("https://example.workers.dev/mcp", { method: "POST" }),
      testEnv,
      executionCtx,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a non-sk_live key on tools/call", async () => {
    const response = await worker.fetch(
      toolCallRequest({ authorization: "Bearer sk_test_123" }),
      testEnv,
      executionCtx,
    );
    expect(response.status).toBe(401);
  });

  it("serves initialize without auth even when direct access is disabled", async () => {
    const env = { ...testEnv, ALLOW_DIRECT_MCP: "0", GATEWAY_SHARED_SECRET: "test-gateway-secret" };
    const response = await worker.fetch(rpcRequest("initialize", {}, INITIALIZE_PARAMS), env, executionCtx);
    expect(response.status).toBe(200);
  });

  it("serves tools/list and ping without auth", async () => {
    const list = await worker.fetch(rpcRequest("tools/list"), testEnv, executionCtx);
    expect(list.status).toBe(200);
    const ping = await worker.fetch(rpcRequest("ping"), testEnv, executionCtx);
    expect(ping.status).toBe(200);
  });

  it("rejects tools/call without a Bearer key", async () => {
    const response = await worker.fetch(toolCallRequest(), testEnv, executionCtx);
    expect(response.status).toBe(401);
  });

  it("accepts the gateway channel when direct MCP is disabled", async () => {
    const env = { ...testEnv, ALLOW_DIRECT_MCP: "0" };
    const response = await worker.fetch(
      toolCallRequest({ authorization: VALID_KEY, "x-access-channel": "mcp-gateway" }),
      env,
      executionCtx,
    );
    expect(response.status).toBe(200);
  });

  it("rejects direct workers.dev tools/call when ALLOW_DIRECT_MCP is not 1", async () => {
    const env = { ...testEnv, ALLOW_DIRECT_MCP: "0" };
    const response = await worker.fetch(toolCallRequest({ authorization: VALID_KEY }), env, executionCtx);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/mcp\.imgkits\.com\/mcp/);
    expect(body.error.message).toMatch(/ALLOW_DIRECT_MCP=1/);
  });

  it("allows direct workers.dev self-test when ALLOW_DIRECT_MCP=1", async () => {
    const response = await worker.fetch(toolCallRequest({ authorization: VALID_KEY }), testEnv, executionCtx);
    expect(response.status).toBe(200);
  });

  it("enforces X-Gateway-Shared-Secret only when configured", async () => {
    const env = { ...testEnv, GATEWAY_SHARED_SECRET: "test-gateway-secret" };
    const missing = await worker.fetch(
      toolCallRequest({ authorization: VALID_KEY, "x-access-channel": "mcp-gateway" }),
      env,
      executionCtx,
    );
    expect(missing.status).toBe(401);

    const correct = await worker.fetch(
      toolCallRequest({
        authorization: VALID_KEY,
        "x-access-channel": "mcp-gateway",
        "x-gateway-shared-secret": "test-gateway-secret",
      }),
      env,
      executionCtx,
    );
    expect(correct.status).toBe(200);
  });

  it("requires auth for a batch that mixes tools/list with tools/call", async () => {
    const anonymous = await worker.fetch(batchRequest(), testEnv, executionCtx);
    expect(anonymous.status).toBe(401);
    const authenticated = await worker.fetch(
      batchRequest({ authorization: VALID_KEY, "x-access-channel": "mcp-gateway" }),
      testEnv,
      executionCtx,
    );
    expect(authenticated.status).toBe(200);
  });

  it("answers CORS preflight and returns 404 for unknown paths", async () => {
    const response = await worker.fetch(
      new Request("https://example.workers.dev/mcp", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:6274",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, x-access-channel, x-mcp-charge-id",
        },
      }),
      testEnv,
      executionCtx,
    );
    expect(response.status).toBe(200);
    const allowHeaders = response.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
    expect(allowHeaders).toContain("x-access-channel");
    expect(allowHeaders).toContain("x-mcp-charge-id");

    const missing = await worker.fetch(new Request("https://example.workers.dev/nope"), testEnv, executionCtx);
    expect(missing.status).toBe(404);
  });
});
