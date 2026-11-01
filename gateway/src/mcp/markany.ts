import {
  callMountedTool,
  listMountedTools,
  type MountCallInput,
  type MountInput,
  type UpstreamCallOptions,
  type UpstreamContext,
  type UpstreamTool,
} from "./upstream";

export const MARKANY_LABEL = "MarkAny";
export const MARKANY_BINDING_NAME = "MARKANY_MCP";
export const MARKANY_FALLBACK_HOST = "mcp-markany.409198933.workers.dev";

/** Fixed names used for deterministic routing even if tools/list is unavailable. */
export const MARKANY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "add_watermark",
  "remove_watermark",
  "embed_blind_watermark",
  "decode_blind_watermark",
]);

/** MarkAny tools are a flat 1 credit; MCP_CHARGE_COST is local-only. */
export function markanyToolCost(_name: string): number {
  return 1;
}

function contextOf(input: MountInput): UpstreamContext {
  return {
    mount: {
      label: MARKANY_LABEL,
      bindingName: MARKANY_BINDING_NAME,
      binding: input.env.MARKANY_MCP,
      fallbackHost: MARKANY_FALLBACK_HOST,
      upstream: input.upstream,
    },
    env: input.env,
    deps: input.deps,
    bearer: input.bearer,
  };
}

/** Feature flag: mount when MCP_MARKANY_UPSTREAM is set. */
export function markanyConfigured(env: Env): string | null {
  return env.MCP_MARKANY_UPSTREAM?.trim() || null;
}

export async function listMarkAnyTools(input: MountInput): Promise<UpstreamTool[] | null> {
  return listMountedTools(contextOf(input));
}

export async function callMarkAnyTool(
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
