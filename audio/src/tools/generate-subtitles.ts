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

export const generateSubtitlesInputSchema = z.object({
  audio_url: z
    .string()
    .min(1)
    .max(MAX_AUDIO_URL_CHARS)
    .optional()
    .describe(
      `Public http(s) URL of the audio to subtitle (<= ${MAX_AUDIO_URL_CHARS} chars). ` +
        "Required to start a new job; omit when polling with `job_id` only.",
    ),
  language: z
    .string()
    .min(2)
    .max(16)
    .optional()
    .describe("Optional language code (e.g. `en`, `zh`). Omit for auto-detect."),
  format: z
    .enum(["srt", "vtt"])
    .default("srt")
    .describe("Subtitle container to build in the Worker after Whisper finishes (`srt` or `vtt`)."),
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

export type GenerateSubtitlesInput = z.infer<typeof generateSubtitlesInputSchema>;

interface Cue {
  start: number;
  end: number;
  text: string;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function extractCues(result: unknown): Cue[] {
  const record = asRecord(result);
  const segments = record?.segments;
  if (!Array.isArray(segments)) return [];
  const cues: Cue[] = [];
  for (const seg of segments) {
    const row = asRecord(seg);
    if (!row) continue;
    const start = asNumber(row.start);
    const end = asNumber(row.end);
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (start === undefined || end === undefined || !text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function formatSrtTime(seconds: number): string {
  const msTotal = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(msTotal / 3_600_000);
  const minutes = Math.floor((msTotal % 3_600_000) / 60_000);
  const secs = Math.floor((msTotal % 60_000) / 1000);
  const ms = msTotal % 1000;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)},${pad3(ms)}`;
}

function formatVttTime(seconds: number): string {
  const msTotal = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(msTotal / 3_600_000);
  const minutes = Math.floor((msTotal % 3_600_000) / 60_000);
  const secs = Math.floor((msTotal % 60_000) / 1000);
  const ms = msTotal % 1000;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}.${pad3(ms)}`;
}

export function cuesToSrt(cues: Cue[]): string {
  if (cues.length === 0) return "";
  return (
    cues
      .map(
        (cue, index) =>
          `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n`,
      )
      .join("\n")
      .trim() + "\n"
  );
}

export function cuesToVtt(cues: Cue[]): string {
  const body =
    cues.length === 0
      ? ""
      : cues
          .map((cue) => `${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}\n${cue.text}\n`)
          .join("\n");
  return `WEBVTT\n\n${body}`.trim() + "\n";
}

export async function generateSubtitles(
  ctx: ToolContext,
  input: GenerateSubtitlesInput,
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
  const billed = await billTool(ctx, "generate_subtitles", idempotencyKey);
  const auditId = newAuditId();
  const format = input.format ?? "srt";
  const language = input.language?.trim() || undefined;

  try {
    let taskId = rawJobId ? validateJobId(rawJobId) : undefined;
    let created = false;

    if (!taskId) {
      const audioUrl = validateHttpUrl(rawAudioUrl!, "audio_url", MAX_AUDIO_URL_CHARS);
      const body: Record<string, unknown> = {
        audio: audioUrl,
        from_app: FROM_APP,
        response_format: "simple",
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
        event: "generate_subtitles",
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
      const cues = extractCues(final.result);
      const subtitles = format === "vtt" ? cuesToVtt(cues) : cuesToSrt(cues);
      auditRecord({
        event: "generate_subtitles",
        audit_id: auditId,
        outcome: "ok",
        charge_id: billed.charge.charge_id,
        job_id: activeTaskId,
        created,
        cue_count: cues.length,
        format,
      });
      return {
        ok: true,
        tool: "generate_subtitles",
        audit_id: auditId,
        status: "done",
        job_id: activeTaskId,
        format,
        subtitles,
        cue_count: cues.length,
        language: language ?? null,
        created,
        timed_out: false,
        idempotency_key: idempotencyKey,
        charge: billed.charge,
        copyright_notice: COPYRIGHT_NOTICE,
        note:
          "Empty subtitles mean no speech was detected; that is still a successful run. " +
          "SRT/VTT is assembled in the Worker from Whisper segments.",
      };
    }

    auditRecord({
      event: "generate_subtitles",
      audit_id: auditId,
      outcome: "pending",
      charge_id: billed.charge.charge_id,
      job_id: activeTaskId,
      created,
      timed_out: polled.timed_out,
    });

    return {
      ok: true,
      tool: "generate_subtitles",
      audit_id: auditId,
      status: "pending",
      job_id: activeTaskId,
      format,
      subtitles: null,
      cue_count: 0,
      language: language ?? null,
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
      event: "generate_subtitles",
      audit_id: auditId,
      outcome: "error",
      charge_id: billed.charge.charge_id,
    });
    raiseAfterCharge(error, billed);
  }
}
