import type { Env, ToolContext } from "../src/env";

export const testEnv: Env = {
  ALLOW_DIRECT_MCP: "1",
  COST_CONVERT_TEXT_STYLE: "1",
  COST_COUNT_TEXT: "1",
};

export const testCtx: ToolContext = {
  env: testEnv,
  authToken: "sk_live_test_0123456789abcdef",
  chargeId: "ch_test_gateway",
  accessChannel: "mcp-gateway",
};
