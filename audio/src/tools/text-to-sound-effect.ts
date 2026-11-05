import { z } from "zod";
import {
  COPYRIGHT_NOTICE,
  DEFAULT_DURATION_SECONDS,
  DEFAULT_STEPS,
  DEFAULT_WAIT_SECONDS,
  FROM_APP,
  MAX_DURATION_SECONDS,
  MAX_PROMPT_CHARS,
  MAX_STEPS,
  MAX_WAIT_SECONDS,
  MIN_DURATION_SECONDS,
  MIN_STEPS,
  tangofluxCreatePath,
  tangofluxResultPath,
} from "../config";
import type { ToolContext } from "../env";
import { ToolError, UpstreamError } from "../errors";
import {
  apiPost,
  defaultPollInterval,
  extractJobId,
  normalizeTangoFluxResult,
  pollJob,
} from "../upstream";
import {
  auditRecord,
  billTool,
  newAuditId,
  raiseAfterCharge,
  requireUpstreamBearer,
  resolveIdempotencyKey,
  waitMsFrom,
} from "./common";

export const textToSoundEffectInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(MAX_PROMPT_CHARS)
    .optional()
    .describe(
      `Text description of the sound effect to generate (<= ${MAX_PROMPT_CHARS} chars). ` +
        "Required to start a new job; omit when polling with `job_id` only.",
    ),
  duration: z
    .number()
    .int()
    .min(MIN_DURATION_SECONDS)
    .max(MAX_DURATION_SECONDS)
    .default(DEFAULT_DURATION_SECONDS)
    .describe(`Target duration in seconds (${MIN_DURATION_SECONDS}–${MAX_DURATION_SECONDS}, default ${DEFAULT_DURATION_SECONDS}).`),
  steps: z
    .number()
    .int()
    .min(MIN_STEPS)
    .max(MAX_STEPS)
    .default(DEFAULT_STEPS)
    .describe(`Sampling steps (${MIN_STEPS}–${MAX_STEPS}, default ${DEFAULT_STEPS}).`),
  job_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Existing TangoFlux job id from a previous call. Polling never creates a new upstream job."),
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

export type TextToSoundEffectInput = z.infer<typeof textToSoundEffectInputSchema>;

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

export async function textToSoundEffect(
  ctx: ToolContext,
  input: TextToSoundEffectInput,
): Promise<Record<string, unknown>> {
  const rawJobId = input.job_id?.trim();
  const rawPrompt = input.prompt?.trim();
  if (!rawJobId && !rawPrompt) {
    throw new ToolError("Provide `prompt` to start a job, or `job_id` to poll an existing job.", "invalid_arguments");
  }
  if (rawJobId && rawPrompt) {
    throw new ToolError("Provide exactly one of `prompt` (start) or `job_id` (poll).", "invalid_arguments");
  }

  requireUpstreamBearer(ctx);
  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "text_to_sound_effect", idempotencyKey);
  const auditId = newAuditId();
  const duration = input.duration ?? DEFAULT_DURATION_SECONDS;
  const steps = input.steps ?? DEFAULT_STEPS;

  try {
    let taskId = rawJobId ? validateJobId(rawJobId) : undefined;
    let created = false;

    if (!taskId) {
      const createPayload = await apiPost(ctx.env, tangofluxCreatePath(ctx.env), {
        prompt: rawPrompt,
        duration,
        steps,
        from_app: FROM_APP,
      });
      taskId = extractJobId(createPayload);
      if (!taskId) {
        throw new UpstreamError(
          "TangoFlux create did not return a jobId.",
          undefined,
          "invalid_upstream_response",
          { upstream_result: createPayload },
        );
      }
      created = true;
      const createdState = normalizeTangoFluxResult(createPayload);
      if (createdState.state === "failed") {
        throw new UpstreamError(
          `TangoFlux create failed: ${createdState.remark ?? "unknown error"}`,
          undefined,
          "upstream_rejected",
          { job_id: taskId, status: createdState.status },
        );
      }
    }

    const activeTaskId = taskId;
    const timeoutMs = waitMsFrom(input.wait_seconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
    const polled = await pollJob(
      async () =>
        normalizeTangoFluxResult(
          await apiPost(ctx.env, tangofluxResultPath(ctx.env), { jobId: activeTaskId }),
        ),
      { timeoutMs, intervalMs: defaultPollInterval(ctx.env) },
    );

    const final = polled.state;
    const audioUrl = final.audio_url ?? null;
    const outDuration = final.duration ?? duration;
    const outSteps = final.steps ?? steps;

    if (final.state === "failed") {
      auditRecord({
        event: "text_to_sound_effect",
        audit_id: auditId,
        outcome: "failed",
        charge_id: billed.charge.charge_id,
        job_id: activeTaskId,
        created,
      });
      throw new UpstreamError(
        `TangoFlux job failed: ${final.remark ?? "unknown error"}`,
        undefined,
        "upstream_rejected",
        { job_id: activeTaskId, status: final.status },
      );
    }

    if (final.state === "done" && audioUrl) {
      auditRecord({
        event: "text_to_sound_effect",
        audit_id: auditId,
        outcome: "ok",
        charge_id: billed.charge.charge_id,
        job_id: activeTaskId,
        created,
        audio_host: (() => {
          try {
            return new URL(audioUrl).hostname;
          } catch {
            return undefined;
          }
        })(),
      });
      return {
        ok: true,
        tool: "text_to_sound_effect",
        audit_id: auditId,
        status: "done",
        job_id: activeTaskId,
        audio_url: audioUrl,
        duration: outDuration,
        steps: outSteps,
        created,
        timed_out: false,
        idempotency_key: idempotencyKey,
        charge: billed.charge,
        copyright_notice: COPYRIGHT_NOTICE,
        note: "Output audio URL has a limited TTL. Use only authorized prompts; do not abuse redistribution.",
      };
    }

    auditRecord({
      event: "text_to_sound_effect",
      audit_id: auditId,
      outcome: "pending",
      charge_id: billed.charge.charge_id,
      job_id: activeTaskId,
      created,
      timed_out: polled.timed_out,
    });

    return {
      ok: true,
      tool: "text_to_sound_effect",
      audit_id: auditId,
      status: "pending",
      job_id: activeTaskId,
      audio_url: null,
      duration: outDuration,
      steps: outSteps,
      created,
      timed_out: polled.timed_out,
      upstream_status: final.status ?? null,
      status_str: final.status_str ?? null,
      idempotency_key: idempotencyKey,
      charge: billed.charge,
      copyright_notice: COPYRIGHT_NOTICE,
      note: "Job still running. Call again with only `job_id` to poll (no new charge semantics beyond gateway).",
    };
  } catch (error) {
    auditRecord({
      event: "text_to_sound_effect",
      audit_id: auditId,
      outcome: "error",
      charge_id: billed.charge.charge_id,
    });
    raiseAfterCharge(error, billed);
  }
}
