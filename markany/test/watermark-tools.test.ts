import { beforeEach, describe, expect, it } from "vitest";
import { toolErrorResult } from "../src/errors";
import { resetRemoveWatermarkRateLimits } from "../src/rate-limit";
import { addWatermark, addWatermarkInputSchema } from "../src/tools/add-watermark";
import { decodeBlindWatermark, decodeBlindWatermarkInputSchema } from "../src/tools/decode-blind-watermark";
import { embedBlindWatermark, embedBlindWatermarkInputSchema } from "../src/tools/embed-blind-watermark";
import { removeWatermark, removeWatermarkInputSchema } from "../src/tools/remove-watermark";
import { headerOf, jsonResponse, mockFetch, testCtx, testEnv } from "./helpers";

const SOURCE_IMAGE = "https://assets.imgkits.com/source.png";
const SOURCE_PDF = "https://assets.imgkits.com/report.pdf";
const WATERMARK_IMAGE = "https://cdn.imgkits.com/logo.png";
const RESULT_IMAGE = "https://cdn.imgkits.com/result.png";

function okData(data: unknown): Response {
  return jsonResponse({ success: true, message: "", data });
}

describe("add_watermark", () => {
  it("stamps text on an image and returns the result URL plus charge metadata", async () => {
    const { calls } = mockFetch(() => okData({ targetUrl: RESULT_IMAGE, RequestId: "req-add-1" }));

    const input = addWatermarkInputSchema.parse({
      source_url: SOURCE_IMAGE,
      watermark_type: "text",
      text: "© Acme 2026",
      idempotency_key: "job-add-1",
    });
    const result = await addWatermark(testCtx, input);

    expect(result).toMatchObject({
      ok: true,
      tool: "add_watermark",
      source_url: SOURCE_IMAGE,
      source_type: "image",
      watermark_type: "text",
      position: "bottom-right",
      opacity: 0.35,
      result_url: RESULT_IMAGE,
      request_id: "req-add-1",
      idempotency_key: "job-add-1",
      charge: { ok: true, charged: 2, charge_id: "ch_test_123" },
    });
    expect(String(result.audit_id)).toMatch(/^aud_/);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ai.test/api/watermark");
    expect(headerOf(calls[0], "authorization")).toBe("Bearer test-upstream-token");
    expect(calls[0].body).toMatchObject({
      source_url: SOURCE_IMAGE,
      source_type: "image",
      type: "text",
      text: "© Acme 2026",
      position: "bottom-right",
      opacity: 0.35,
    });
    expect(calls.every((call) => !call.url.includes("/v1/charge"))).toBe(true);
  });

  it("supports an image watermark on a PDF page range", async () => {
    const { calls } = mockFetch(() => okData({ targetUrl: "https://cdn.imgkits.com/report-watermarked.pdf" }));

    const input = addWatermarkInputSchema.parse({
      source_url: SOURCE_PDF,
      watermark_type: "image",
      watermark_image_url: WATERMARK_IMAGE,
      position: "center",
      opacity: 0.5,
      scale: 0.3,
      pages: "1-3,5",
    });
    const result = await addWatermark(testCtx, input);

    expect(result).toMatchObject({ source_type: "pdf", pages: "1-3,5", position: "center" });
    expect(calls[0].body).toMatchObject({
      source_type: "pdf",
      type: "image",
      watermark_image: WATERMARK_IMAGE,
      scale: 0.3,
      pages: "1-3,5",
    });
  });

  it("honours AI_BASE_URL and ADD_WATERMARK_PATH overrides", async () => {
    const { calls } = mockFetch(() => okData({ targetUrl: RESULT_IMAGE }));
    const ctx = {
      ...testCtx,
      env: { ...testEnv, AI_BASE_URL: "https://ai-alt.example.net", ADD_WATERMARK_PATH: "/v2/watermark" },
    };
    const input = addWatermarkInputSchema.parse({
      source_url: SOURCE_IMAGE,
      watermark_type: "text",
      text: "hello",
    });

    await addWatermark(ctx, input);
    expect(calls[0].url).toBe("https://ai-alt.example.net/v2/watermark");
  });

  it("rejects missing text, image fields on text mode, and pages on images without calling upstream", async () => {
    const { calls } = mockFetch(() => okData({}));

    await expect(
      addWatermark(
        testCtx,
        addWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE, watermark_type: "text" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments" });

    await expect(
      addWatermark(
        testCtx,
        addWatermarkInputSchema.parse({
          source_url: SOURCE_IMAGE,
          watermark_type: "text",
          text: "x",
          watermark_image_url: WATERMARK_IMAGE,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments" });

    await expect(
      addWatermark(
        testCtx,
        addWatermarkInputSchema.parse({
          source_url: SOURCE_IMAGE,
          watermark_type: "text",
          text: "x",
          pages: "1-2",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments" });

    expect(calls).toHaveLength(0);
  });

  it("rejects private source URLs before calling upstream", async () => {
    const { calls } = mockFetch(() => okData({}));
    const input = addWatermarkInputSchema.parse({
      source_url: "http://169.254.169.254/latest/meta-data",
      watermark_type: "text",
      text: "x",
    });
    await expect(addWatermark(testCtx, input)).rejects.toMatchObject({ code: "blocked_url" });
    expect(calls).toHaveLength(0);
  });
});

describe("remove_watermark", () => {
  beforeEach(() => {
    resetRemoveWatermarkRateLimits();
  });

  it("sends img + mask + bucket and always returns the copyright gate", async () => {
    const mask = "https://cdn.imgkits.com/mask.png";
    const { calls } = mockFetch(() => okData({ url: RESULT_IMAGE }));

    const input = removeWatermarkInputSchema.parse({
      source_url: SOURCE_IMAGE,
      mask_image_url: mask,
      confirm_authorization: true,
    });
    const result = await removeWatermark(testCtx, input);

    expect(result).toMatchObject({
      ok: true,
      tool: "remove_watermark",
      mask_mode: "mask_url",
      bucket: "imgkits",
      result_url: RESULT_IMAGE,
      charge: { charged: 3, charge_id: "ch_test_123" },
    });
    expect(String(result.copyright)).toMatch(/only on images you own/i);
    expect(calls[0].url).toBe("https://ai.test/api/inpaint");
    expect(calls[0].body).toEqual({ img: SOURCE_IMAGE, bucket: "imgkits", mask });
    expect(calls.every((call) => !call.url.includes("/v1/charge"))).toBe(true);
  });

  it("supports a normalized rectangular mask and an automatic mode", async () => {
    const first = mockFetch(() => okData({ url: RESULT_IMAGE }));
    const rectInput = removeWatermarkInputSchema.parse({
      source_url: SOURCE_IMAGE,
      mask_rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
      bucket: "custom-bucket",
      confirm_authorization: true,
    });
    const rectResult = await removeWatermark(testCtx, rectInput);

    expect(rectResult).toMatchObject({ mask_mode: "mask_rect", bucket: "custom-bucket" });
    expect(first.calls[0].body).toMatchObject({
      img: SOURCE_IMAGE,
      bucket: "custom-bucket",
      mask_rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
    });

    const second = mockFetch(() => okData({ url: RESULT_IMAGE }));
    const autoInput = removeWatermarkInputSchema.parse({
      source_url: SOURCE_IMAGE,
      confirm_authorization: true,
    });
    const autoResult = await removeWatermark(testCtx, autoInput);

    expect(autoResult).toMatchObject({ mask_mode: "auto" });
    const body = second.calls[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ img: SOURCE_IMAGE, bucket: "imgkits" });
    expect("mask" in body).toBe(false);
    expect("mask_rect" in body).toBe(false);
  });

  it("rejects both mask forms and out-of-bounds rectangles without calling upstream", async () => {
    const { calls } = mockFetch(() => okData({}));

    const both = removeWatermarkInputSchema.parse({
      source_url: SOURCE_IMAGE,
      mask_image_url: "https://cdn.imgkits.com/mask.png",
      mask_rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    await expect(removeWatermark(testCtx, both)).rejects.toMatchObject({ code: "invalid_arguments" });

    expect(() =>
      removeWatermarkInputSchema.parse({
        source_url: SOURCE_IMAGE,
        mask_rect: { x: 0.8, y: 0.8, width: 0.5, height: 0.5 },
      }),
    ).toThrow();

    expect(calls).toHaveLength(0);
  });

  it("rejects a missing or false authorization confirmation without calling upstream", async () => {
    const { calls } = mockFetch(() => okData({ url: RESULT_IMAGE }));

    const omitted = removeWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE });
    expect(omitted.confirm_authorization).toBe(false);
    await expect(removeWatermark(testCtx, omitted)).rejects.toMatchObject({
      code: "authorization_required",
      details: { copyright: expect.stringMatching(/only on images you own/i) },
    });

    const explicit = removeWatermarkInputSchema.parse({
      source_url: SOURCE_IMAGE,
      confirm_authorization: false,
    });
    await expect(removeWatermark(testCtx, explicit)).rejects.toMatchObject({ code: "authorization_required" });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(explicit)).not.toContain(testCtx.authToken);
  });

  it("does not let unconfirmed calls consume the caller rate limit", async () => {
    const { calls } = mockFetch(() => okData({ url: RESULT_IMAGE }));
    const ctx = {
      ...testCtx,
      env: { ...testEnv, REMOVE_WATERMARK_RATE_LIMIT: "1" },
    };
    const denied = removeWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE, confirm_authorization: false });
    await expect(removeWatermark(ctx, denied)).rejects.toMatchObject({ code: "authorization_required" });
    await expect(removeWatermark(ctx, denied)).rejects.toMatchObject({ code: "authorization_required" });

    const allowed = removeWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE, confirm_authorization: true });
    const result = await removeWatermark(ctx, allowed);
    expect(result.copyright).toMatch(/only on images you own/i);
    expect(calls).toHaveLength(1);
  });

  it("returns 429 once a caller key exceeds the sliding window and keeps copyright", async () => {
    const { calls } = mockFetch(() => okData({ url: RESULT_IMAGE }));
    const ctx = {
      ...testCtx,
      env: { ...testEnv, REMOVE_WATERMARK_RATE_LIMIT: "2", REMOVE_WATERMARK_RATE_WINDOW_MS: "60000" },
    };
    const input = removeWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE, confirm_authorization: true });

    await removeWatermark(ctx, input);
    await removeWatermark(ctx, input);
    let thrown: unknown;
    try {
      await removeWatermark(ctx, input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "rate_limited",
      status: 429,
      details: {
        copyright: expect.stringMatching(/only on images you own/i),
        limit: 2,
        window_ms: 60_000,
      },
    });
    expect(calls).toHaveLength(2);
    const mcpError = toolErrorResult(thrown);
    const structured = mcpError.structuredContent as {
      error: { code: string; status: number; message: string; details: { copyright: string } };
    };
    expect(mcpError.isError).toBe(true);
    expect(structured.error).toMatchObject({ code: "rate_limited", status: 429 });
    expect(structured.error.details.copyright).toMatch(/only on images you own/i);
    const payload = JSON.stringify(mcpError);
    expect(payload).not.toContain(testCtx.authToken);
    expect(payload).not.toContain("test-upstream-token");
    expect(payload).not.toMatch(/authorization/i);
  });

  it("rate-limits each caller key separately", async () => {
    const { calls } = mockFetch(() => okData({ url: RESULT_IMAGE }));
    const env = { ...testEnv, REMOVE_WATERMARK_RATE_LIMIT: "1" };
    const input = removeWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE, confirm_authorization: true });
    const first = { ...testCtx, authToken: "sk_live_caller_a", env };
    const second = { ...testCtx, authToken: "sk_live_caller_b", env };

    await removeWatermark(first, input);
    await removeWatermark(second, input);
    await expect(removeWatermark(first, input)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toContain("sk_live_caller_a");
  });

  it("rejects a missing UPSTREAM_API_TOKEN before any upstream call", async () => {
    const { calls } = mockFetch(() => okData({ url: RESULT_IMAGE }));
    const ctx = { ...testCtx, env: { ...testEnv, UPSTREAM_API_TOKEN: "  " } };
    const input = removeWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE, confirm_authorization: true });
    await expect(removeWatermark(ctx, input)).rejects.toMatchObject({ code: "upstream_not_configured" });
    expect(calls).toHaveLength(0);
  });
});

describe("embed_blind_watermark", () => {
  it("embeds caller content through the AiController payload shape without echoing it", async () => {
    const { calls } = mockFetch(() => okData({ targetUrl: "https://cdn.imgkits.com/blind.png", RequestId: "req-1" }));
    const secretText = "order-123-secret";

    const input = embedBlindWatermarkInputSchema.parse({
      source_url: SOURCE_IMAGE,
      watermark_text: secretText,
      strength: 4,
    });
    const result = await embedBlindWatermark(testCtx, input);

    expect(result).toMatchObject({
      ok: true,
      tool: "embed_blind_watermark",
      target_url: "https://cdn.imgkits.com/blind.png",
      watermark_source: "caller",
      watermark_chars: secretText.length,
      model: "DWT",
      strength: 4,
      request_id: "req-1",
      charge: { charged: 2, charge_id: "ch_test_123" },
    });
    expect(JSON.stringify(result)).not.toContain(secretText);

    expect(calls[0].url).toBe("https://ai.test/index.php?r=ai/encode-blind-watermark");
    expect(calls[0].body).toMatchObject({
      payload: { SourceURI: SOURCE_IMAGE, Content: secretText, Model: "DWT", Strength: 4 },
    });
  });

  it("uses the server-held BLIND_WATERMARK_KEY when watermark_text is omitted", async () => {
    const { calls } = mockFetch(() => okData({ targetUrl: "https://cdn.imgkits.com/blind.png" }));
    const serverKey = "server-held-watermark-content";
    const ctx = { ...testCtx, env: { ...testEnv, BLIND_WATERMARK_KEY: serverKey } };

    const result = await embedBlindWatermark(
      ctx,
      embedBlindWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE }),
    );

    expect(result).toMatchObject({ watermark_source: "server_key", watermark_chars: serverKey.length });
    expect(JSON.stringify(result)).not.toContain(serverKey);
    expect(calls[0].body).toMatchObject({ payload: { SourceURI: SOURCE_IMAGE, Content: serverKey } });
  });

  it("requires watermark_text or BLIND_WATERMARK_KEY without calling upstream", async () => {
    const { calls } = mockFetch(() => okData({}));
    await expect(
      embedBlindWatermark(testCtx, embedBlindWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE })),
    ).rejects.toMatchObject({ code: "watermark_content_missing" });
    expect(calls).toHaveLength(0);
  });
});

describe("decode_blind_watermark", () => {
  it("creates a decode task from source_url and polls it to completion", async () => {
    const { calls } = mockFetch((url, init) => {
      if (init.method === "POST") return okData({ taskId: "task-1" });
      if (url.includes("get-decode-blind-watermark")) {
        return okData({ Status: "Success", Code: "Success", Content: "order-123", UserData: "u1" });
      }
      return jsonResponse({ success: false, message: "unexpected" }, 500);
    });

    const result = await decodeBlindWatermark(
      testCtx,
      decodeBlindWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE }),
    );

    expect(result).toMatchObject({
      ok: true,
      tool: "decode_blind_watermark",
      job_id: "task-1",
      created: true,
      state: "done",
      timed_out: false,
      content: "order-123",
      user_data: "u1",
      wait_seconds: 15,
      charge: { charged: 2, charge_id: "ch_test_123" },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://ai.test/index.php?r=ai/decode-blind-watermark");
    expect(calls[0].body).toEqual({ url: SOURCE_IMAGE });
    expect(calls[1].url).toContain("get-decode-blind-watermark");
    expect(calls[1].url).toContain("taskId=task-1");
    expect(calls[1].init.method).toBe("GET");
  });

  it("polls an existing job_id without creating a new task", async () => {
    const { calls } = mockFetch(() => okData({ Status: "Success", Code: "Success", Content: "embedded-id" }));

    const result = await decodeBlindWatermark(
      testCtx,
      decodeBlindWatermarkInputSchema.parse({ job_id: "task-existing", wait_seconds: 3 }),
    );

    expect(result).toMatchObject({ job_id: "task-existing", created: false, state: "done", content: "embedded-id" });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].url).toContain("taskId=task-existing");
  });

  it("returns a retry-able job_id when the decode is still processing", async () => {
    const { calls } = mockFetch(() => okData({ Status: "Processing" }));

    const result = await decodeBlindWatermark(
      testCtx,
      decodeBlindWatermarkInputSchema.parse({ job_id: "task-slow", wait_seconds: 0 }),
    );

    expect(result).toMatchObject({
      state: "pending",
      timed_out: true,
      content: null,
      job_id: "task-slow",
      retry: { tool: "decode_blind_watermark", arguments: { job_id: "task-slow" } },
    });
    expect(calls).toHaveLength(1);
  });

  it("turns an upstream failure into an auditable post-charge error", async () => {
    mockFetch(() => okData({ Status: "Failed", Message: "no watermark found" }));

    await expect(
      decodeBlindWatermark(
        testCtx,
        decodeBlindWatermarkInputSchema.parse({ job_id: "task-failed" }),
      ),
    ).rejects.toMatchObject({
      code: "tool_failed_after_charge",
      details: { charge_id: "ch_test_123" },
    });
  });

  it("requires exactly one of source_url and job_id", async () => {
    const { calls } = mockFetch(() => okData({}));

    await expect(
      decodeBlindWatermark(testCtx, decodeBlindWatermarkInputSchema.parse({})),
    ).rejects.toMatchObject({ code: "invalid_arguments" });

    await expect(
      decodeBlindWatermark(
        testCtx,
        decodeBlindWatermarkInputSchema.parse({ source_url: SOURCE_IMAGE, job_id: "task-1" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments" });

    await expect(
      decodeBlindWatermark(
        testCtx,
        decodeBlindWatermarkInputSchema.parse({ job_id: "bad id with spaces" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_job_id" });

    expect(calls).toHaveLength(0);
  });
});
