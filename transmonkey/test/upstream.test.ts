import { describe, expect, it } from "vitest";
import {
  chunkTextForUpstream,
  extractJobId,
  extractTaskId,
  extractTranslations,
  normalizeJobState,
  translateTexts,
  unwrapUpstream,
} from "../src/upstream";
import { headerOf, jsonResponse, mockFetch, testEnv } from "./helpers";

describe("upstream envelopes", () => {
  it("unwraps the ImgKits {code:0,data} envelope", () => {
    expect(unwrapUpstream({ code: 0, msg: "ok", data: { jobId: "j1" } })).toEqual({ jobId: "j1" });
  });

  it("unwraps {code:0,result}", () => {
    expect(unwrapUpstream({ code: 0, result: ["a"] })).toEqual(["a"]);
  });

  it("throws on code 1", () => {
    expect(() => unwrapUpstream({ code: 1, msg: "bad file" })).toThrow(/bad file/);
  });

  it("throws on HTTP-like error codes", () => {
    expect(() => unwrapUpstream({ code: 500, msg: "boom" })).toThrow(/boom/);
  });

  it("throws on explicit ok:false", () => {
    expect(() => unwrapUpstream({ ok: false, message: "no" })).toThrow(/no/);
  });

  it("extracts job and task ids", () => {
    expect(extractJobId({ data: { jobId: "job-1" } })).toBe("job-1");
    expect(extractTaskId({ detail: { taskId: "task-1" } })).toBe("task-1");
    expect(extractJobId({ job_id: "job-2" })).toBe("job-2");
  });
});

describe("text translations", () => {
  it("maps {result:[{index,translated}]} in index order", () => {
    const payload = {
      result: [
        { index: 1, translated: "B" },
        { index: 0, translated: "A" },
      ],
    };
    expect(extractTranslations(payload, 2)).toEqual(["A", "B"]);
  });

  it("maps a bare string array", () => {
    expect(extractTranslations({ result: ["甲", "乙"] }, 2)).toEqual(["甲", "乙"]);
  });

  it("throws when the result count does not match", () => {
    expect(() => extractTranslations({ result: [{ translated: "only" }] }, 2)).toThrow(/1 result/);
  });
});

describe("job status mapping", () => {
  it("maps doc/image status 10 to done", () => {
    const state = normalizeJobState({ status: 10, status_str: "done", result: "https://cdn.test/out.pdf" });
    expect(state.state).toBe("done");
    expect(state.result_urls).toEqual(["https://cdn.test/out.pdf"]);
  });

  it("maps image result objects to URLs", () => {
    const state = normalizeJobState({
      status: 10,
      result: [{ result_url: "https://cdn.test/1.png" }, { result_url: "https://cdn.test/2.png" }],
    });
    expect(state.result_urls).toEqual(["https://cdn.test/1.png", "https://cdn.test/2.png"]);
  });

  it("maps -1/-2 to failed", () => {
    expect(normalizeJobState({ status: -1, remark: "bad" }).state).toBe("failed");
    expect(normalizeJobState({ status: -2, status_str: "pay_expired" }).state).toBe("failed");
  });

  it("maps waiting/queried/translating to pending", () => {
    expect(normalizeJobState({ status: 0, status_str: "waiting" }).state).toBe("pending");
    expect(normalizeJobState({ status: 1, status_str: "queried" }).state).toBe("pending");
    expect(normalizeJobState({ status: 2, status_str: "translating" }).state).toBe("pending");
  });
});

describe("chunkTextForUpstream", () => {
  it("keeps every chunk under the upstream limit and preserves the original text", () => {
    const original = `${"First sentence. ".repeat(120)}\n\n${"第二句话。".repeat(200)}`;
    const plan = chunkTextForUpstream(original);
    expect(plan.chunks.every((chunk) => chunk.length <= 1900)).toBe(true);
    const rebuilt = plan.chunks.map((chunk, index) => chunk + plan.separators[index]).join("");
    expect(rebuilt).toBe(original);
  });

  it("does not split a short string", () => {
    expect(chunkTextForUpstream("hello")).toEqual({ chunks: ["hello"], separators: [""] });
  });
});

describe("translateTexts", () => {
  it("calls /translate/text with channel ai and the secret token", async () => {
    const { calls } = mockFetch((_url, _init, body) => {
      const contents = (body as { contents: string[] }).contents;
      return jsonResponse({
        code: 0,
        msg: "ok",
        data: { result: contents.map((_, index) => ({ index, translated: `T${index}` })) },
      });
    });

    const translations = await translateTexts(testEnv, {
      from: "en",
      to: "zh",
      texts: ["hello", "world"],
    });

    expect(translations).toEqual(["T0", "T1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://text.test/translate/text");
    expect(headerOf(calls[0], "channel")).toBe("ai");
    expect(headerOf(calls[0], "authorization")).toBe("Bearer test-upstream-token");
    expect(calls[0].body).toMatchObject({ from: "en", to: "zh", contents: ["hello", "world"] });
  });

  it("splits a long single input into multiple upstream contents", async () => {
    const seen: number[] = [];
    mockFetch((_url, _init, body) => {
      const contents = (body as { contents: string[] }).contents;
      seen.push(...contents.map((content) => content.length));
      return jsonResponse({
        code: 0,
        data: { result: contents.map((content, index) => ({ index, translated: content })) },
      });
    });

    const original = "A".repeat(3_900);
    const [translated] = await translateTexts(testEnv, { from: "en", to: "zh", texts: [original] });
    expect(translated.length).toBe(original.length);
    expect(seen.every((length) => length <= 1900)).toBe(true);
  });

  it("refuses to call upstream without UPSTREAM_API_TOKEN", async () => {
    const { fetchMock } = mockFetch(() => jsonResponse({ code: 0, data: { result: [] } }));
    await expect(
      translateTexts({ ...testEnv, UPSTREAM_API_TOKEN: "" }, { from: "en", to: "zh", texts: ["x"] }),
    ).rejects.toThrow(/UPSTREAM_API_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
