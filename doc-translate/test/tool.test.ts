import { describe, expect, it } from "vitest";
import { pdfToMarkdownThenTranslate } from "../src/tools/pdf-to-markdown-then-translate";
import { validatePdfUrl } from "../src/tools/common";
import { jsonResponse, mockFetch, testCtx, headerOf } from "./helpers";

describe("validatePdfUrl", () => {
  it("accepts https pdf", () => {
    expect(validatePdfUrl("https://example.com/a/b.pdf", "file_url", 2048)).toBe(
      "https://example.com/a/b.pdf",
    );
  });
  it("rejects non-pdf", () => {
    expect(() => validatePdfUrl("https://example.com/a.docx", "file_url", 2048)).toThrow(/pdf/i);
  });
  it("rejects non-http", () => {
    expect(() => validatePdfUrl("ftp://example.com/a.pdf", "file_url", 2048)).toThrow(/http/i);
  });
});

describe("pdf_to_markdown_then_translate", () => {
  it("creates mineru, polls, translates, returns bilingual", async () => {
    let polls = 0;
    const { calls } = mockFetch((url, init) => {
      if (url.endsWith("/api/mineru/create")) {
        expect(headerOf(init, "authorization")).toBe("Bearer test-upstream-token");
        return jsonResponse({
          code: 0,
          data: { task_id: "task-1", status: 0, status_str: "waiting" },
        });
      }
      if (url.includes("/api/mineru/result/")) {
        expect(headerOf(init, "authorization")).toBe("Bearer test-upstream-token");
        polls += 1;
        if (polls < 2) {
          return jsonResponse({
            code: 0,
            data: { task_id: "task-1", status: 4, status_str: "processing" },
          });
        }
        return jsonResponse({
          code: 0,
          data: {
            task_id: "task-1",
            status: 10,
            status_str: "done",
            result: {
              results: {
                "dummy.pdf": { md_content: "Hello world.\n\nSecond paragraph." },
              },
            },
          },
        });
      }
      if (url.endsWith("/translate/text")) {
        expect(headerOf(init, "authorization")).toBeNull();
        const body = init.body ? JSON.parse(String(init.body)) : {};
        expect(body.to).toBe("zh");
        return jsonResponse({
          code: 0,
          data: { result: [{ index: 0, translated: "你好世界。\n\n第二段。" }] },
        });
      }
      return jsonResponse({ code: 1, msg: `unexpected ${url}` }, 404);
    });

    const result = await pdfToMarkdownThenTranslate(testCtx, {
      file_url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
      target_lang: "zh",
      include_source_markdown: true,
      wait_seconds: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.task_id).toBe("task-1");
    expect(result.markdown).toContain("Hello world");
    expect(result.translated_markdown).toContain("你好");
    expect(result.bilingual_markdown).toBeTruthy();
    expect(result.charged_this_call).toBe(2);
    expect(calls.some((c) => c.url.includes("/translate/text"))).toBe(true);
  });

  it("rejects non-pdf before upstream", async () => {
    const { calls } = mockFetch(() => jsonResponse({ code: 0, data: {} }));
    await expect(
      pdfToMarkdownThenTranslate(testCtx, {
        file_url: "https://example.com/doc.docx",
        target_lang: "en",
        include_source_markdown: true,
        wait_seconds: 5,
      }),
    ).rejects.toThrow(/pdf/i);
    expect(calls.length).toBe(0);
  });
});
