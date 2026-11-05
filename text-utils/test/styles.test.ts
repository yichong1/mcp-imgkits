import { describe, expect, it } from "vitest";
import { convertStyle } from "../src/tools/styles";
import { countTextMetrics } from "../src/tools/count-text";

describe("convertStyle", () => {
  it("morse encodes SOS", () => {
    const out = convertStyle("SOS", "morse");
    expect(out.result).toBe("... --- ...");
  });

  it("binary encodes A", () => {
    const out = convertStyle("A", "binary");
    expect(out.result).toBe("01000001");
  });

  it("upper/lower/reverse/title", () => {
    expect(convertStyle("Hi There", "upper").result).toBe("HI THERE");
    expect(convertStyle("Hi There", "lower").result).toBe("hi there");
    expect(convertStyle("ab", "reverse").result).toBe("ba");
    expect(convertStyle("hello world", "title").result).toBe("Hello World");
  });

  it("fancy and old_english map letters", () => {
    expect(convertStyle("Ab", "fancy").result.length).toBeGreaterThan(0);
    expect(convertStyle("Ab", "old_english").result).not.toBe("Ab");
  });
});

describe("countTextMetrics", () => {
  it("counts latin and CJK", () => {
    const m = countTextMetrics("Hello 世界\n");
    expect(m.lines).toBe(2);
    expect(m.words).toBeGreaterThanOrEqual(3); // Hello + 世 + 界
    expect(m.characters).toBeGreaterThan(0);
  });
});
