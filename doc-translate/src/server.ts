import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  COPYRIGHT_NOTICE,
  DEFAULT_WAIT_SECONDS,
  MAX_FILE_URL_CHARS,
  MAX_WAIT_SECONDS,
  SERVICE_NAME,
  SERVICE_VERSION,
  costFor,
} from "./config";
import type { ToolContext } from "./env";
import { toolErrorResult, toolJsonResult } from "./errors";
import {
  pdfToMarkdownThenTranslate,
  pdfToMarkdownThenTranslateInputSchema,
} from "./tools/pdf-to-markdown-then-translate";

function costLabel(cost: number): string {
  return cost === 0 ? "free" : `${cost} credit${cost === 1 ? "" : "s"}`;
}

export function createDocTranslateServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });

  const cost = costFor(ctx.env, "pdf_to_markdown_then_translate");
  server.registerTool(
    "pdf_to_markdown_then_translate",
    {
      title: "PDF → Markdown → Translate",
      description:
        `Convert a public PDF URL to Markdown via MinerU, then translate the markdown via the public text API. ` +
        `Pass \`file_url\` (or \`files\` with exactly 1 PDF http(s) URL; path must end in .pdf) and required \`target_lang\`. ` +
        `Optional: \`source_lang\` (default auto), \`include_source_markdown\` (default true), \`wait_seconds\` (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). ` +
        `URL max ${MAX_FILE_URL_CHARS} chars. Returns \`markdown\`, \`translated_markdown\`, \`bilingual_markdown\`, \`task_id\`, \`target_lang\`. ` +
        `Cost: ${costLabel(cost)} per call (MinerU 1 + translate_text 1), charged by mcp-credit-gateway before forwarding. ` +
        `DOCX input is not supported this wave. Compliance: ${COPYRIGHT_NOTICE}`,
      inputSchema: pdfToMarkdownThenTranslateInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof pdfToMarkdownThenTranslateInputSchema>) => {
      try {
        return toolJsonResult(await pdfToMarkdownThenTranslate(ctx, args));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}
