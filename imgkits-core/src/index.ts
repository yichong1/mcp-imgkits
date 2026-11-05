import { createMcpHandler } from "agents/mcp/server";
import {
  GATEWAY_ACCESS_CHANNEL,
  HIDDEN_TOOLS,
  MAX_COMPRESS_INPUT_BYTES,
  MAX_COMPRESS_OUTPUT_BYTES,
  MCP_ROUTE,
  SERVICE_NAME,
  SERVICE_VERSION,
  VISIBLE_TOOLS,
  costFor,
  directMcpAllowed,
} from "./config";
import type { Env } from "./env";
import { createImgkitsCoreServer } from "./server";

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
    { "www-authenticate": 'Bearer realm="mcp-imgkits-core"' },
  );
}

/**
 * MCP methods that are safe to expose without a caller key. `initialize`,
 * `tools/list` and `ping` let inspectors/agents discover the server; only
 * methods that execute billed or upstream work (notably `tools/call`) require
 * the gateway Bearer/channel checks. All `notifications/*` are public too.
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
  parsed: boolean;
  allPublic: boolean;
}

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
  return createMcpHandler(() => createImgkitsCoreServer({ env, ...auth }), {
    route: MCP_ROUTE,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      const tools: Record<string, { cost: number; type: "sync" }> = {};
      for (const name of VISIBLE_TOOLS) {
        tools[name] = { cost: costFor(env, name), type: "sync" };
      }
      return jsonResponse({
        ok: true,
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        mcp_endpoint: MCP_ROUTE,
        transport: "Streamable HTTP (stateless)",
        workers_dev_only: true,
        upstream_auth: "none",
        upstream_note: "Public ImgKits image upstreams. This Worker sends no Bearer token and stores no API key.",
        billing: "gateway-only",
        billing_note:
          "mcp-credit-gateway deducts credits before forwarding; this Worker never calls a charge endpoint.",
        direct_mcp_allowed: directMcpAllowed(env),
        auth_note: "initialize/tools.list/ping public; tools/call requires Bearer",
        gateway: {
          public_endpoint: "https://mcp.imgkits.com/mcp",
          required_channel: GATEWAY_ACCESS_CHANNEL,
          shared_secret_configured: Boolean(env.GATEWAY_SHARED_SECRET?.trim()),
          service_binding: "IMGKITS_CORE_MCP",
          upstream_var: "MCP_IMGKITS_CORE_UPSTREAM",
        },
        tools,
        hidden_tools: HIDDEN_TOOLS,
        compress: {
          mode: "worker",
          images_binding: Boolean(env.IMAGES),
          max_input_bytes: MAX_COMPRESS_INPUT_BYTES,
          max_output_bytes: MAX_COMPRESS_OUTPUT_BYTES,
        },
        rights_note: "Only process images you own or are authorized to edit.",
        privacy: "https://mcp.imgkits.com",
        api_keys: "https://mcp.imgkits.com",
        auth: "Authorization: Bearer sk_live_... via mcp-credit-gateway (issued on mcp.imgkits.com)",
      });
    }

    if (url.pathname !== MCP_ROUTE) {
      return jsonResponse({ ok: false, error: { code: "not_found", message: "Not found" } }, 404);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    const token = parseBearer(request.headers.get("authorization"));
    const chargeId = headerValue(request, "x-mcp-charge-id");
    const accessChannel = headerValue(request, "x-access-channel");

    if (request.method === "POST") {
      const inspection = await inspectMcpBody(request);
      if (inspection.allPublic) {
        const handler = createHandler(env, {
          authToken: token ?? "",
          ...(chargeId ? { chargeId } : {}),
          ...(accessChannel ? { accessChannel } : {}),
        });
        return handler(request, env, ctx);
      }
    }

    if (!token) {
      return unauthorized(
        "Missing Authorization header. Send `Authorization: Bearer sk_live_...` (issued by mcp-credit-gateway).",
      );
    }
    if (!token.startsWith("sk_live_")) {
      return unauthorized("Malformed API key. Expected a key beginning with `sk_live_`.");
    }

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
    return handler(request, env, ctx);
  },
};
