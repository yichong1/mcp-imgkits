import { aiBaseUrl, erasePath } from "../config";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";

/**
 * Intentionally not registered on the MCP server.
 * `ai.imgkits.com/api/inpaint` often returns HTTP 500 HTML, so a listed tool
 * would bill callers for an empty failure. This stub never calls upstream and
 * never records a charge.
 */
export const ERASE_OBJECT_LISTED = false;

export async function eraseObject(ctx: ToolContext): Promise<never> {
  const target = `${aiBaseUrl(ctx.env)}${erasePath(ctx.env)}`;
  throw new ToolError(
    `erase_object is hidden and not ready. ${target} often returns HTTP 500 HTML, ` +
      "so this Worker does not call it and does not report a charge.",
    "tool_not_ready",
  );
}
