import { z } from "zod";
import {
  COPYRIGHT_NOTICE,
  DEFAULT_WAIT_SECONDS,
  FROM_APP,
  MAX_FILE_URL_CHARS,
  MAX_MARKDOWN_CHARS,
  MAX_WAIT_SECONDS,
} from "../config";
import type { ToolContext } from "../env";
import { ToolError, UpstreamError } from "../errors";
import {
  collectMineruMarkdown,
  defaultPollInterval,
  mineruCreate,
  mineruResult,
  normalizeMineruState,
  pollJob,
  translateTexts,
} from "../upstream";
import {
  auditRecord,
  billTool,
  newAuditId,
  raiseAfterCharge,
  requireMineruBearer,
  resolveIdempotencyKey,
  validatePdfUrl,
  waitMsFrom,
} from "./common";

export const pdfToMarkdownThenTranslateInputSchema = z.object({
  file_url: z
    .string()
    .min(1)
    .max(MAX_FILE_URL_CHARS)
    .optional()
    .describe(
      `Public http(s) PDF URL (<= ${MAX_FILE_URL_CHARS} chars, path must end in .pdf). ` +
        "Provide either `file_url` or a single-element `files` array.",
    ),
  files: z
    .array(z.string().min(1).max(MAX_FILE_URL_CHARS))
    .min(1)
    .max(1)
    .optional()
    .describe("Alternative to `file_url`: exactly one public http(s) PDF URL."),
  target_lang: z
    .string()
    .min(1)
    .max(32)
    .describe("Target language code for translation (e.g. `zh`, `en`, `ja`). Required."),
  source_lang: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe("Optional source language code (default `auto`)."),
  include_source_markdown: z
    .boolean()
    .default(true)
    .describe("When true (default), include original MinerU markdown in the result."),
  wait_seconds: z
    .number()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .default(DEFAULT_WAIT_SECONDS)
    .describe(
      `How long to wait for MinerU, 0–${MAX_WAIT_SECONDS} seconds (default ${DEFAULT_WAIT_SECONDS}).`,
    ),
  idempotency_key: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional caller correlation key. Billing is handled by mcp-credit-gateway."),
});

export type PdfToMarkdownThenTranslateInput = z.infer<typeof pdfToMarkdownThenTranslateInputSchema>;

function resolvePdfUrl(input: PdfToMarkdownThenTranslateInput): string {
  const fromFiles = input.files?.[0]?.trim();
  const fromUrl = input.file_url?.trim();
  if (fromUrl && fromFiles && fromUrl !== fromFiles) {
    throw new ToolError("Provide either `file_url` or `files` (not conflicting values).", "invalid_arguments");
  }
  const raw = fromUrl || fromFiles;
  if (!raw) {
    throw new ToolError("Provide `file_url` or `files` with exactly one PDF http(s) URL.", "invalid_arguments");
  }
  if (input.files && input.files.length > 1) {
    throw new ToolError("Only one PDF URL is accepted per call.", "invalid_arguments");
  }
  return validatePdfUrl(raw, "file_url", MAX_FILE_URL_CHARS);
}

function bilingualMarkdown(source: string, translated: string): string {
  const srcParts = source.split(/\n\n+/);
  const dstParts = translated.split(/\n\n+/);
  const n = Math.max(srcParts.length, dstParts.length);
  const blocks: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = (srcParts[i] ?? "").trim();
    const t = (dstParts[i] ?? "").trim();
    if (!s && !t) continue;
    if (s) blocks.push(s);
    if (t) blocks.push(t);
  }
  return blocks.join("\n\n");
}

function truncateMarkdown(md: string): { text: string; truncated: boolean } {
  if (md.length <= MAX_MARKDOWN_CHARS) return { text: md, truncated: false };
  return {
    text: `${md.slice(0, MAX_MARKDOWN_CHARS)}\n\n[Output truncated by mcp-doc-translate]`,
    truncated: true,
  };
}

export async function pdfToMarkdownThenTranslate(
  ctx: ToolContext,
  input: PdfToMarkdownThenTranslateInput,
): Promise<Record<string, unknown>> {
  // Validate PDF URL before any upstream / billing bookkeeping so bad input
  // fails with invalid_arguments (gateway also pre-checks before charge).
  const pdfUrl = resolvePdfUrl(input);
  const targetLang = input.target_lang.trim();
  if (!targetLang) {
    throw new ToolError("target_lang is required.", "invalid_arguments");
  }
  const sourceLang = (input.source_lang?.trim() || "auto") || "auto";
  const includeSource = input.include_source_markdown !== false;

  requireMineruBearer(ctx);
  const idempotencyKey = resolveIdempotencyKey(input.idempotency_key);
  const billed = await billTool(ctx, "pdf_to_markdown_then_translate", idempotencyKey);
  const auditId = newAuditId();
  const waitMs = waitMsFrom(input.wait_seconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);

  try {
    let create;
    try {
      create = await mineruCreate(ctx.env, [pdfUrl], FROM_APP);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UpstreamError(`MinerU create failed: ${message}`, undefined, "mineru_failed");
    }

    const poll = await pollJob(
      async () => {
        try {
          const payload = await mineruResult(ctx.env, create.taskId);
          return normalizeMineruState(payload);
        } catch (error) {
          // Transient fetch errors → keep pending until timeout.
          if (error instanceof UpstreamError && error.code === "upstream_unreachable") {
            return { state: "pending" as const, task_id: create.taskId };
          }
          throw error;
        }
      },
      { timeoutMs: waitMs, intervalMs: defaultPollInterval(ctx.env) },
    );

    if (poll.timed_out || poll.state.state === "pending") {
      throw new UpstreamError(
        `MinerU task did not finish within ${Math.round(waitMs / 1000)} seconds (task ${create.taskId}).`,
        undefined,
        "mineru_failed",
        { task_id: create.taskId, timed_out: true },
      );
    }
    if (poll.state.state === "failed") {
      throw new UpstreamError(poll.state.message, undefined, "mineru_failed", {
        task_id: poll.state.task_id ?? create.taskId,
      });
    }

    const files = collectMineruMarkdown(poll.state.data);
    const markdownRaw = files.map((f) => f.markdown).filter((m) => m.trim()).join("\n\n").trim();
    if (!markdownRaw) {
      throw new UpstreamError("MinerU returned empty markdown.", undefined, "mineru_failed", {
        task_id: create.taskId,
      });
    }
    const { text: markdown, truncated } = truncateMarkdown(markdownRaw);

    let translated: string;
    try {
      const [one] = await translateTexts(ctx.env, {
        from: sourceLang,
        to: targetLang,
        texts: [markdown],
      });
      translated = one ?? "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UpstreamError(`Translate failed: ${message}`, undefined, "translate_failed", {
        task_id: create.taskId,
      });
    }

    const { text: translatedMarkdown } = truncateMarkdown(translated);
    const bilingual = bilingualMarkdown(markdown, translatedMarkdown);

    auditRecord({
      audit_id: auditId,
      tool: "pdf_to_markdown_then_translate",
      task_id: create.taskId,
      target_lang: targetLang,
      source_lang: sourceLang,
      markdown_chars: markdown.length,
      truncated,
      charge_id: billed.charge.charge_id ?? null,
    });

    const result: Record<string, unknown> = {
      ok: true,
      tool: "pdf_to_markdown_then_translate",
      task_id: create.taskId,
      target_lang: targetLang,
      source_lang: sourceLang,
      translated_markdown: translatedMarkdown,
      bilingual_markdown: bilingual,
      markdown_truncated: truncated,
      billing: billed.charge.charged > 0 ? "charged" : "free",
      charged_this_call: billed.charge.charged,
      ...(billed.charge.charge_id ? { charge_id: billed.charge.charge_id } : {}),
      compliance: COPYRIGHT_NOTICE,
    };
    if (includeSource) result.markdown = markdown;
    return result;
  } catch (error) {
    raiseAfterCharge(error, billed);
  }
}

/** Exported for gateway / unit tests. */
export { resolvePdfUrl, validatePdfUrl };
