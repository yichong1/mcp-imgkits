import { describe, expect, it } from "vitest";
import { translateDocument } from "../src/tools/translate-document";
import { translateImage } from "../src/tools/translate-image";
import { translateSubtitle } from "../src/tools/translate-subtitle";
import { translateText } from "../src/tools/translate-text";
import { detectLanguageTool } from "../src/tools/detect-language";
import { jsonResponse, mockFetch, testCtx, testEnv } from "./helpers";

function pathsOf(calls: Array<{ url: string }>): string[] {
  return calls.map((call) => new URL(call.url).pathname);
}

describe("translateText", () => {
  it("uses the gateway-trusted charge then calls the text endpoint", async () => {
    const { calls } = mockFetch((url) => {
      expect(url).toBe("https://text.test/translate/text");
      return jsonResponse({
        code: 0,
        msg: "ok",
        data: { result: [{ index: 0, translated: "你好" }] },
      });
    });
    const ctx = { ...testCtx, chargeId: "ch_gw_text" };

    const result = await translateText(ctx, {
      text: "Hello",
      from: "en",
      to: "zh",
      idempotency_key: "job-text-1",
    });

    expect(result.translation).toBe("你好");
    expect(result.idempotency_key).toBe("job-text-1");
    expect(result.charge).toEqual({ ok: true, charged: 1, charge_id: "ch_gw_text" });
    expect(pathsOf(calls)).toEqual(["/translate/text"]);
    expect(calls[0].init.headers).toMatchObject({ authorization: "Bearer test-upstream-token" });
    expect(calls.every((call) => !call.url.endsWith("/v1/charge"))).toBe(true);
  });

  it("works without a forwarded charge id and never contacts /v1/charge", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ code: 0, data: { result: [{ index: 0, translated: "Hola" }] } }),
    );

    const result = await translateText(testCtx, { text: "Hello", from: "en", to: "es" });

    expect(result.charge).toEqual({ ok: true, charged: 1 });
    expect(pathsOf(calls)).toEqual(["/translate/text"]);
  });

  it("rejects invalid input before any network call", async () => {
    const { calls } = mockFetch(() => jsonResponse({}));

    await expect(translateText(testCtx, { text: "", to: "zh" })).rejects.toThrow();
    await expect(translateText(testCtx, { text: "x", from: "en", to: "en" })).rejects.toThrow(/both 'en'/);
    expect(calls).toHaveLength(0);
  });

  it("fails before the upstream call when UPSTREAM_API_TOKEN is missing", async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const ctx = { ...testCtx, env: { ...testEnv, UPSTREAM_API_TOKEN: "" } };

    await expect(translateText(ctx, { text: "Hello", from: "en", to: "zh" })).rejects.toThrow(
      /UPSTREAM_API_TOKEN/,
    );
    expect(calls).toHaveLength(0);
  });

  it("maps an upstream 401 to a stable tool error without leaking the token", async () => {
    mockFetch(() => jsonResponse({ message: "Authorization: Bearer test-upstream-token" }, 401));
    let thrown: unknown;
    try {
      await translateText({ ...testCtx, chargeId: "ch_gw_text" }, { text: "Hello", from: "en", to: "zh" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "upstream_unauthorized",
      status: 401,
      details: { charge_id: "ch_gw_text" },
    });
    const blob = JSON.stringify(thrown);
    expect(blob).not.toContain("test-upstream-token");
    expect(blob).not.toMatch(/authorization/i);
    expect(blob).not.toMatch(/bearer/i);
  });
});

describe("translateDocument", () => {
  it("records the gateway charge, gets a cost, creates a job, and returns the result", async () => {
    const { calls } = mockFetch((url) => {
      const path = new URL(url).pathname;
      if (path === "/doc-translate/cost") {
        return jsonResponse({ code: 0, data: { charCount: 100, detail: { taskId: "task-1", price: 2 } } });
      }
      if (path === "/doc-translate/create") {
        return jsonResponse({ code: 0, data: { jobId: "job-1", status: 0, status_str: "waiting" } });
      }
      if (path === "/doc-translate/status") {
        return jsonResponse({
          code: 0,
          data: {
            status: 10,
            status_str: "done",
            result: "https://cdn.test/out.pdf",
            file: "https://docs.transmonkey.com/in.pdf",
            from: "en",
            to: "zh",
            fileName: "in.pdf",
          },
        });
      }
      return jsonResponse({ code: 1, msg: "unexpected route" });
    });
    const ctx = { ...testCtx, chargeId: "ch_gw_doc" };

    const result = await translateDocument(ctx, {
      doc_url: "https://docs.transmonkey.com/in.pdf",
      from: "en",
      to: "zh",
      file_name: "in.pdf",
      wait_seconds: 0,
      idempotency_key: "doc-job-1",
    });

    expect(result.status).toBe("done");
    expect(result.job_id).toBe("job-1");
    expect(result.result_urls).toEqual(["https://cdn.test/out.pdf"]);
    expect(result.charge).toEqual({ ok: true, charged: 5, charge_id: "ch_gw_doc" });
    expect(pathsOf(calls)).toEqual([
      "/doc-translate/cost",
      "/doc-translate/create",
      "/doc-translate/status",
    ]);
    expect(calls[0].body).toMatchObject({
      doc: "https://docs.transmonkey.com/in.pdf",
      from: "en",
      to: "zh",
      fileName: "in.pdf",
      fastCreation: 1,
    });
    expect(calls.every((call) => !call.url.endsWith("/v1/charge"))).toBe(true);
  });

  it("resumes an existing job_id without charging", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ code: 0, data: { status: 10, status_str: "done", result: "https://cdn.test/out.pdf" } }),
    );

    const result = await translateDocument(testCtx, { job_id: "job-existing", wait_seconds: 1 });
    expect(result.resumed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(pathsOf(calls)).toEqual(["/doc-translate/status"]);
    expect(calls[0].body).toEqual({ jobId: "job-existing" });
  });

  it("re-dispatches a queried job on resume, then polls to done", async () => {
    let statusCalls = 0;
    const { calls } = mockFetch((url) => {
      const path = new URL(url).pathname;
      if (path === "/doc-translate/create") {
        return jsonResponse({ code: 0, data: { jobId: "job-q" } });
      }
      statusCalls += 1;
      if (statusCalls === 1) {
        return jsonResponse({
          code: 0,
          data: {
            status: 1,
            status_str: "queried",
            file: "https://docs.transmonkey.com/in.pdf",
            from: "en",
            to: "zh",
            fileName: "in.pdf",
          },
        });
      }
      return jsonResponse({ code: 0, data: { status: 10, status_str: "done", result: "https://cdn.test/out.pdf" } });
    });

    const result = await translateDocument(testCtx, { job_id: "job-q", wait_seconds: 1 });
    expect(result.status).toBe("done");
    expect(pathsOf(calls)).toEqual([
      "/doc-translate/status",
      "/doc-translate/create",
      "/doc-translate/status",
    ]);
  });

  it("rejects private/local document URLs before any network call", async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    await expect(
      translateDocument(testCtx, {
        doc_url: "http://127.0.0.1/secret.pdf",
        from: "en",
        to: "zh",
        wait_seconds: 0,
      }),
    ).rejects.toThrow(/private or reserved IPv4/);
    expect(calls).toHaveLength(0);
  });

  it("requires doc_url and to for a new job", async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    await expect(translateDocument(testCtx, { wait_seconds: 0 })).rejects.toThrow(/doc_url/);
    expect(calls).toHaveLength(0);
  });
});

describe("translateImage", () => {
  it("records the gateway charge, creates an image job, and maps result_url objects", async () => {
    const { calls } = mockFetch((url) => {
      const path = new URL(url).pathname;
      if (path === "/img-translate/create") {
        return jsonResponse({ code: 0, data: { jobId: "img-1", status: 0, status_str: "waiting" } });
      }
      if (path === "/img-translate/status") {
        return jsonResponse({
          code: 0,
          data: {
            status: 10,
            status_str: "done",
            result: [{ result_url: "https://cdn.test/1.png" }, { result_url: "https://cdn.test/2.png" }],
          },
        });
      }
      return jsonResponse({ code: 1, msg: "unexpected route" });
    });

    const result = await translateImage(testCtx, {
      image_urls: ["https://images.transmonkey.com/a.png", "https://images.transmonkey.com/b.png"],
      from: "en",
      to: "zh",
      wait_seconds: 0,
      idempotency_key: "img-job-1",
    });

    expect(result.translated_image_urls).toEqual(["https://cdn.test/1.png", "https://cdn.test/2.png"]);
    expect(result.charge).toEqual({ ok: true, charged: 2 });
    expect(pathsOf(calls)).toEqual(["/img-translate/create", "/img-translate/status"]);
    expect(calls[0].body).toMatchObject({ imgs: ["https://images.transmonkey.com/a.png", "https://images.transmonkey.com/b.png"], paste: 1, font: "noto" });
    expect(calls.every((call) => !call.url.endsWith("/v1/charge"))).toBe(true);
  });

  it("polls an existing image job without charging", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ code: 0, data: { status: 10, status_str: "done", result: [{ result_url: "https://cdn.test/1.png" }] } }),
    );

    const result = await translateImage(testCtx, { job_id: "img-existing", wait_seconds: 1 });
    expect(result.resumed).toBe(true);
    expect(calls.every((call) => new URL(call.url).pathname === "/img-translate/status")).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/v1/charge"))).toBe(false);
  });
});

describe("translateSubtitle", () => {
  it("records the gateway charge once and preserves the SRT timeline", async () => {
    const srt = `1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:04,000 --> 00:00:06,000\nWorld\n`;
    const { calls } = mockFetch((_url, _init, body) => {
      const contents = (body as { contents: string[] }).contents;
      return jsonResponse({
        code: 0,
        data: {
          result: contents.map((text, index) => ({
            index,
            translated: text === "Hello" ? "你好" : "世界",
          })),
        },
      });
    });

    const result = await translateSubtitle(testCtx, {
      subtitle_content: srt,
      format: "srt",
      from: "en",
      to: "zh",
      idempotency_key: "sub-job-1",
    });

    expect(result.cue_count).toBe(2);
    expect(result.timeline_preserved).toBe(true);
    expect(result.translated_subtitle).toContain("00:00:01,000 --> 00:00:03,000\n你好");
    expect(result.translated_subtitle).toContain("00:00:04,000 --> 00:00:06,000\n世界");
    expect(result.charge).toEqual({ ok: true, charged: 3 });
    expect(pathsOf(calls)).toEqual(["/translate/text"]);
    expect(calls.every((call) => !call.url.endsWith("/v1/charge"))).toBe(true);
  });
});

describe("subtitle validation before billing", () => {
  it("rejects malformed subtitles without any network call", async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    await expect(
      translateSubtitle(testCtx, {
        subtitle_content: "1\nnot a timing line\n",
        format: "srt",
        from: "en",
        to: "zh",
      }),
    ).rejects.toThrow(/No SRT cues/);
    expect(calls).toHaveLength(0);
  });
});

describe("detectLanguageTool", () => {
  it("is free by default and makes no network call", async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    const result = await detectLanguageTool(testCtx, { text: "This is a test of the English language detector." });

    expect(result.billing).toBe("free");
    expect(result.language).toBe("en");
    expect(calls).toHaveLength(0);
  });

  it("records the gateway charge when COST_DETECT_LANGUAGE is above zero, without fetching", async () => {
    const ctx = {
      ...testCtx,
      env: { ...testEnv, COST_DETECT_LANGUAGE: "1" },
      chargeId: "ch_gw_detect",
    };
    const { calls } = mockFetch(() => jsonResponse({}));

    const result = await detectLanguageTool(ctx, { text: "这是一个测试", idempotency_key: "detect-1" });
    expect(result.billing).toBe("charged");
    expect(result.charge).toEqual({ ok: true, charged: 1, charge_id: "ch_gw_detect" });
    expect(calls).toHaveLength(0);
  });
});
