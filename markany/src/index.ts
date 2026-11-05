import { createMcpHandler } from "agents/mcp/server";
import {
  GATEWAY_ACCESS_CHANNEL,
  MCP_ROUTE,
  SERVICE_NAME,
  SERVICE_VERSION,
  costFor,
  directMcpAllowed,
  removeWatermarkRateLimit,
  removeWatermarkRateWindowMs,
} from "./config";
import type { Env } from "./env";
import { createMarkAnyServer } from "./server";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-Access-Channel, X-Mcp-Charge-Id, X-Gateway-Shared-Secret",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id",
  "access-control-max-age": "86400",
};

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders },
  });
}

function parseBearer(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value || undefined;
}

function unauthorized(message: string): Response {
  return jsonResponse(
    { ok: false, error: { code: "unauthorized", message } },
    401,
    { "www-authenticate": 'Bearer realm="mcp-markany"' },
  );
}

/**
 * MCP methods that are safe to expose without a caller key. `initialize`,
 * `tools/list` and `ping` let inspectors/agents discover the server; only
 * methods that execute billed or upstream work (notably `tools/call`) require
 * the gateway Bearer/channel checks. All `notifications/*` are fire-and-forget
 * and therefore public too.
 */
const PUBLIC_MCP_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "tools/list",
  "ping",
]);

function isPublicMcpMethod(method: string): boolean {
  return PUBLIC_MCP_METHODS.has(method) || method.startsWith("notifications/");
}

interface McpBodyInspection {
  /** True when the body is valid JSON-RPC (single object or non-empty batch). */
  parsed: boolean;
  /** True when every method in the request is in the public set. */
  allPublic: boolean;
}

/**
 * Peek at a cloned request body to decide whether auth is required. The
 * original request is left untouched so the MCP handler can consume it.
 * Unparseable/empty bodies are treated as auth-required; a missing Bearer then
 * gets the same 401 as before. Valid bodies always reach the handler once auth
 * checks pass, letting the MCP SDK produce the protocol-level error.
 */
async function inspectMcpBody(request: Request): Promise<McpBodyInspection> {
  let text: string;
  try {
    text = await request.clone().text();
  } catch {
    return { parsed: false, allPublic: false };
  }
  if (!text.trim()) return { parsed: false, allPublic: false };

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { parsed: false, allPublic: false };
  }

  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0) return { parsed: true, allPublic: true };

  for (const item of items) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("method" in item) ||
      typeof (item as { method?: unknown }).method !== "string"
    ) {
      return { parsed: true, allPublic: false };
    }
    if (!isPublicMcpMethod((item as { method: string }).method)) {
      return { parsed: true, allPublic: false };
    }
  }
  return { parsed: true, allPublic: true };
}

export interface McpAuthContext {
  authToken: string;
  chargeId?: string;
  accessChannel?: string;
}

export function createHandler(env: Env, auth: McpAuthContext) {
  // A fresh stateless server per request keeps the caller key, gateway charge
  // id and env scoped to one request. The handler's own route check is /mcp.
  return createMcpHandler(() => createMarkAnyServer({ env, ...auth }), {
    route: MCP_ROUTE,
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return jsonResponse({
        ok: true,
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        mcp_endpoint: MCP_ROUTE,
        transport: "Streamable HTTP (stateless)",
        workers_dev_only: true,
        upstream_configured: Boolean(env.UPSTREAM_API_TOKEN?.trim()),
        billing: "gateway-only",
        billing_note:
          "mcp-credit-gateway deducts credits before forwarding; this Worker never calls a charge endpoint.",
        direct_mcp_allowed: directMcpAllowed(env),
        auth_note: "initialize/tools.list/ping public; tools/call requires Bearer",
        gateway: {
          public_endpoint: "https://mcp.imgkits.com/mcp",
          required_channel: GATEWAY_ACCESS_CHANNEL,
          shared_secret_configured: Boolean(env.GATEWAY_SHARED_SECRET?.trim()),
        },
        tools: {
          add_watermark: { cost: costFor(env, "add_watermark"), type: "sync" },
          remove_watermark: {
            cost: costFor(env, "remove_watermark"),
            type: "sync",
            confirm_authorization: "required",
            rate_limit: removeWatermarkRateLimit(env),
            rate_window_ms: removeWatermarkRateWindowMs(env),
          },
          embed_blind_watermark: { cost: costFor(env, "embed_blind_watermark"), type: "sync" },
          decode_blind_watermark: { cost: costFor(env, "decode_blind_watermark"), type: "async" },
        },
        copyright_policy:
          "Watermark removal is limited to material you own or are authorized to edit; " +
          "bulk stripping of third-party copyright watermarks is prohibited. See README.",
        privacy: "https://mcp.imgkits.com",
        api_keys: "https://mcp.imgkits.com",
        auth: "Authorization: Bearer sk_live_... via mcp-credit-gateway (issued on mcp.imgkits.com)",
      });
    }

    if (url.pathname !== MCP_ROUTE) {
      return jsonResponse({ ok: false, error: { code: "not_found", message: "Not found" } }, 404);
    }

    // Browsers send preflight before the Authorization header. Answer OPTIONS
    // locally so the custom gateway headers are advertised in CORS.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    const token = parseBearer(request.headers.get("authorization"));
    const chargeId = headerValue(request, "x-mcp-charge-id");
    const accessChannel = headerValue(request, "x-access-channel");

    // Public discovery methods (initialize / tools/list / ping /
    // notifications/*) never require a key, the gateway channel or the shared
    // secret. If a Bearer/charge id happens to be present we still forward it so
    // the MCP server sees the same caller context as authenticated calls.
    if (request.method === "POST") {
      const inspection = await inspectMcpBody(request);
      if (inspection.allPublic) {
        const handler = createHandler(env, {
          authToken: token ?? "",
          ...(chargeId ? { chargeId } : {}),
          ...(accessChannel ? { accessChannel } : {}),
        });
        return handler(request, env, _ctx);
      }
    }

    // Everything that can execute a tool, touch the upstream, or is unknown
    // stays behind the existing gateway auth (mount convention A).
    if (!token) {
      return unauthorized(
        "Missing Authorization header. Send `Authorization: Bearer sk_live_...` (issued by mcp-credit-gateway).",
      );
    }
    if (!token.startsWith("sk_live_")) {
      return unauthorized("Malformed API key. Expected a key beginning with `sk_live_`.");
    }

    // Optional additional gateway authenticity check. Only enforced when the
    // secret is configured; the value is never logged or persisted.
    const sharedSecret = env.GATEWAY_SHARED_SECRET?.trim();
    if (sharedSecret) {
      const providedSecret = request.headers.get("x-gateway-shared-secret");
      if (providedSecret !== sharedSecret) {
        return unauthorized("Missing or invalid X-Gateway-Shared-Secret.");
      }
    }

    if (accessChannel !== GATEWAY_ACCESS_CHANNEL && !directMcpAllowed(env)) {
      return unauthorized(
        "Direct MCP access is disabled. Call this server through https://mcp.imgkits.com/mcp " +
          "(mcp-credit-gateway forwards with `X-Access-Channel: mcp-gateway`). " +
          "workers.dev grey-release self-test requires ALLOW_DIRECT_MCP=1.",
      );
    }

    const handler = createHandler(env, {
      authToken: token,
      ...(chargeId ? { chargeId } : {}),
      ...(accessChannel ? { accessChannel } : {}),
    });
    return handler(request, env, _ctx);
  },
};
