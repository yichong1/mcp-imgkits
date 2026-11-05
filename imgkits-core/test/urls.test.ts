import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "../src/urls";

describe("assertPublicUrl", () => {
  it("accepts a public https URL", () => {
    expect(assertPublicUrl("https://cdn.example.net/image.png", "source_url")).toBe(
      "https://cdn.example.net/image.png",
    );
  });

  it("accepts a public IP literal", () => {
    expect(assertPublicUrl("http://93.184.216.34/a.png", "source_url")).toBe("http://93.184.216.34/a.png");
  });

  it("rejects non-http protocols", () => {
    expect(() => assertPublicUrl("ftp://cdn.example.net/a.png", "source_url")).toThrow(/http or https/);
  });

  it("rejects embedded credentials", () => {
    expect(() => assertPublicUrl("https://user:pass@cdn.example.net/a.png", "source_url")).toThrow(/credentials/);
  });

  it("rejects localhost and metadata hosts", () => {
    for (const url of [
      "http://localhost/a.png",
      "http://metadata.google.internal/latest",
      "http://kubernetes.default.svc/api",
      "http://printer.local/a.png",
    ]) {
      expect(() => assertPublicUrl(url, "source_url")).toThrow();
    }
  });

  it("rejects private and reserved IPv4 ranges", () => {
    for (const url of [
      "http://127.0.0.1/a.png",
      "http://10.1.2.3/a.png",
      "http://172.16.0.1/a.png",
      "http://192.168.1.1/a.png",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      expect(() => assertPublicUrl(url, "source_url")).toThrow(/private or reserved/);
    }
  });

  it("rejects a decimal IPv4 host that the URL parser canonicalizes", () => {
    // WHATWG URL turns http://2130706433/ into 127.0.0.1 before our extra numeric-host check.
    expect(() => assertPublicUrl("http://2130706433/a.png", "source_url")).toThrow(/private or reserved/);
  });
});
