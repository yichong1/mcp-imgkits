import { describe, expect, it } from "vitest";
import { detectLanguage, normalizeLanguageCode } from "../src/languages";

describe("normalizeLanguageCode", () => {
  it("maps English names and locale variants", () => {
    expect(normalizeLanguageCode("English")).toBe("en");
    expect(normalizeLanguageCode("en-US")).toBe("en");
    expect(normalizeLanguageCode("Chinese (Traditional)")).toBe("cht");
    expect(normalizeLanguageCode("zh_TW")).toBe("cht");
    expect(normalizeLanguageCode("Portuguese")).toBe("pt");
  });

  it("maps legacy/ISO-639-3 codes seen in ImgKits demos", () => {
    expect(normalizeLanguageCode("chi_sim")).toBe("zh");
    expect(normalizeLanguageCode("jpn")).toBe("ja");
    expect(normalizeLanguageCode("bel")).toBe("be");
    expect(normalizeLanguageCode("eng")).toBe("en");
  });

  it("handles auto only when allowed", () => {
    expect(normalizeLanguageCode("auto", true)).toBe("auto");
    expect(() => normalizeLanguageCode("auto")).toThrow(/cannot be 'auto'/);
  });

  it("rejects junk", () => {
    expect(() => normalizeLanguageCode("klingon!")).toThrow(/Unrecognised/);
  });
});

describe("detectLanguage", () => {
  it("detects non-Latin scripts", () => {
    expect(detectLanguage("这是一个测试，我们会说中文。").language).toBe("zh");
    expect(detectLanguage("這是一個測試，我們會說中文。").language).toBe("cht");
    expect(detectLanguage("これは日本語のテストです。").language).toBe("ja");
    expect(detectLanguage("이것은 한국어 테스트입니다.").language).toBe("ko");
    expect(detectLanguage("Это тест на определение языка, и он должен работать.").language).toBe("ru");
    expect(detectLanguage("هذا اختبار للكشف عن اللغة.").language).toBe("ar");
    expect(detectLanguage("这是一个测试。これはテストです。").language).toBe("ja");
    expect(detectLanguage("นี่คือการทดสอบภาษาไทย").language).toBe("th");
    expect(detectLanguage("यह भाषा का परीक्षण है").language).toBe("hi");
  });

  it("detects common Latin-script languages with enough context", () => {
    const english = detectLanguage("This is a test of the language detector and it should work for English text.");
    expect(english.language).toBe("en");
    expect(english.is_reliable).toBe(true);
    expect(
      detectLanguage("Este es un texto de prueba para el detector de idioma y debe funcionar bien.").language,
    ).toBe("es");
    expect(
      detectLanguage("Ceci est un texte de test pour le détecteur de langue et il doit fonctionner.").language,
    ).toBe("fr");
    expect(
      detectLanguage("Dies ist ein Testtext für den Spracherkenner und er sollte funktionieren.").language,
    ).toBe("de");
    expect(
      detectLanguage("Đây là một văn bản thử nghiệm để kiểm tra ngôn ngữ và nó phải hoạt động.").language,
    ).toBe("vi");
  });

  it("marks short Latin strings unreliable", () => {
    const result = detectLanguage("Hello");
    expect(result.is_reliable).toBe(false);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("returns und for text without letters", () => {
    expect(detectLanguage("12345 ---").language).toBe("und");
  });

  it("rejects empty text", () => {
    expect(() => detectLanguage("   ")).toThrow(/must not be empty/);
  });
});
