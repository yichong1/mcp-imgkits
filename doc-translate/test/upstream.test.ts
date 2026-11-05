import { describe, expect, it } from "vitest";
import {
  chunkTextForUpstream,
  collectMineruMarkdown,
  extractTranslations,
  normalizeMineruState,
  unwrapUpstream,
} from "../src/upstream";

describe("upstream envelopes", () => {
  it("unwraps ImgKits {code:0,data}", () => {
    expect(unwrapUpstream({ code: 0, msg: "ok", data: { task_id: "t1" } })).toEqual({ task_id: "t1" });
  });
  it("throws on code:1", () => {
    expect(() => unwrapUpstream({ code: 1, msg: "bad" })).toThrow(/bad/);
  });
});

describe("mineru normalize", () => {
  it("detects done via results map", () => {
    const state = normalizeMineruState({
      results: { "a.pdf": { md_content: "# Hi" } },
      task_id: "t1",
    });
    expect(state.state).toBe("done");
    if (state.state === "done") {
      expect(collectMineruMarkdown(state.data)[0].markdown).toBe("# Hi");
    }
  });
});

describe("translate extract + chunk", () => {
  it("extracts indexed translations", () => {
    expect(
      extractTranslations({ result: [{ index: 0, translated: "A" }, { index: 1, translated: "B" }] }, 2),
    ).toEqual(["A", "B"]);
  });
  it("chunks long text", () => {
    const text = "a".repeat(2000);
    const plan = chunkTextForUpstream(text, 1900);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks.join("").length + plan.separators.join("").length).toBeGreaterThanOrEqual(2000);
  });
});
