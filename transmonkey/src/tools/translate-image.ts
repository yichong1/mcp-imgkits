import { z } from "zod";
import { DEFAULT_WAIT_SECONDS, MAX_IMAGE_URLS, MAX_WAIT_SECONDS } from "../config";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";
import { assertPublicUrl } from "../urls";
import {
  defaultPollInterval,
  extractJobId,
  imageCreate,
  imageStatus,
  pollJob,
  type JobState,
} from "../upstream";
import {
  billTool,
  normalizeLanguages,
  pseudoUpstreamUserId,
  raiseAfterCharge,
  requireUpstreamConfigured,
  resolveIdempotencyKey,
  waitMsFrom,
  type BilledCall,
} from "./common";

const IMAGE_FONTS = [
  "noto",
  "wildwords",
  "komikajam",
  "bangers",
  "edo",
  "ridibatang",
  "bushidoo",
  "hayah",
  "itim",
  "mogulirina",
] as const;

export const translateImageInputSchema = z.object({
  image_urls: z
    .array(z.string().url().max(2048))
    .min(1)
    .max(MAX_IMAGE_URLS)
    .optional()
    .describe(
      "1-10 public image URLs (JPG/PNG/WebP recommended). Keep each image <= 10 MB; larger files may be rejected by the upstream downloader.",
    ),
  from: z
    .string()
    .min(1)
    .max(32)
    .default("auto")
    .describe("Source language code or name. Defaults to 'auto'."),
  to: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe("Target language code or name. Required for a new job."),
  paste: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .default(1)
    .describe("Paste mode: 0 = no text overlay, 1 = whole-image overlay (default), 2 = block overlay."),
  font: z
    .enum(IMAGE_FONTS)
    .default("noto")
    .describe("Overlay font. Defaults to 'noto'."),
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .default(DEFAULT_WAIT_SECONDS)
    .describe("How long to wait for the async job in this call (0-120 seconds, default 30)."),
  job_id: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Resume polling an existing job. Polling does not create a new upstream job."),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional per-job key for upstream job isolation. Billing is handled by mcp-credit-gateway."),
});

export type TranslateImageInput = z.input<typeof translateImageInputSchema>;

function imageResult(jobId: string, state: JobState, billed?: BilledCall): Record<string, unknown> {
  const base: Record<string, unknown> = {
    job_id: jobId,
    status: state.state,
    upstream_status: state.status_str ?? state.status ?? null,
    translated_image_urls: state.result_urls,
    result: state.result ?? null,
    ...(state.remark ? { upstream_remark: state.remark } : {}),
    ...(billed
      ? { idempotency_key: billed.idempotencyKey, charge: billed.charge }
      : { resumed: true, charged_this_call: 0 }),
  };

  if (state.state === "pending") {
    return {
      ...base,
      next_action:
        `Call translate_image again with job_id="${jobId}" to continue polling. ` +
        "Polling an existing job_id does not create a new upstream job.",
    };
  }

  if (state.state === "done") {
    return {
      ...base,
      timeline: "translation finished",
      expires_in_hours: 24,
      note: "Upstream result URLs expire; download them promptly.",
    };
  }

  const charged = Boolean(billed && billed.charge.charged > 0);
  const chargeId = billed?.charge.charge_id ?? billed?.idempotencyKey;
  throw new ToolError(
    `Image translation job ${jobId} failed upstream (${state.status_str ?? state.status ?? "unknown"}).` +
      (charged
        ? ` The credit charge succeeded (charge_id=${chargeId}); there is no automatic refund API, so contact support with this charge_id.`
        : " No new upstream job was created by this resume call."),
    "upstream_job_failed",
    base,
  );
}

export async function translateImage(
  ctx: ToolContext,
  input: TranslateImageInput,
): Promise<Record<string, unknown>> {
  const waitMs = waitMsFrom(input.wait_seconds, DEFAULT_WAIT_SECONDS);

  if (input.job_id) {
    const polled = await pollJob(() => imageStatus(ctx.env, input.job_id as string), {
      timeoutMs: waitMs,
      intervalMs: defaultPollInterval(ctx.env),
    });
    return imageResult(input.job_id, polled.state);
  }

  if (!input.image_urls || input.image_urls.length === 0 || !input.to) {
    throw new ToolError(
      "Provide `image_urls` and `to` for a new job, or `job_id` to resume polling.",
      "invalid_arguments",
    );
  }

  if (input.image_urls.length > MAX_IMAGE_URLS) {
    throw new ToolError(`At most ${MAX_IMAGE_URLS} image URLs are allowed per call.`, "invalid_arguments");
  }
  input.image_urls.forEach((url, index) => assertPublicUrl(url, `image_urls[${index}]`));
  const { from, to } = normalizeLanguages(input.from ?? "auto", input.to);
  requireUpstreamConfigured(ctx);
  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "translate_image", idempotencyKey);

  try {
    const userId = await pseudoUpstreamUserId(ctx.authToken, idempotencyKey);
    const createPayload = await imageCreate(ctx.env, {
      imgs: input.image_urls,
      from,
      to,
      paste: input.paste ?? 1,
      font: input.font ?? "noto",
      userId,
    });
    const jobId = extractJobId(createPayload);
    if (!jobId) {
      throw new ToolError(
        "Image translation create did not return a jobId.",
        "invalid_upstream_response",
        { upstream: createPayload },
      );
    }

    const polled = await pollJob(() => imageStatus(ctx.env, jobId), {
      timeoutMs: waitMs,
      intervalMs: defaultPollInterval(ctx.env),
    });
    return imageResult(jobId, polled.state, billed);
  } catch (error) {
    raiseAfterCharge(error, billed);
  }
}
