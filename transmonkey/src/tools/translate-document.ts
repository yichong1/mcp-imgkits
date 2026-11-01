import { z } from "zod";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "../config";
import type { ToolContext } from "../env";
import { ToolError } from "../errors";
import { assertPublicUrl } from "../urls";
import {
  asRecord,
  deepGet,
  defaultPollInterval,
  docCost,
  docCreate,
  docPreview,
  docStatus,
  extractJobId,
  extractTaskId,
  normalizeJobState,
  pollJob,
  type JobState,
} from "../upstream";
import {
  billTool,
  fileNameFromUrl,
  normalizeLanguages,
  pseudoUpstreamUserId,
  raiseAfterCharge,
  requireUpstreamConfigured,
  resolveIdempotencyKey,
  safeFileName,
  waitMsFrom,
  type BilledCall,
} from "./common";

export const translateDocumentInputSchema = z.object({
  doc_url: z
    .string()
    .url()
    .max(2048)
    .optional()
    .describe(
      "Publicly reachable document URL (signed URLs are fine). Supported: PDF, DOCX/DOC, XLSX/XLS, PPTX/PPT, EPUB, TXT, HTML, MD, CSV, SRT and more. Upstream size limits: PDF <= 30 MB, other formats <= 80 MB.",
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
    .describe("Target language code or name, e.g. en, zh, cht, ja, ko, fr, de, es."),
  file_name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Optional original file name, used by the upstream for the output file name."),
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

export type TranslateDocumentInput = z.input<typeof translateDocumentInputSchema>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function priceFrom(value: unknown): number | undefined {
  for (const path of ["price", "totalPrice", "result.price", "result.totalPrice", "detail.price", "outer_job_info.price"]) {
    const raw = deepGet(value, path);
    const numeric = typeof raw === "number" ? raw : Number(raw);
    if (raw !== undefined && raw !== null && raw !== "" && Number.isFinite(numeric)) return numeric;
  }
  return undefined;
}

async function waitForDocPrice(
  ctx: ToolContext,
  taskId: string | undefined,
  firstDetail: unknown,
  budgetMs: number,
): Promise<{ detail: unknown; price?: number; error?: string }> {
  let detail = firstDetail;
  let price = priceFrom(detail);
  if (price !== undefined || !taskId || budgetMs <= 0) return { detail, ...(price !== undefined ? { price } : {}) };

  const deadline = Date.now() + budgetMs;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    await sleep(Math.min(defaultPollInterval(ctx.env), Math.max(50, deadline - Date.now())));
    try {
      const preview = await docPreview(ctx.env, taskId);
      detail = deepGet(preview, "detail") ?? deepGet(preview, "result") ?? preview;
      price = priceFrom(detail);
      if (price !== undefined) return { detail, price };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { detail, ...(lastError ? { error: lastError } : {}) };
}

function jobResult(
  jobId: string,
  state: JobState,
  billed?: BilledCall,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    job_id: jobId,
    status: state.state,
    upstream_status: state.status_str ?? state.status ?? null,
    result: state.result ?? null,
    result_urls: state.result_urls,
    ...(state.remark ? { upstream_remark: state.remark } : {}),
    ...(billed
      ? { idempotency_key: billed.idempotencyKey, charge: billed.charge }
      : { resumed: true, charged_this_call: 0 }),
    ...extra,
  };

  if (state.state === "pending") {
    return {
      ...base,
      next_action:
        `Call translate_document again with job_id="${jobId}" to continue polling. ` +
        "Polling an existing job_id does not create a new upstream job.",
    };
  }

  if (state.state === "done") {
    return {
      ...base,
      timeline: "translation finished",
      expires_in_hours: 24,
      note: "Upstream deletes temporary files after processing and result URLs expire; download promptly.",
    };
  }

  const charged = Boolean(billed && billed.charge.charged > 0);
  const chargeId = billed?.charge.charge_id ?? billed?.idempotencyKey;
  throw new ToolError(
    `Document translation job ${jobId} failed upstream (${state.status_str ?? state.status ?? "unknown"}).` +
      (charged
        ? ` The credit charge succeeded (charge_id=${chargeId}); there is no automatic refund API, so contact support with this charge_id.`
        : " No new upstream job was created by this resume call."),
    "upstream_job_failed",
    base,
  );
}

async function resumeDocument(ctx: ToolContext, input: TranslateDocumentInput): Promise<Record<string, unknown>> {
  const jobId = input.job_id as string;
  const waitMs = waitMsFrom(input.wait_seconds, DEFAULT_WAIT_SECONDS);
  const deadline = Date.now() + waitMs;

  let state = normalizeJobState(await docStatus(ctx.env, jobId));
  if (state.state === "done") return jobResult(jobId, state);
  if (state.state === "failed") return jobResult(jobId, state);

  const statusWord = state.status_str?.toLowerCase();
  const record = asRecord(state.payload) ?? {};
  let createError: string | undefined;

  // `queried` means the cost/preview row exists but the translation job has
  // not been dispatched yet. Re-dispatch with the file metadata returned by
  // status; this does not create a new charge.
  if (statusWord === "queried" && waitMs > 0) {
    const doc = typeof record.file === "string" ? record.file : undefined;
    const from = typeof record.from === "string" ? record.from : undefined;
    const to = typeof record.to === "string" ? record.to : undefined;
    if (doc && from && to) {
      try {
        await docCreate(ctx.env, {
          doc,
          from,
          to,
          fileName: safeFileName(typeof record.fileName === "string" ? record.fileName : undefined, fileNameFromUrl(doc)),
          userId: await pseudoUpstreamUserId(ctx.authToken, jobId),
        });
      } catch (error) {
        createError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const remaining = Math.max(0, deadline - Date.now());
  const polled = await pollJob(() => docStatus(ctx.env, jobId), {
    timeoutMs: remaining,
    intervalMs: defaultPollInterval(ctx.env),
  });
  state = polled.state;
  return jobResult(jobId, state, undefined, createError ? { resume_create_error: createError } : {});
}

export async function translateDocument(
  ctx: ToolContext,
  input: TranslateDocumentInput,
): Promise<Record<string, unknown>> {
  if (input.job_id) return resumeDocument(ctx, input);

  if (!input.doc_url || !input.to) {
    throw new ToolError(
      "Provide `doc_url` and `to` for a new job, or `job_id` to resume polling.",
      "invalid_arguments",
    );
  }

  assertPublicUrl(input.doc_url, "doc_url");
  const { from, to } = normalizeLanguages(input.from ?? "auto", input.to);
  const fileName = safeFileName(input.file_name, fileNameFromUrl(input.doc_url));
  const waitMs = waitMsFrom(input.wait_seconds, DEFAULT_WAIT_SECONDS);
  const deadline = Date.now() + waitMs;

  requireUpstreamConfigured(ctx);
  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "translate_document", idempotencyKey);

  try {
    const userId = await pseudoUpstreamUserId(ctx.authToken, idempotencyKey);
    const costPayload = await docCost(ctx.env, { doc: input.doc_url, from, to, fileName, userId });
    const costDetail = deepGet(costPayload, "detail") ?? costPayload;
    const taskId = extractTaskId(costPayload);
    if (costDetail === undefined && !taskId) {
      throw new ToolError(
        "Document cost analysis returned no task information. The file may be inaccessible or unsupported.",
        "upstream_cost_failed",
      );
    }

    const previewBudget = waitMs > 0 ? Math.min(15_000, Math.floor(Math.max(0, deadline - Date.now()) / 2)) : 0;
    await waitForDocPrice(ctx, taskId, costDetail, previewBudget);

    const createPayload = await docCreate(ctx.env, { doc: input.doc_url, from, to, fileName, userId });
    const jobId = extractJobId(createPayload);
    if (!jobId) {
      throw new ToolError(
        "Document translation create did not return a jobId.",
        "invalid_upstream_response",
        { upstream: createPayload },
      );
    }

    const remaining = Math.max(0, deadline - Date.now());
    const polled = await pollJob(() => docStatus(ctx.env, jobId), {
      timeoutMs: remaining,
      intervalMs: defaultPollInterval(ctx.env),
    });
    return jobResult(jobId, polled.state, billed);
  } catch (error) {
    raiseAfterCharge(error, billed);
  }
}
