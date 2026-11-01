import { chargeCredits } from "./charge";
import { defaultDeps, type RuntimeDeps } from "./deps";
import { AppError, bearerToken, corsHeaders, json, logEvent, readJsonBody } from "./http";
import { handleMcpBody } from "./mcp";

const MAX_MCP_BODY_BYTES = 1_048_576;

/**
 * Stateless MCP Streamable HTTP transport. `initialize`, `tools/list`, and
 * `ping` are public; `tools/call` requires the caller's `sk_live_...` Bearer and
 * is charged through the existing UserLock path before any MinerU call.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  deps: RuntimeDeps = defaultDeps(),
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (request.method !== "POST") {
    const headers = corsHeaders(request);
    headers.set("allow", "POST, OPTIONS");
    return json(
      { error: { code: "method_not_allowed", message: "Use POST /mcp for MCP Streamable HTTP." } },
      405,
      headers,
    );
  }

  const token = bearerToken(request);

  let body: unknown;
  try {
    body = await readJsonBody(request, MAX_MCP_BODY_BYTES);
  } catch (error) {
    if (error instanceof AppError) {
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } },
        error.status,
        corsHeaders(request),
      );
    }
    throw error;
  }

  try {
    const response = await handleMcpBody(body, {
      env,
      bearer: token ?? "",
      deps,
      charge: (input) => chargeCredits(env, { bearer: token ?? "", ...input }),
    });
    const headers = corsHeaders(request);
    if (response.status === 401) headers.set("www-authenticate", "Bearer");
    if (response.body === null) return new Response(null, { status: response.status, headers });
    return json(response.body, response.status, headers);
  } catch (error) {
    if (error instanceof AppError) {
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32603, message: error.message } },
        error.status,
        corsHeaders(request),
      );
    }
    logEvent("error", "unhandled_mcp_error", {});
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error." } },
      500,
      corsHeaders(request),
    );
  }
}
