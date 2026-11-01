import { describe, expect, it } from "vitest";
import {
  aiGet,
  aiPost,
  extractOutputUrl,
  extractTaskId,
  normalizeBlindWatermarkResult,
  pollJob,
  unwrapUpstream,
  withQuery,
} from "../src/upstream";
import { headerOf, jsonResponse, mockFetch, testEnv } from "./helpers";

describe("upstream envelopes", () => {
  it("unwraps the AiController {success,message,data} envelope", () => {
    expect(
      unwrapUpstream({ success: true, message: "", data: { targetUrl: "https://cdn.example.net/out.png" } }),
    ).toEqual({ targetUrl: "https://cdn.example.net/out.png" });
  });

  it("unwraps the ImgKits {code:0,data} envelope", () => {
    expect(unwrapUpstream({ code: 0, msg: "ok", data: { url: "https://cdn.example.net/out.png" } })).toEqual({
      url: "https://cdn.example.net/out.png",
    });
  });

  it("throws on success:false with the upstream message", () => {
    expect(() => unwrapUpstream({ success: false, message: "invalid image" })).toThrow(/invalid image/);
  });

  it("throws on HTTP-like error codes", () => {
    expect(() => unwrapUpstream({ code: 500, msg: "boom" })).toThrow(/boom/);
  });

  it("extracts output URLs and task ids from nested responses", () => {
    expect(extractOutputUrl({ data: { ImageURL: "https://cdn.example.net/out.png" } })).toBe(
      "https://cdn.example.net/out.png",
    );
    expect(extractOutputUrl({ data: { note: "no url" } })).toBeUndefined();
    expect(extractTaskId({ data: { taskId: "task-1" } })).toBe("task-1");
    expect(extractTaskId({ detail: { TaskId: "task-2" } })).toBe("task-2");
  });
});

describe("blind watermark result normalization", () => {
  it("maps a successful result with Content to done", () => {
    const result = normalizeBlindWatermarkResult({
      Status: "Success",
      Code: "Success",
      Content: "order-123",
      UserData: "u1",
    });
    expect(result).toMatchObject({ state: "done", content: "order-123", code: "Success", user_data: "u1" });
  });

  it("maps Processing to pending", () => {
    expect(normalizeBlindWatermarkResult({ Status: "Processing" }).state).toBe("pending");
  });

  it("maps Failed to failed with the message", () => {
    expect(normalizeBlindWatermarkResult({ Status: "Failed", Message: "no watermark" })).toMatchObject({
      state: "failed",
      message: "no watermark",
    });
  });

  it("treats a non-success Code without status as failed", () => {
    expect(normalizeBlindWatermarkResult({ Code: "InvalidImage.Download" }).state).toBe("failed");
  });

  it("treats bare Content as done", () => {
    expect(normalizeBlindWatermarkResult({ Content: "embedded" }).state).toBe("done");
  });

  it("maps numeric status codes", () => {
    expect(normalizeBlindWatermarkResult({ Status: "10" }).state).toBe("done");
    expect(normalizeBlindWatermarkResult({ Status: "-1" }).state).toBe("failed");
    expect(normalizeBlindWatermarkResult({ Status: "2" }).state).toBe("pending");
  });
});

describe("polling helpers", () => {
  it("appends to a path that already has a query string", () => {
    expect(withQuery("/index.php?r=ai/get", { taskId: "t1" })).toBe("/index.php?r=ai/get&taskId=t1");
    expect(withQuery("/api/status", { taskId: "t1" })).toBe("/api/status?taskId=t1");
  });

  it("polls until done", async () => {
    const states = ["pending", "pending", "done"] as const;
    let index = 0;
    const result = await pollJob(
      async () => ({ state: states[index++] ?? "done" }),
      { timeoutMs: 2_000, intervalMs: 50 },
    );
    expect(result.timed_out).toBe(false);
    expect(result.state.state).toBe("done");
  });

  it("returns the last snapshot when the deadline passes", async () => {
    const result = await pollJob(async () => ({ state: "pending" as const }), {
      timeoutMs: 0,
      intervalMs: 50,
    });
    expect(result.timed_out).toBe(true);
    expect(result.state.state).toBe("pending");
  });
});

describe("upstream HTTP", () => {
  it("POSTs JSON with the S2S Bearer and channel header", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ success: true, message: "", data: { targetUrl: "https://cdn.example.net/out.png" } }),
    );

    const payload = await aiPost(testEnv, "/api/watermark", { source_url: "https://assets.example.net/a.png" });

    expect(payload).toEqual({ targetUrl: "https://cdn.example.net/out.png" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ai.test/api/watermark");
    expect(calls[0].init.method).toBe("POST");
    expect(headerOf(calls[0], "authorization")).toBe("Bearer test-upstream-token");
    expect(headerOf(calls[0], "user-agent")).toBe("mcp-markany/0.1.0");
    expect(headerOf(calls[0], "channel")).toBe("ai");
    expect(calls[0].body).toEqual({ source_url: "https://assets.example.net/a.png" });
  });

  it("GETs a polling path with the same auth headers", async () => {
    const { calls } = mockFetch(() => jsonResponse({ success: true, message: "", data: { Status: "Success" } }));

    await aiGet(testEnv, withQuery("/index.php?r=ai/get-decode-blind-watermark", { taskId: "task-1" }));

    expect(calls[0].url).toBe("https://ai.test/index.php?r=ai/get-decode-blind-watermark&taskId=task-1");
    expect(calls[0].init.method).toBe("GET");
    expect(headerOf(calls[0], "authorization")).toBe("Bearer test-upstream-token");
  });

  it("rejects when UPSTREAM_API_TOKEN is missing without making a request", async () => {
    const { calls } = mockFetch(() => jsonResponse({}));
    await expect(aiPost({ ...testEnv, UPSTREAM_API_TOKEN: "" }, "/api/watermark", {})).rejects.toMatchObject({
      code: "upstream_not_configured",
    });
    expect(calls).toHaveLength(0);
  });
});
