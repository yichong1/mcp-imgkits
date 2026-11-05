import { z } from "zod";
import { MAX_SOURCE_URL_CHARS, SEGMENT_SUBJECTS, segmentPath, usaBaseUrl, type SegmentSubject } from "../config";
import type { ToolContext } from "../env";
import { getUpstream } from "../upstream";
import { assertPublicUrl } from "../urls";
import { sourceHost, successImage, withImageCall } from "./common";

export const removeBackgroundInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .describe("Public http(s) URL of the image whose background should be removed."),
  subject: z
    .enum(SEGMENT_SUBJECTS)
    .optional()
    .describe(
      "Optional subject. `general` (default) calls `/ai/segment`. " +
        "head/cloth/commodity/animal/logo/body/furniture call `/ai/segment<head|cloth|...>`.",
    ),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type RemoveBackgroundInput = z.input<typeof removeBackgroundInputSchema>;

/** GET `/ai/segment?pic=` (or a subject-specific segment* path). */
export async function removeBackground(
  ctx: ToolContext,
  input: RemoveBackgroundInput,
): Promise<Record<string, unknown>> {
  const sourceUrl = assertPublicUrl(input.source_url, "source_url");
  const subject: SegmentSubject = input.subject ?? "general";
  const path = segmentPath(ctx.env, subject);
  const query = new URLSearchParams({ pic: sourceUrl });
  const host = sourceHost(sourceUrl);
  return withImageCall(ctx, "remove_background", input.idempotency_key, host, async (billed, auditId) => {
    const payload = await getUpstream(ctx.env, usaBaseUrl(ctx.env), `${path}?${query.toString()}`);
    return successImage({
      tool: "remove_background",
      auditId,
      sourceUrl,
      payload,
      billed,
      extra: { subject, segment_path: path },
    });
  });
}
