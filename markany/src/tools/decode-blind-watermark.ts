import { z } from "zod";
import {
  DEFAULT_DECODE_WAIT_SECONDS,
  MAX_DECODE_WAIT_SECONDS,
  MAX_SOURCE_URL_CHARS,
  blindDecodePath,
  blindResultPath,
} from "../config";
import type { ToolContext } from "../env";
import { ToolError, UpstreamError } from "../errors";
import {
  aiGet,
  aiPost,
  defaultPollInterval,
  extractTaskId,
  normalizeBlindWatermarkResult,
  pollJob,
  withQuery,
} from "../upstream";
import { assertPublicUrl } from "../urls";
import {
  auditRecord,
  billTool,
  newAuditId,
  raiseAfterCharge,
  requireUpstreamConfigured,
  resolveIdempotencyKey,
  waitMsFrom,
} from "./common";

export const decodeBlindWatermarkInputSchema = z.object({
  source_url: z
    .string()
    .min(1)
    .max(MAX_SOURCE_URL_CHARS)
    .optional()
    .describe("Public http(s) URL of the watermarked image. Start a new decode job with this, or poll with `job_id`."),
  job_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Existing upstream task id returned by a previous call. Polling never creates a new decode task."),
  wait_seconds: z
    .number()
    .min(0)
    .max(MAX_DECODE_WAIT_SECONDS)
    .default(DEFAULT_DECODE_WAIT_SECONDS)
    .describe(
      `How long to wait for a result, 0–${MAX_DECODE_WAIT_SECONDS} seconds (default ${DEFAULT_DECODE_WAIT_SECONDS}). ` +
        "On timeout the call returns a job_id to poll.",
    ),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type DecodeBlindWatermarkInput = z.infer<typeof decodeBlindWatermarkInputSchema>;

function validateJobId(jobId: string): string {
  const value = jobId.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new ToolError(
      "job_id must be 1–128 characters and may contain only letters, digits, '.', '_', ':' or '-'.",
      "invalid_job_id",
    );
  }
  return value;
}

export async function decodeBlindWatermark(
  ctx: ToolContext,
  input: DecodeBlindWatermarkInput,
): Promise<Record<string, unknown>> {
  const rawJobId = input.job_id?.trim();
  const rawSource = input.source_url?.trim();
  if (Boolean(rawJobId) === Boolean(rawSource)) {
    throw new ToolError("Provide exactly one of `source_url` (start a job) or `job_id` (poll a job).", "invalid_arguments");
  }

  const jobId = rawJobId ? validateJobId(rawJobId) : undefined;
  const sourceUrl = rawSource ? assertPublicUrl(rawSource, "source_url") : undefined;

  requireUpstreamConfigured(ctx);
  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "decode_blind_watermark", idempotencyKey);
  const auditId = newAuditId();
  const sourceHost = sourceUrl ? new URL(sourceUrl).hostname : undefined;

  try {
    let taskId = jobId;
    let created = false;

    if (!taskId) {
      const createPayload = await aiPost(ctx.env, blindDecodePath(ctx.env), { url: sourceUrl });
      taskId = extractTaskId(createPayload);
      if (!taskId) {
        throw new UpstreamError(
          "Watermark upstream did not return a task id for blind watermark decode.",
          undefined,
          "invalid_upstream_response",
          { upstream_result: createPayload },
        );
      }
      created = true;
    }

    const activeTaskId = taskId;
    const timeoutMs = waitMsFrom(input.wait_seconds, DEFAULT_DECODE_WAIT_SECONDS, MAX_DECODE_WAIT_SECONDS);
    const polled = await pollJob(
      async () =>
        normalizeBlindWatermarkResult(
          await aiGet(ctx.env, withQuery(blindResultPath(ctx.env), { taskId: activeTaskId })),
        ),
      { timeoutMs, intervalMs: defaultPollInterval(ctx.env) },
    );

    const result = polled.state;

    if (result.state === "failed") {
      throw new UpstreamError(
        `Blind watermark decode failed: ${result.message ?? result.code ?? "unknown upstream error"}.`,
        undefined,
        "upstream_job_failed",
        {
          job_id: activeTaskId,
          audit_id: auditId,
          status: result.status,
          code: result.code,
        },
      );
    }

    auditRecord({
      event: "decode_blind_watermark",
      audit_id: auditId,
      outcome: result.state === "done" ? "ok" : "timeout",
      charge_id: billed.charge.charge_id,
      ...(sourceHost ? { source_host: sourceHost } : {}),
      job_id: activeTaskId,
      created,
      found_content: Boolean(result.content),
    });

    return {
      ok: true,
      tool: "decode_blind_watermark",
      audit_id: auditId,
      job_id: activeTaskId,
      created,
      state: result.state,
      timed_out: polled.timed_out,
      content: result.state === "done" ? (result.content ?? null) : null,
      ...(result.status ? { status: result.status } : {}),
      ...(result.code ? { code: result.code } : {}),
      ...(result.message ? { message: result.message } : {}),
      ...(result.user_data ? { user_data: result.user_data } : {}),
      upstream_result: result.payload,
      wait_seconds: input.wait_seconds,
      idempotency_key: idempotencyKey,
      charge: billed.charge,
      ...(result.state === "pending"
        ? {
            retry: {
              tool: "decode_blind_watermark",
              arguments: { job_id: activeTaskId },
              note: "Poll again with job_id; polling does not create a new upstream task.",
            },
          }
        : {}),
      note:
        result.state === "done"
          ? result.content
            ? "Decoded blind watermark content is in `content`."
            : "Decode finished but the upstream returned no readable content; the image may not contain this watermark."
          : "Decode is still running upstream; poll again with `job_id`.",
    };
  } catch (error) {
    auditRecord({
      event: "decode_blind_watermark",
      audit_id: auditId,
      outcome: "error",
      charge_id: billed.charge.charge_id,
      ...(sourceHost ? { source_host: sourceHost } : {}),
      ...(jobId ? { job_id: jobId } : {}),
    });
    raiseAfterCharge(error, billed);
  }
}
