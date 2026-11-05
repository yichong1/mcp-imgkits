import { z } from "zod";
import {
  COPYRIGHT_NOTICE,
  DEFAULT_WAIT_SECONDS,
  FROM_APP,
  MAX_AUDIO_URL_CHARS,
  MAX_WAIT_SECONDS,
  spleeterCreatePath,
  spleeterResultPath,
} from "../config";
import type { ToolContext } from "../env";
import { ToolError, UpstreamError } from "../errors";
import {
  apiPost,
  defaultPollInterval,
  extractJobId,
  extractStemUrls,
  normalizeAsyncJob,
  pollJob,
} from "../upstream";
import {
  auditRecord,
  billTool,
  newAuditId,
  raiseAfterCharge,
  requireUpstreamBearer,
  resolveIdempotencyKey,
  validateHttpUrl,
  validateJobId,
  waitMsFrom,
} from "./common";

export const separateStemsInputSchema = z.object({
  audio_url: z
    .string()
    .min(1)
    .max(MAX_AUDIO_URL_CHARS)
    .optional()
    .describe(
      `Public http(s) URL of the source audio (<= ${MAX_AUDIO_URL_CHARS} chars). ` +
        "Required to start a new job; omit when polling with `job_id` only. " +
        "Use only tracks you own or are licensed to separate.",
    ),
  job_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Existing Spleeter job id from a previous call. Polling never creates a new upstream job."),
  wait_seconds: z
    .number()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .default(DEFAULT_WAIT_SECONDS)
    .describe(
      `How long to wait for a result, 0–${MAX_WAIT_SECONDS} seconds (default ${DEFAULT_WAIT_SECONDS}). ` +
        "On timeout the call returns a job_id to poll.",
    ),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key, echoed in the result. Billing is handled by mcp-credit-gateway."),
});

export type SeparateStemsInput = z.infer<typeof separateStemsInputSchema>;

export async function separateStems(
  ctx: ToolContext,
  input: SeparateStemsInput,
): Promise<Record<string, unknown>> {
  const rawJobId = input.job_id?.trim();
  const rawAudioUrl = input.audio_url?.trim();
  if (!rawJobId && !rawAudioUrl) {
    throw new ToolError(
      "Provide `audio_url` to start a job, or `job_id` to poll an existing job.",
      "invalid_arguments",
    );
  }
  if (rawJobId && rawAudioUrl) {
    throw new ToolError("Provide exactly one of `audio_url` (start) or `job_id` (poll).", "invalid_arguments");
  }

  requireUpstreamBearer(ctx);
  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "separate_stems", idempotencyKey);
  const auditId = newAuditId();

  try {
    let taskId = rawJobId ? validateJobId(rawJobId) : undefined;
    let created = false;

    if (!taskId) {
      const audioUrl = validateHttpUrl(rawAudioUrl!, "audio_url", MAX_AUDIO_URL_CHARS);
      const createPayload = await apiPost(ctx.env, spleeterCreatePath(ctx.env), {
        audio_url: audioUrl,
        model: "2stems",
        from_app: FROM_APP,
      });
      taskId = extractJobId(createPayload);
      if (!taskId) {
        throw new UpstreamError(
          "Spleeter create did not return a jobId.",
          undefined,
          "invalid_upstream_response",
          { upstream_result: createPayload },
        );
      }
      created = true;
      const createdState = normalizeAsyncJob(createPayload);
      if (createdState.state === "failed") {
        throw new UpstreamError(
          `Spleeter create failed: ${createdState.remark ?? "unknown error"}`,
          undefined,
          "upstream_rejected",
          { job_id: taskId, status: createdState.status },
        );
      }
    }

    const activeTaskId = taskId;
    const timeoutMs = waitMsFrom(input.wait_seconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
    // Docs: /status and /result share the same shape; poll /result.
    const polled = await pollJob(
      async () =>
        normalizeAsyncJob(
          await apiPost(ctx.env, spleeterResultPath(ctx.env), { jobId: activeTaskId }),
        ),
      { timeoutMs, intervalMs: defaultPollInterval(ctx.env) },
    );

    const final = polled.state;
    const stems = extractStemUrls(final.payload);
    const hasStems = Boolean(stems.vocals || stems.accompaniment || stems.zip_url);

    if (final.state === "failed") {
      auditRecord({
        event: "separate_stems",
        audit_id: auditId,
        outcome: "failed",
        charge_id: billed.charge.charge_id,
        job_id: activeTaskId,
        created,
      });
      throw new UpstreamError(
        `Spleeter job failed: ${final.remark ?? "unknown error"}`,
        undefined,
        "upstream_rejected",
        { job_id: activeTaskId, status: final.status },
      );
    }

    if (final.state === "done" && hasStems) {
      auditRecord({
        event: "separate_stems",
        audit_id: auditId,
        outcome: "ok",
        charge_id: billed.charge.charge_id,
        job_id: activeTaskId,
        created,
        vocals_host: (() => {
          try {
            return stems.vocals ? new URL(stems.vocals).hostname : undefined;
          } catch {
            return undefined;
          }
        })(),
      });
      return {
        ok: true,
        tool: "separate_stems",
        audit_id: auditId,
        status: "done",
        job_id: activeTaskId,
        vocals_url: stems.vocals ?? null,
        accompaniment_url: stems.accompaniment ?? null,
        zip_url: stems.zip_url ?? null,
        model: "2stems",
        created,
        timed_out: false,
        idempotency_key: idempotencyKey,
        charge: billed.charge,
        copyright_notice: COPYRIGHT_NOTICE,
        note: "Stem URLs have a limited TTL. Use only on audio you own or are licensed to separate.",
      };
    }

    if (final.state === "done" && !hasStems) {
      auditRecord({
        event: "separate_stems",
        audit_id: auditId,
        outcome: "failed",
        charge_id: billed.charge.charge_id,
        job_id: activeTaskId,
        created,
      });
      throw new UpstreamError(
        "Spleeter reported done but returned no stem URLs.",
        undefined,
        "invalid_upstream_response",
        { job_id: activeTaskId, status: final.status },
      );
    }

    auditRecord({
      event: "separate_stems",
      audit_id: auditId,
      outcome: "pending",
      charge_id: billed.charge.charge_id,
      job_id: activeTaskId,
      created,
      timed_out: polled.timed_out,
    });

    return {
      ok: true,
      tool: "separate_stems",
      audit_id: auditId,
      status: "pending",
      job_id: activeTaskId,
      vocals_url: null,
      accompaniment_url: null,
      zip_url: null,
      model: "2stems",
      created,
      timed_out: polled.timed_out,
      upstream_status: final.status ?? null,
      status_str: final.status_str ?? null,
      idempotency_key: idempotencyKey,
      charge: billed.charge,
      copyright_notice: COPYRIGHT_NOTICE,
      note: "Job still running. Call again with only `job_id` to poll.",
    };
  } catch (error) {
    auditRecord({
      event: "separate_stems",
      audit_id: auditId,
      outcome: "error",
      charge_id: billed.charge.charge_id,
    });
    raiseAfterCharge(error, billed);
  }
}
