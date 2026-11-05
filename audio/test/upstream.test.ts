import { describe, expect, it } from "vitest";
import {
  apiPost,
  extractAudioUrl,
  extractJobId,
  normalizeAsyncJob,
  extractStemUrls,
  normalizeTangoFluxResult,
  pollJob,
  unwrapUpstream,
} from "../src/upstream";
import { headerOf, jsonResponse, mockFetch, testEnv } from "./helpers";

describe("upstream envelopes", () => {
  it("unwraps ImgKits {code:0,data} envelope", () => {
    expect(
      unwrapUpstream({
        code: 0,
        msg: "ok",
        data: { jobId: "j1", status: 0, result: null },
      }),
    ).toEqual({ jobId: "j1", status: 0, result: null });
  });

  it("throws on code:1", () => {
    expect(() => unwrapUpstream({ code: 1, msg: "bad prompt" })).toThrow(/bad prompt/);
  });

  it("extracts jobId and audio URL from result string", () => {
    expect(extractJobId({ jobId: "abc-123" })).toBe("abc-123");
    expect(
      extractAudioUrl({
        jobId: "abc-123",
        status: 10,
        result: "https://cdn.example.net/tangoflux/abc-123.wav",
      }),
    ).toBe("https://cdn.example.net/tangoflux/abc-123.wav");
  });
});

describe("tangoflux result normalization", () => {
  it("maps status 0/4 to pending, 10 to done, -1 to failed", () => {
    expect(normalizeTangoFluxResult({ status: 0, status_str: "waiting", jobId: "j1" }).state).toBe("pending");
    expect(normalizeTangoFluxResult({ status: 4, status_str: "processing", jobId: "j1" }).state).toBe("pending");
    expect(
      normalizeTangoFluxResult({
        status: 10,
        status_str: "done",
        jobId: "j1",
        result: "https://cdn.example.net/a.wav",
        duration: 10,
        steps: 25,
      }),
    ).toMatchObject({
      state: "done",
      audio_url: "https://cdn.example.net/a.wav",
      duration: 10,
      steps: 25,
    });
    expect(normalizeTangoFluxResult({ status: -1, status_str: "fail", remark: "gpu down" })).toMatchObject({
      state: "failed",
      remark: "gpu down",
    });
  });
});

describe("pollJob", () => {
  it("returns on first non-pending snapshot", async () => {
    let n = 0;
    const result = await pollJob(
      async () => {
        n += 1;
        return { state: n < 2 ? ("pending" as const) : ("done" as const) };
      },
      { timeoutMs: 1000, intervalMs: 10 },
    );
    expect(result).toEqual({ state: { state: "done" }, timed_out: false });
    expect(n).toBe(2);
  });

  it("times out while pending", async () => {
    const result = await pollJob(async () => ({ state: "pending" as const }), {
      timeoutMs: 30,
      intervalMs: 10,
    });
    expect(result.timed_out).toBe(true);
    expect(result.state.state).toBe("pending");
  });
});

describe("apiPost auth", () => {
  it("attaches Bearer when UPSTREAM_ATTACH_AUTH=1", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ code: 0, data: { jobId: "j1", status: 0, result: null } }),
    );
    await apiPost(testEnv, "/api/tangoflux/create", { prompt: "rain", duration: 10, steps: 25, from_app: "mcp-audio" });
    expect(calls[0]?.url).toBe("https://api.test/api/tangoflux/create");
    expect(headerOf(calls[0]!, "authorization")).toBe("Bearer test-upstream-token");
    expect(calls[0]?.body).toMatchObject({ from_app: "mcp-audio" });
  });
});

describe("normalizeAsyncJob / extractStemUrls", () => {
  it("maps status codes and stem urls", () => {
    expect(normalizeAsyncJob({ status: 0 }).state).toBe("pending");
    expect(normalizeAsyncJob({ status: 6, status_str: "merging" }).state).toBe("pending");
    expect(normalizeAsyncJob({ status: 10, status_str: "done" }).state).toBe("done");
    expect(normalizeAsyncJob({ status: -1, remark: "boom" })).toMatchObject({ state: "failed", remark: "boom" });
    expect(
      extractStemUrls({
        status: 10,
        result: {
          vocals: "https://cdn.example.net/v.wav",
          accompaniment: "https://cdn.example.net/a.wav",
          zip_url: "https://cdn.example.net/z.zip",
        },
      }),
    ).toEqual({
      vocals: "https://cdn.example.net/v.wav",
      accompaniment: "https://cdn.example.net/a.wav",
      zip_url: "https://cdn.example.net/z.zip",
    });
  });
});
