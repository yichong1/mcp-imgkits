import { McpServer } from "@modelcontextprotocol/server";
import {
  MAX_TEXT_CHARS,
  PRIVACY_NOTICE,
  SERVICE_NAME,
  SERVICE_VERSION,
  STYLE_MODES,
  costFor,
  type StyleMode,
} from "./config";
import type { ToolContext } from "./env";
import { toolErrorResult, toolJsonResult } from "./errors";
import { convertTextStyle, convertTextStyleInputSchema } from "./tools/convert-text-style";
import { countText, countTextInputSchema } from "./tools/count-text";

function costLabel(cost: number): string {
  return cost === 0 ? "free" : `${cost} credit${cost === 1 ? "" : "s"}`;
}

export function createTextUtilsServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });

  const styleCost = costFor(ctx.env, "convert_text_style");
  server.registerTool(
    "convert_text_style",
    {
      title: "Convert Text Style",
      description:
        `Transform text with a pure in-Worker algorithm (no upstream HTTP). ` +
        `Pass required \`text\` (≤${MAX_TEXT_CHARS} chars) and \`mode\` one of: ${STYLE_MODES.join(", ")}. ` +
        `Modes: morse / binary (mappable chars only; others kept + optional skipped note), ` +
        `old_english (Fraktur Unicode), fancy (Math Sans-Serif Bold Unicode), ` +
        `upper / lower / title / reverse. Returns { text, mode, result }. ` +
        `Cost: ${costLabel(styleCost)} per call, charged by mcp-credit-gateway before forwarding. ` +
        `Privacy: ${PRIVACY_NOTICE}`,
      inputSchema: convertTextStyleInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: { text: string; mode: StyleMode }) => {
      try {
        return toolJsonResult(await convertTextStyle(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  const countCost = costFor(ctx.env, "count_text");
  server.registerTool(
    "count_text",
    {
      title: "Count Text",
      description:
        `Count characters, words, lines, and UTF-8 bytes for \`text\` (≤${MAX_TEXT_CHARS} chars). ` +
        `Latin words + CJK ideographs counted separately; pure algorithm, no upstream. ` +
        `Returns characters, characters_no_whitespace, words, lines, bytes_utf8. ` +
        `Cost: ${costLabel(countCost)} per call, charged by mcp-credit-gateway before forwarding. ` +
        `Privacy: ${PRIVACY_NOTICE}`,
      inputSchema: countTextInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: { text: string }) => {
      try {
        return toolJsonResult(await countText(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}
