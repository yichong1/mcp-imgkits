import { describe, expect, it } from "vitest";
import {
  detectSubtitleFormat,
  parseSubtitle,
  translateSubtitleDocument,
} from "../src/subtitle";

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello

2
00:00:04,500 --> 00:00:06,000
World
`;

const VTT = `WEBVTT
Kind: captions

00:00:01.000 --> 00:00:03.000
Hello
`;

const ASS = `[Script Info]
Title: Test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Hello{\\i0}
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,World
`;

describe("subtitle format detection", () => {
  it("detects SRT, WebVTT and ASS", () => {
    expect(detectSubtitleFormat(SRT)).toBe("srt");
    expect(detectSubtitleFormat(VTT)).toBe("vtt");
    expect(detectSubtitleFormat(ASS)).toBe("ass");
  });

  it("honours an explicit format", () => {
    expect(detectSubtitleFormat("nonsense", "ass")).toBe("ass");
  });

  it("rejects content with no detectable format", () => {
    expect(() => detectSubtitleFormat("just prose")).toThrow(/Could not detect/);
  });
});

describe("SRT", () => {
  it("preserves indices and timestamps while replacing cue text", async () => {
    const result = await translateSubtitleDocument(SRT, "srt", async (texts) =>
      texts.map((text) => (text === "Hello" ? "你好" : "世界")),
    );

    expect(result.cue_count).toBe(2);
    expect(result.translated).toContain("1\n00:00:01,000 --> 00:00:03,000\n你好");
    expect(result.translated).toContain("2\n00:00:04,500 --> 00:00:06,000\n世界");
    expect(result.translated).not.toContain("Hello");
  });

  it("keeps static header/comment blocks", () => {
    const withNote = `NOTE keep me\n\n${SRT}`;
    const parsed = parseSubtitle(withNote, "srt");
    expect(parsed.render(new Map())).toContain("NOTE keep me");
  });
});

describe("WebVTT", () => {
  it("keeps the WEBVTT header and cue timing", async () => {
    const result = await translateSubtitleDocument(VTT, "vtt", async () => ["你好"]);
    expect(result.translated.startsWith("WEBVTT")).toBe(true);
    expect(result.translated).toContain("00:00:01.000 --> 00:00:03.000\n你好");
  });
});

describe("ASS", () => {
  it("preserves the timing, style fields and leading override tag", async () => {
    const result = await translateSubtitleDocument(ASS, "ass", async (texts) =>
      texts.map((text) => (text === "Hello" ? "你好" : "世界")),
    );

    expect(result.cue_count).toBe(2);
    expect(result.translated).toContain(
      "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}你好",
    );
    expect(result.translated).toContain("Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,世界");
    expect(result.translated).toContain("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
  });

  it("does not translate empty dialogue text", async () => {
    const empty = ASS.replace("World", "");
    const seen: string[] = [];
    const result = await translateSubtitleDocument(empty, "ass", async (texts) => {
      seen.push(...texts);
      return texts.map(() => "x");
    });
    expect(seen).toEqual(["Hello"]);
    expect(result.translated).toContain("Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,");
  });
});

describe("validation", () => {
  it("rejects empty subtitle content", () => {
    expect(() => parseSubtitle("", "srt")).toThrow(/must not be empty/);
  });

  it("rejects a file with no cues", () => {
    expect(() => parseSubtitle("1\nnot a timing line\n", "srt")).toThrow(/No SRT cues/);
  });
});
