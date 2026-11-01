import {
  callMountedTool,
  listMountedTools,
  type MountCallInput,
  type MountInput,
  type UpstreamCallOptions,
  type UpstreamContext,
  type UpstreamTool,
} from "./upstream";

export {
  UPSTREAM_CALL_TIMEOUT_MS,
  UPSTREAM_LIST_TIMEOUT_MS,
  parseRpcResponse,
  type UpstreamCallOptions,
  type UpstreamContext,
  type UpstreamTool,
} from "./upstream";

export const TRANSMONKEY_LABEL = "TransMonkey";
export const TRANSMONKEY_BINDING_NAME = "TRANSMONKEY_MCP";
export const TRANSMONKEY_FALLBACK_HOST = "mcp-transmonkey.409198933.workers.dev";

/** Fixed names used for deterministic routing even if tools/list is unavailable. */
export const TRANSMONKEY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "translate_text",
  "translate_document",
  "translate_image",
  "translate_subtitle",
  "detect_language",
]);

/** Upstream tools are charged from this fixed table; MCP_CHARGE_COST is local-only. */
const UPSTREAM_COSTS: Record<string, number> = {
  translate_document: 5,
  translate_image: 5,
  translate_subtitle: 1,
  translate_text: 1,
  detect_language: 1,
};

export function upstreamToolCost(name: string): number {
  return UPSTREAM_COSTS[name] ?? 1;
}

function contextOf(input: MountInput): UpstreamContext {
  return {
    mount: {
      label: TRANSMONKEY_LABEL,
      bindingName: TRANSMONKEY_BINDING_NAME,
      binding: input.env.TRANSMONKEY_MCP,
      fallbackHost: TRANSMONKEY_FALLBACK_HOST,
      upstream: input.upstream,
    },
    env: input.env,
    deps: input.deps,
    bearer: input.bearer,
  };
}

/** Feature flag: mount when MCP_TRANSMONKEY_UPSTREAM is set. */
export function transmonkeyConfigured(env: Env): string | null {
  return env.MCP_TRANSMONKEY_UPSTREAM?.trim() || null;
}

export async function listUpstreamTools(input: MountInput): Promise<UpstreamTool[] | null> {
  return listMountedTools(contextOf(input));
}

export async function callUpstreamTool(
  name: string,
  args: Record<string, unknown>,
  input: MountCallInput,
): Promise<Record<string, unknown>> {
  const options: UpstreamCallOptions = {
    ...contextOf(input),
    jobId: input.jobId,
    chargeId: input.chargeId,
    balanceAfter: input.balanceAfter,
  };
  return callMountedTool(name, args, options);
}
