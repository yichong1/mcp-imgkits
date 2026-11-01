import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SERVICE_NAME, SERVICE_VERSION, costFor } from "./config";
import type { ToolContext } from "./env";
import { toolErrorResult, toolJsonResult } from "./errors";
import { detectLanguageInputSchema, detectLanguageTool } from "./tools/detect-language";
import { translateDocument, translateDocumentInputSchema } from "./tools/translate-document";
import { translateImage, translateImageInputSchema } from "./tools/translate-image";
import { translateSubtitle, translateSubtitleInputSchema } from "./tools/translate-subtitle";
import { translateText, translateTextInputSchema } from "./tools/translate-text";

function costLabel(cost: number): string {
  return cost === 0 ? "free" : `${cost} credit${cost === 1 ? "" : "s"}`;
}

export function createTransMonkeyServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });
  const textCost = costFor(ctx.env, "translate_text");
  const documentCost = costFor(ctx.env, "translate_document");
  const imageCost = costFor(ctx.env, "translate_image");
  const subtitleCost = costFor(ctx.env, "translate_subtitle");
  const detectCost = costFor(ctx.env, "detect_language");

  server.registerTool(
    "translate_text",
    {
      title: "Translate text",
      description:
        `Translate up to 50,000 characters of plain text (up to 50 strings). ` +
        `Long inputs are split into <=1,900-character chunks automatically. ` +
        `Synchronous. Cost: ${costLabel(textCost)} per call; mcp-credit-gateway charges before forwarding the request. ` +
        `Requires Authorization: Bearer sk_live_... on the MCP endpoint.`,
      inputSchema: translateTextInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof translateTextInputSchema>) => {
      try {
        return toolJsonResult(await translateText(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "translate_document",
    {
      title: "Translate document",
      description:
        `Translate a document from a public URL. Supported formats include PDF, DOCX/DOC, XLSX/XLS, PPTX/PPT, EPUB, TXT, HTML, MD and CSV. ` +
        `Upstream size limits: PDF <= 30 MB, other formats <= 80 MB. ` +
        `This is an async job: the call waits up to wait_seconds (default 30, max 120) and returns a job_id if still running. ` +
        `Call again with the same job_id to poll; polling does not start a new translation job. ` +
        `Upstream deletes temporary/original files after processing and result URLs expire (about 24 hours), so download promptly. ` +
        `Cost: ${costLabel(documentCost)} per new job, charged by mcp-credit-gateway before forwarding the request.`,
      inputSchema: translateDocumentInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof translateDocumentInputSchema>) => {
      try {
        return toolJsonResult(await translateDocument(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "translate_image",
    {
      title: "Translate image text",
      description:
        `Translate text inside 1-10 images supplied as public URLs (JPG/PNG/WebP recommended; keep each image <= 10 MB). ` +
        `This is an async job: the call waits up to wait_seconds (default 30, max 120) and returns a job_id if still running. ` +
        `Call again with the same job_id to poll; polling does not start a new translation job. ` +
        `Upstream result URLs expire (about 24 hours), so download promptly. ` +
        `Cost: ${costLabel(imageCost)} per new job, charged by mcp-credit-gateway before forwarding the request.`,
      inputSchema: translateImageInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof translateImageInputSchema>) => {
      try {
        return toolJsonResult(await translateImage(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "translate_subtitle",
    {
      title: "Translate subtitle",
      description:
        `Translate SRT, WebVTT or ASS/SSA subtitle content (up to 1,000,000 characters). ` +
        `Timestamps, cue order, SRT/VTT indices and ASS event fields are preserved exactly; only cue text is translated. ` +
        `Synchronous. Cost: ${costLabel(subtitleCost)} per call, charged by mcp-credit-gateway before forwarding the request.`,
      inputSchema: translateSubtitleInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof translateSubtitleInputSchema>) => {
      try {
        return toolJsonResult(await translateSubtitle(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "detect_language",
    {
      title: "Detect language",
      description:
        `Detect the language of up to 20,000 characters. Uses a local Unicode-script + stopword/diacritic heuristic; no upstream call. ` +
        `Returns a language code, confidence, reliability flag and alternatives. ` +
        `Billing: ${costLabel(detectCost)} by default (COST_DETECT_LANGUAGE=0).`,
      inputSchema: detectLanguageInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: z.infer<typeof detectLanguageInputSchema>) => {
      try {
        return toolJsonResult(await detectLanguageTool(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}
