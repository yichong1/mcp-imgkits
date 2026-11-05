import type { StyleMode } from "../config";

/** ITU Morse for A–Z / 0–9. Letters lowercase-normalized; others skipped. */
const MORSE: Record<string, string> = {
  a: ".-",
  b: "-...",
  c: "-.-.",
  d: "-..",
  e: ".",
  f: "..-.",
  g: "--.",
  h: "....",
  i: "..",
  j: ".---",
  k: "-.-",
  l: ".-..",
  m: "--",
  n: "-.",
  o: "---",
  p: ".--.",
  q: "--.-",
  r: ".-.",
  s: "...",
  t: "-",
  u: "..-",
  v: "...-",
  w: ".--",
  x: "-..-",
  y: "-.--",
  z: "--..",
  "0": "-----",
  "1": ".----",
  "2": "..---",
  "3": "...--",
  "4": "....-",
  "5": ".....",
  "6": "-....",
  "7": "--...",
  "8": "---..",
  "9": "----.",
};

/** Mathematical Bold Fraktur / Blackletter-ish for old_english feel (A–Z / a–z). */
function toOldEnglishChar(ch: string): string | null {
  const code = ch.codePointAt(0);
  if (code === undefined) return null;
  // Mathematical Fraktur Capitals A–Z: U+1D504..U+1D51C (with holes for C/H/I/R)
  // Use Fraktur where available; fall back to Mathematical Bold for holes.
  if (code >= 0x41 && code <= 0x5a) {
    const fraktur: Record<string, string> = {
      C: "\u212D", // ℂ
      H: "\u210C", // ℌ
      I: "\u2111", // ℑ
      R: "\u211C", // ℜ
      Z: "\u2128", // ℨ
    };
    if (fraktur[ch]) return fraktur[ch];
    return String.fromCodePoint(0x1d504 + (code - 0x41));
  }
  if (code >= 0x61 && code <= 0x7a) {
    return String.fromCodePoint(0x1d51e + (code - 0x61));
  }
  return null;
}

/** Mathematical Bold Script / Sans-Serif Bold for fancy. */
function toFancyChar(ch: string): string | null {
  const code = ch.codePointAt(0);
  if (code === undefined) return null;
  // Mathematical Sans-Serif Bold: A–Z U+1D5D4, a–z U+1D5EE, 0–9 U+1D7EC
  if (code >= 0x41 && code <= 0x5a) {
    return String.fromCodePoint(0x1d5d4 + (code - 0x41));
  }
  if (code >= 0x61 && code <= 0x7a) {
    return String.fromCodePoint(0x1d5ee + (code - 0x61));
  }
  if (code >= 0x30 && code <= 0x39) {
    return String.fromCodePoint(0x1d7ec + (code - 0x30));
  }
  return null;
}

function toTitleCase(text: string): string {
  return text.replace(/\S+/g, (word) => {
    const chars = [...word];
    if (chars.length === 0) return word;
    return chars[0].toLocaleUpperCase() + chars.slice(1).join("").toLocaleLowerCase();
  });
}

export interface StyleResult {
  text: string;
  mode: StyleMode;
  result: string;
  skipped?: string;
}

export function convertStyle(text: string, mode: StyleMode): StyleResult {
  let skipped = 0;

  if (mode === "upper") {
    return { text, mode, result: text.toLocaleUpperCase() };
  }
  if (mode === "lower") {
    return { text, mode, result: text.toLocaleLowerCase() };
  }
  if (mode === "title") {
    return { text, mode, result: toTitleCase(text) };
  }
  if (mode === "reverse") {
    return { text, mode, result: [...text].reverse().join("") };
  }

  if (mode === "morse") {
    const parts: string[] = [];
    for (const ch of text) {
      if (ch === " " || ch === "\t" || ch === "\n") {
        parts.push("/");
        continue;
      }
      const code = MORSE[ch.toLowerCase()];
      if (code) {
        parts.push(code);
      } else {
        parts.push(ch);
        skipped += 1;
      }
    }
    const result = parts.join(" ").replace(/ +\/ +/g, " / ").replace(/ +/g, " ").trim();
    return {
      text,
      mode,
      result,
      ...(skipped > 0 ? { skipped: `${skipped} non-mappable character(s) kept as-is` } : {}),
    };
  }

  if (mode === "binary") {
    const parts: string[] = [];
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code === undefined) continue;
      // Map BMP printable ASCII only; others kept as-is and counted skipped.
      if (code >= 0x20 && code <= 0x7e) {
        parts.push(code.toString(2).padStart(8, "0"));
      } else if (ch === "\n" || ch === "\t") {
        parts.push(code.toString(2).padStart(8, "0"));
      } else {
        parts.push(ch);
        skipped += 1;
      }
    }
    return {
      text,
      mode,
      result: parts.join(" "),
      ...(skipped > 0 ? { skipped: `${skipped} non-ASCII character(s) kept as-is` } : {}),
    };
  }

  if (mode === "old_english") {
    let out = "";
    for (const ch of text) {
      const mapped = toOldEnglishChar(ch);
      if (mapped) out += mapped;
      else {
        out += ch;
        if (/[A-Za-z]/.test(ch) === false && ch.trim() !== "") {
          // non-letters kept silently; only count letters we couldn't map
        } else if (/[A-Za-z]/.test(ch)) {
          skipped += 1;
        }
      }
    }
    return {
      text,
      mode,
      result: out,
      ...(skipped > 0 ? { skipped: `${skipped} letter(s) kept as-is` } : {}),
    };
  }

  // fancy
  let out = "";
  for (const ch of text) {
    const mapped = toFancyChar(ch);
    if (mapped) out += mapped;
    else {
      out += ch;
      if (/[A-Za-z0-9]/.test(ch)) skipped += 1;
    }
  }
  return {
    text,
    mode,
    result: out,
    ...(skipped > 0 ? { skipped: `${skipped} character(s) kept as-is` } : {}),
  };
}
