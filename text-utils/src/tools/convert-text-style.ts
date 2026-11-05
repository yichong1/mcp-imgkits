import { z } from "zod";
import { MAX_TEXT_CHARS, STYLE_MODES, costFor, type StyleMode } from "../config";
import { chargeCredits } from "../charge";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";
import { convertStyle } from "./styles";

export const convertTextStyleInputSchema = {
  text: z
    .string()
    .min(1, "text is required")
    .max(MAX_TEXT_CHARS, `text must be <= ${MAX_TEXT_CHARS} characters`),
  mode: z.enum(STYLE_MODES),
};

export type ConvertTextStyleInput = {
  text: string;
  mode: StyleMode;
};

export async function convertTextStyle(
  ctx: ToolContext,
  args: ConvertTextStyleInput,
): Promise<Record<string, unknown>> {
  const text = args.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new ToolError("text is required and must be a non-empty string.", "invalid_arguments");
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new ToolError(`text must be <= ${MAX_TEXT_CHARS} characters.`, "invalid_arguments");
  }
  if (!(STYLE_MODES as readonly string[]).includes(args.mode)) {
    throw new ToolError(
      `mode must be one of: ${STYLE_MODES.join(", ")}.`,
      "invalid_arguments",
    );
  }

  const cost = costFor(ctx.env, "convert_text_style");
  const charge = chargeCredits({
    cost,
    tool: "convert_text_style",
    ...(ctx.chargeId ? { chargeId: ctx.chargeId } : {}),
  });

  const styled = convertStyle(text, args.mode);
  return {
    ok: true,
    tool: "convert_text_style",
    ...styled,
    charged: charge.charged,
    charged_this_call: charge.charged,
    billing: charge.charged > 0 ? "charged" : "free",
    ...(charge.charge_id ? { charge_id: charge.charge_id } : {}),
  };
}
