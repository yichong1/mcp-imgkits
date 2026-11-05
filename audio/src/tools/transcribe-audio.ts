import { z } from "zod";
import {
  COPYRIGHT_NOTICE,
  DEFAULT_WAIT_SECONDS,
  FROM_APP,
  MAX_AUDIO_URL_CHARS,
  MAX_WAIT_SECONDS,
  whisperCreatePath,
  whisperResultPath,
} from "../config";
import type { ToolContext } from "../env";
import { ToolError, UpstreamError } from "../errors";
import {
  apiPost,
  asRecord,
  defaultPollInterval,
  extractJobId,
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

export const transcribeAudioInputSchema = z.object({
  audio_url: z
    .string()
    .min(1)
    .max(MAX_AUDIO_URL_CHARS)
    .optional()
    .describe(
      `Public http(s) URL of the audio to transcribe (<= ${MAX_AUDIO_URL_CHARS} chars). ` +
        "Required to start a new job; omit when polling with `job_id` only.",
    ),
  language: z
    .string()
    .min(2)
    .max(16)
    .optional()
    .describe("Optional language code (e.g. `en`, `zh`). Omit for auto-detect."),
  response_format: z
    .enum(["simple", "raw"])
    .default("simple")
    .describe("Upstream response format: `simple` (default) or `raw`."),
  job_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Existing Faster-Whisper job id. Polling never creates a new upstream job."),
  wait_seconds: z
    .number()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .default(DEFAULT_WAIT_SECONDS)
    .describe(
      `How long to wait for a result, 0–${MAX_WAIT_SECONDS} seconds (default ${DEFAULT_WAIT_SECONDS}).`,
    ),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key. Billing is handled by mcp-credit-gateway."),
});

export type TranscribeAudioInput = z.infer<typeof transcribeAudioInputSchema>;

function extractSegments(result: unknown): Array<Record<string, unknown>> {
  const record = asRecord(result);
  if (!record) return [];
  const segments = record.segments;
  if (!Array.isArray(segments)) return [];
  return segments.filter((s) => s !== null && typeof s === "object") as Array<Record<string, unknown>>;
}

function joinTranscript(segments: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (typeof seg.text === "string" && seg.text.trim()) parts.push(seg.text.trim());
  }
  return parts.join(" ").trim();
}

export async function transcribeAudio(
  ctx: ToolContext,
  input: TranscribeAudioInput,
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
  const billed = await billTool(ctx, "transcribe_audio", idempotencyKey);
  const auditId = newAuditId();
  const responseFormat = input.response_format ?? "simple";
  const language = input.language?.trim() || undefined;

  try {
    let taskId = rawJobId ? validateJobId(rawJobId) : undefined;
    let created = false;

    if (!taskId) {
      const audioUrl = validateHttpUrl(rawAudioUrl!, "audio_url", MAX_AUDIO_URL_CHARS);
      const body: Record<string, unknown> = {
        audio: audioUrl,
        from_app: FROM_APP,
        response_format: responseFormat,
      };
      if (language) body.language = language;
      const createPayload = await apiPost(ctx.env, whisperCreatePath(ctx.env), body);
      taskId = extractJobId(createPayload);
      if (!taskId) {
        throw new UpstreamError(
          "Faster-Whisper create did not return a jobId.",
          undefined,
          "invalid_upstream_response",
          { upstream_result: createPayload },
        );
      }
      created = true;
      const createdState = normalizeAsyncJob(createPayload);
      if (createdState.state === "failed") {
        throw new UpstreamError(
          `Faster-Whisper create failed: ${createdState.remark ?? "unknown error"}`,
          undefined,
          "upstream_rejected",
          { job_id: taskId, status: createdState.status },
        );
      }
    }

    const activeTaskId = taskId;
    const timeoutMs = waitMsFrom(input.wait_seconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
    // No /status endpoint — poll /result only.
    const polled = await pollJob(
      async () =>
        normalizeAsyncJob(
          await apiPost(ctx.env, whisperResultPath(ctx.env), { jobId: activeTaskId }),
        ),
      { timeoutMs, intervalMs: defaultPollInterval(ctx.env) },
    );

    const final = polled.state;

    if (final.state === "failed") {
      auditRecord({
        event: "transcribe_audio",
        audit_id: auditId,
        outcome: "failed",
        charge_id: billed.charge.charge_id,
        job_id: activeTaskId,
        created,
      });
      throw new UpstreamError(
        `Faster-Whisper job failed: ${final.remark ?? "unknown error"}`,
        undefined,
        "upstream_rejected",
        { job_id: activeTaskId, status: final.status },
      );
    }

    if (final.state === "done") {
      const segments = extractSegments(final.result);
      const text = joinTranscript(segments);
      auditRecord({
        event: "transcribe_audio",
        audit_id: auditId,
        outcome: "ok",
        charge_id: billed.charge.charge_id,
        job_id: activeTaskId,
        created,
        segment_count: segments.length,
      });
      return {
        ok: true,
        tool: "transcribe_audio",
        audit_id: auditId,
        status: "done",
        job_id: activeTaskId,
        text,
        segments,
        segment_count: segments.length,
        language: language ?? null,
        response_format: responseFormat,
        created,
        timed_out: false,
        idempotency_key: idempotencyKey,
        charge: billed.charge,
        copyright_notice: COPYRIGHT_NOTICE,
        note:
          "Empty segments/text means no speech was detected; that is still a successful transcription. " +
          "Use only on audio you own or are authorized to transcribe.",
      };
    }

    auditRecord({
      event: "transcribe_audio",
      audit_id: auditId,
      outcome: "pending",
      charge_id: billed.charge.charge_id,
      job_id: activeTaskId,
      created,
      timed_out: polled.timed_out,
    });

    return {
      ok: true,
      tool: "transcribe_audio",
      audit_id: auditId,
      status: "pending",
      job_id: activeTaskId,
      text: null,
      segments: [],
      segment_count: 0,
      language: language ?? null,
      response_format: responseFormat,
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
      event: "transcribe_audio",
      audit_id: auditId,
      outcome: "error",
      charge_id: billed.charge.charge_id,
    });
    raiseAfterCharge(error, billed);
  }
}
