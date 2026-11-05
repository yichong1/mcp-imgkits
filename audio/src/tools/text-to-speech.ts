import { z } from "zod";
import {
  COPYRIGHT_NOTICE,
  DEFAULT_WAIT_SECONDS,
  FROM_APP,
  MAX_AUDIO_URL_CHARS,
  MAX_REFER_AUDIO_TEXT_CHARS,
  MAX_TEXT_CHARS,
  MAX_WAIT_SECONDS,
  qwenTtsCreatePath,
  qwenTtsResultPath,
} from "../config";
import type { ToolContext } from "../env";
import { ToolError, UpstreamError } from "../errors";
import {
  apiPost,
  defaultPollInterval,
  extractAudioUrl,
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

export const textToSpeechInputSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_TEXT_CHARS)
    .optional()
    .describe(
      `Text to synthesize (<= ${MAX_TEXT_CHARS} chars). Required to start; omit when polling with \`job_id\` only.`,
    ),
  refer_audio: z
    .string()
    .min(1)
    .max(MAX_AUDIO_URL_CHARS)
    .optional()
    .describe(
      `Public http(s) reference voice sample URL (<= ${MAX_AUDIO_URL_CHARS} chars). ` +
        "Required with `text` to start (preferred over voiceId). Use a short sample of a voice you own/are authorized to use.",
    ),
  refer_audio_text: z
    .string()
    .min(1)
    .max(MAX_REFER_AUDIO_TEXT_CHARS)
    .optional()
    .describe(
      `Transcript of the reference audio (strongly recommended, <= ${MAX_REFER_AUDIO_TEXT_CHARS} chars).`,
    ),
  language: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe("Optional language hint (default Auto upstream)."),
  speed: z
    .number()
    .min(0.5)
    .max(2)
    .optional()
    .describe("Optional speaking speed (0.5–2)."),
  job_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Existing Qwen-TTS job id. Polling never creates a new upstream job."),
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

export type TextToSpeechInput = z.infer<typeof textToSpeechInputSchema>;

function extractTtsAudioUrl(payload: unknown, result: unknown): string | undefined {
  if (typeof result === "string" && /^https?:\/\//i.test(result.trim())) return result.trim();
  return extractAudioUrl(payload) ?? extractAudioUrl(result);
}

export async function textToSpeech(
  ctx: ToolContext,
  input: TextToSpeechInput,
): Promise<Record<string, unknown>> {
  const rawJobId = input.job_id?.trim();
  const rawText = input.text?.trim();
  if (!rawJobId && !rawText) {
    throw new ToolError("Provide `text` to start a job, or `job_id` to poll an existing job.", "invalid_arguments");
  }
  if (rawJobId && rawText) {
    throw new ToolError("Provide exactly one of `text` (start) or `job_id` (poll).", "invalid_arguments");
  }

  // Validate start args before charge so missing params never empty-charge.
  let startReferAudio: string | undefined;
  if (!rawJobId) {
    const referAudioRaw = input.refer_audio?.trim();
    if (!referAudioRaw) {
      throw new ToolError(
        "`refer_audio` (http(s) voice sample URL) is required to start text_to_speech. voiceId library voices are not exposed this wave.",
        "invalid_arguments",
      );
    }
    startReferAudio = validateHttpUrl(referAudioRaw, "refer_audio", MAX_AUDIO_URL_CHARS);
  }

  requireUpstreamBearer(ctx);
  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "text_to_speech", idempotencyKey);
  const auditId = newAuditId();

  try {
    let taskId = rawJobId ? validateJobId(rawJobId) : undefined;
    let created = false;

    if (!taskId) {
      const referAudio = startReferAudio!;
      const body: Record<string, unknown> = {
        text: rawText,
        refer_audio: referAudio,
        from_app: FROM_APP,
        response_format: "mp3",
      };
      const referText = input.refer_audio_text?.trim();
      if (referText) body.refer_audio_text = referText;
      if (input.language?.trim()) body.language = input.language.trim();
      if (input.speed !== undefined) body.speed = input.speed;

      const createPayload = await apiPost(ctx.env, qwenTtsCreatePath(ctx.env), body);
      taskId = extractJobId(createPayload);
      if (!taskId) {
        throw new UpstreamError(
          "Qwen-TTS create did not return a jobId.",
          undefined,
          "invalid_upstream_response",
          { upstream_result: createPayload },
        );
      }
      created = true;
      const createdState = normalizeAsyncJob(createPayload);
      if (createdState.state === "failed") {
        throw new UpstreamError(
          `Qwen-TTS create failed: ${createdState.remark ?? "unknown error"}`,
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
        normalizeAsyncJob(
          await apiPost(ctx.env, qwenTtsResultPath(ctx.env), { jobId: activeTaskId }),
        ),
      { timeoutMs, intervalMs: defaultPollInterval(ctx.env) },
    );

    const final = polled.state;
    const audioUrl = extractTtsAudioUrl(final.payload, final.result);

    if (final.state === "failed") {
      auditRecord({
        event: "text_to_speech",
        audit_id: auditId,
        outcome: "failed",
        charge_id: billed.charge.charge_id,
        job_id: activeTaskId,
        created,
      });
      throw new UpstreamError(
        `Qwen-TTS job failed: ${final.remark ?? "unknown error"}`,
        undefined,
        "upstream_rejected",
        { job_id: activeTaskId, status: final.status },
      );
    }

    if (final.state === "done" && audioUrl) {
      auditRecord({
        event: "text_to_speech",
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
        tool: "text_to_speech",
        audit_id: auditId,
        status: "done",
        job_id: activeTaskId,
        audio_url: audioUrl,
        created,
        timed_out: false,
        idempotency_key: idempotencyKey,
        charge: billed.charge,
        copyright_notice: COPYRIGHT_NOTICE,
        note: "Output audio URL has a limited TTL. Use only authorized text and reference voices.",
      };
    }

    if (final.state === "done" && !audioUrl) {
      throw new UpstreamError(
        "Qwen-TTS reported done but returned no audio URL.",
        undefined,
        "invalid_upstream_response",
        { job_id: activeTaskId, status: final.status },
      );
    }

    auditRecord({
      event: "text_to_speech",
      audit_id: auditId,
      outcome: "pending",
      charge_id: billed.charge.charge_id,
      job_id: activeTaskId,
      created,
      timed_out: polled.timed_out,
    });

    return {
      ok: true,
      tool: "text_to_speech",
      audit_id: auditId,
      status: "pending",
      job_id: activeTaskId,
      audio_url: null,
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
      event: "text_to_speech",
      audit_id: auditId,
      outcome: "error",
      charge_id: billed.charge.charge_id,
    });
    raiseAfterCharge(error, billed);
  }
}
