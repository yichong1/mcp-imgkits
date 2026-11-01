import { ToolError } from "./errors";

export type SubtitleFormat = "srt" | "vtt" | "ass";

export interface SubtitleCue {
  key: number;
  text: string;
  render: (translated: string) => string;
}

export interface SubtitleDocument {
  format: SubtitleFormat;
  cues: SubtitleCue[];
  render: (translations: Map<number, string>) => string;
}

export interface SubtitleTranslationResult {
  translated: string;
  format: SubtitleFormat;
  cue_count: number;
  char_count: number;
}

function normalizeNewlines(content: string): { content: string; trailingNewline: boolean } {
  const withoutBom = content.replace(/^\uFEFF/, "");
  const normalized = withoutBom.replace(/\r\n?/g, "\n");
  return { content: normalized, trailingNewline: normalized.endsWith("\n") };
}

function detectTimedFormat(content: string): SubtitleFormat {
  const firstTiming = content.split("\n").find((line) => line.includes("-->"));
  if (firstTiming && /\d{2}:\d{2}:\d{2},\d{1,3}\s*-->/.test(firstTiming)) return "srt";
  return "vtt";
}

export function detectSubtitleFormat(content: string, hint: "auto" | SubtitleFormat = "auto"): SubtitleFormat {
  if (hint !== "auto") return hint;
  const trimmed = content.replace(/^\uFEFF/, "").trimStart();

  if (/^WEBVTT\b/i.test(trimmed)) return "vtt";
  if (/\[Script Info\]|\[Events\]|^Dialogue\s*:/im.test(trimmed)) return "ass";
  if (/-->/.test(trimmed)) return detectTimedFormat(trimmed);

  throw new ToolError(
    "Could not detect the subtitle format. Pass format='srt', 'vtt' or 'ass'.",
    "invalid_subtitle_format",
  );
}

function parseTimedText(content: string, format: "srt" | "vtt"): SubtitleDocument {
  const { content: normalized, trailingNewline } = normalizeNewlines(content);
  const blocks = normalized.split(/\n{2,}/);
  const rendered: Array<{ kind: "static"; text: string } | { kind: "cue"; cue: SubtitleCue }> = [];
  let cueKey = 0;

  for (const block of blocks) {
    if (block === "") continue;
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) {
      rendered.push({ kind: "static", text: block });
      continue;
    }

    const prefix = lines.slice(0, timingIndex + 1);
    const text = lines.slice(timingIndex + 1).join("\n");
    const key = cueKey++;
    const cue: SubtitleCue = {
      key,
      text,
      render: (translated: string) => [...prefix, translated].join("\n"),
    };
    rendered.push({ kind: "cue", cue });
  }

  const cues = rendered.filter((item): item is { kind: "cue"; cue: SubtitleCue } => item.kind === "cue").map((item) => item.cue);
  if (cues.length === 0) {
    throw new ToolError(
      `No ${format.toUpperCase()} cues with a timeline were found.`,
      "invalid_subtitle",
    );
  }

  return {
    format,
    cues,
    render: (translations: Map<number, string>) => {
      const body = rendered
        .map((item) =>
          item.kind === "static"
            ? item.text
            : item.cue.render(translations.get(item.cue.key) ?? item.cue.text),
        )
        .join("\n\n");
      return trailingNewline ? `${body}\n` : body;
    },
  };
}

function splitN(value: string, delimiter: string, count: number): string[] {
  if (count <= 1) return [value];
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < count - 1; i++) {
    const index = value.indexOf(delimiter, start);
    if (index === -1) break;
    parts.push(value.slice(start, index));
    start = index + delimiter.length;
  }
  parts.push(value.slice(start));
  return parts;
}

function stripAssMarkup(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

const DEFAULT_ASS_FIELDS = [
  "Layer",
  "Start",
  "End",
  "Style",
  "Name",
  "MarginL",
  "MarginR",
  "MarginV",
  "Effect",
  "Text",
];

function parseAss(content: string): SubtitleDocument {
  const { content: normalized, trailingNewline } = normalizeNewlines(content);
  const lines = normalized.split("\n");
  const eventsStart = lines.findIndex((line) => /^\[Events\]\s*$/i.test(line.trim()));
  if (eventsStart === -1) {
    throw new ToolError("ASS subtitle has no [Events] section.", "invalid_subtitle");
  }

  const formatLineIndex = lines.findIndex(
    (line, index) => index > eventsStart && /^Format\s*:/i.test(line.trim()),
  );
  const formatFields =
    formatLineIndex === -1
      ? DEFAULT_ASS_FIELDS
      : lines[formatLineIndex]
          .slice(lines[formatLineIndex].indexOf(":") + 1)
          .split(",")
          .map((field) => field.trim());

  const textIndex = Math.max(
    0,
    formatFields.findIndex((field) => field.toLowerCase() === "text") === -1
      ? formatFields.length - 1
      : formatFields.findIndex((field) => field.toLowerCase() === "text"),
  );

  const cues: SubtitleCue[] = [];
  const cueByLine = new Map<number, { cue: SubtitleCue; parts: string[]; textIndex: number }>();
  let cueKey = 0;

  for (let lineIndex = eventsStart + 1; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (/^\[[^\]]+\]\s*$/.test(line.trim())) break;
    if (!/^Dialogue\s*:/i.test(line)) continue;

    const payload = line.slice(line.indexOf(":") + 1).trimStart();
    const parts = splitN(payload, ",", formatFields.length);
    while (parts.length < formatFields.length) parts.push("");
    const assText = parts[textIndex] ?? "";
    const plain = stripAssMarkup(assText);
    const leadingTags = /^(?:\{[^}]*\})+/.exec(assText)?.[0] ?? "";
    const key = cueKey++;

    const cue: SubtitleCue = {
      key,
      text: plain,
      render: (translated: string) => {
        const updated = [...parts];
        updated[textIndex] = `${leadingTags}${translated.replace(/\r?\n/g, "\\N")}`;
        return `Dialogue: ${updated.join(",")}`;
      },
    };
    cues.push(cue);
    cueByLine.set(lineIndex, { cue, parts, textIndex });
  }

  if (cues.length === 0) {
    throw new ToolError("ASS subtitle has no Dialogue lines.", "invalid_subtitle");
  }

  return {
    format: "ass",
    cues,
    render: (translations: Map<number, string>) => {
      const output = [...lines];
      for (const [lineIndex, entry] of cueByLine) {
        output[lineIndex] = entry.cue.render(translations.get(entry.cue.key) ?? entry.cue.text);
      }
      const body = output.join("\n");
      return trailingNewline ? body : body.replace(/\n$/, "");
    },
  };
}

export function parseSubtitle(content: string, format: SubtitleFormat): SubtitleDocument {
  if (!content.trim()) throw new ToolError("Subtitle content must not be empty.", "invalid_subtitle");
  if (format === "srt" || format === "vtt") return parseTimedText(content, format);
  return parseAss(content);
}

/**
 * Parse, translate every non-empty cue once, and rebuild the subtitle with the
 * original timestamps, cue order, indices and ASS event fields.
 */
export async function translateSubtitleDocument(
  content: string,
  format: SubtitleFormat,
  translate: (texts: string[]) => Promise<string[]>,
): Promise<SubtitleTranslationResult> {
  const document = parseSubtitle(content, format);
  const translatable = document.cues.filter((cue) => cue.text.trim() !== "");
  const sourceTexts = translatable.map((cue) => cue.text);

  let translations: string[] = [];
  if (sourceTexts.length > 0) {
    translations = await translate(sourceTexts);
    if (translations.length !== sourceTexts.length) {
      throw new ToolError(
        `Subtitle translation returned ${translations.length} result(s) for ${sourceTexts.length} cue(s).`,
        "invalid_upstream_response",
      );
    }
  }

  const byCue = new Map<number, string>();
  translatable.forEach((cue, index) => byCue.set(cue.key, translations[index]));
  const translated = document.render(byCue);

  return {
    translated,
    format,
    cue_count: document.cues.length,
    char_count: sourceTexts.reduce((sum, text) => sum + text.length, 0),
  };
}
