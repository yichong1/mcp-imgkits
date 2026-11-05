import { describe, expect, it } from "vitest";
import worker from "../src/index";
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

// Missing `text` makes the tool fail validation before any upstream fetch,
// which keeps these auth tests network-free while still exercising tools/call.
const TOOL_CALL_PARAMS = {
  name: "add_watermark",
  arguments: { source_url: "https://assets.imgkits.com/source.png", watermark_type: "text" },
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

function initializeRequest(headers: Record<string, string> = {}): Request {
  return rpcRequest("initialize", headers, INITIALIZE_PARAMS);
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
  it("serves an unauthenticated health endpoint without secrets", async () => {
    const response = await worker.fetch(
      new Request("https://mcp-markany.example.workers.dev/health"),
      testEnv,
      executionCtx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.service).toBe("mcp-markany");
    expect(body.mcp_endpoint).toBe("/mcp");
    expect(body.upstream_configured).toBe(true);
    expect(body.billing).toBe("gateway-only");
    expect(body.direct_mcp_allowed).toBe(true);
    expect(body.auth_note).toBe("initialize/tools.list/ping public; tools/call requires Bearer");
    expect(body.privacy).toBe("https://mcp.imgkits.com");
    expect(body.api_keys).toBe("https://mcp.imgkits.com");
    expect(String(body.copyright_policy)).toMatch(/own or are authorized/i);
    expect(body.charge_base_url).toBeUndefined();
    expect((body.gateway as Record<string, unknown>).required_channel).toBe("mcp-gateway");
    expect((body.gateway as Record<string, unknown>).shared_secret_configured).toBe(false);

    const tools = body.tools as Record<string, Record<string, unknown>>;
    expect(Object.keys(tools).sort()).toEqual([
      "add_watermark",
      "decode_blind_watermark",
      "embed_blind_watermark",
      "remove_watermark",
    ]);
    expect(tools.add_watermark).toEqual({ cost: 2, type: "sync" });
    expect(tools.remove_watermark).toEqual({
      cost: 3,
      type: "sync",
      confirm_authorization: "required",
      rate_limit: 5,
      rate_window_ms: 60_000,
    });
    expect(tools.embed_blind_watermark).toEqual({ cost: 2, type: "sync" });
    expect(tools.decode_blind_watermark).toEqual({ cost: 2, type: "async" });
    expect(JSON.stringify(body)).not.toContain("test-upstream-token");
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

  it("serves initialize without auth even when direct access is disabled and a shared secret is configured", async () => {
    const env = { ...testEnv, ALLOW_DIRECT_MCP: "0", GATEWAY_SHARED_SECRET: "test-gateway-secret" };
    const response = await worker.fetch(initializeRequest(), env, executionCtx);
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
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("accepts the gateway channel for tools/call when direct MCP is disabled", async () => {
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

  it("allows direct workers.dev self-test tools/call when ALLOW_DIRECT_MCP=1", async () => {
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

    const wrong = await worker.fetch(
      toolCallRequest({
        authorization: VALID_KEY,
        "x-access-channel": "mcp-gateway",
        "x-gateway-shared-secret": "wrong",
      }),
      env,
      executionCtx,
    );
    expect(wrong.status).toBe(401);

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

  it("answers CORS preflight for /mcp without auth and allows the gateway headers", async () => {
    const response = await worker.fetch(
      new Request("https://example.workers.dev/mcp", {
        method: "OPTIONS",
        headers: {
          host: "example.workers.dev",
          origin: "http://localhost:6274",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization, x-access-channel, x-mcp-charge-id, x-gateway-shared-secret",
        },
      }),
      testEnv,
      executionCtx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const allowHeaders = response.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("x-access-channel");
    expect(allowHeaders).toContain("x-mcp-charge-id");
    expect(allowHeaders).toContain("x-gateway-shared-secret");
  });

  it("returns 404 for unknown paths", async () => {
    const response = await worker.fetch(new Request("https://example.workers.dev/nope"), testEnv, executionCtx);
    expect(response.status).toBe(404);
  });
});
