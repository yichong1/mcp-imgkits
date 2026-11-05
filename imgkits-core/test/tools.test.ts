import { describe, expect, it } from "vitest";
import { cartoonize } from "../src/tools/cartoonize";
import { colorizePhoto } from "../src/tools/colorize-photo";
import { extendImage } from "../src/tools/extend-image";
import { removeBackground } from "../src/tools/remove-background";
import { resizeImage } from "../src/tools/resize-image";
import { upscaleImage } from "../src/tools/upscale-image";
import { expectNoChargeCall, headerOf, jsonResponse, mockFetch, SOURCE, testCtx } from "./helpers";

const RESULT = "https://cdn.example.net/result.jpg";

describe("colorize_photo", () => {
  it("POSTs {img} to /api/deoldify and returns the result URL", async () => {
    const { calls } = mockFetch(() => jsonResponse({ url: RESULT }));
    const result = await colorizePhoto(testCtx, { source_url: SOURCE });
    expect(calls[0]?.url).toBe("https://ai.test/api/deoldify");
    expect(calls[0]?.body).toEqual({ img: SOURCE });
    expect(headerOf(calls[0]!, "authorization")).toBeUndefined();
    expect(result.result_url).toBe(RESULT);
    expect(result.charge).toEqual({ ok: true, charged: 2, charge_id: "ch_test_123" });
    expectNoChargeCall(calls);
  });

  it("treats a null url as a charged failure and does not report success", async () => {
    mockFetch(() => jsonResponse({ url: null }));
    await expect(colorizePhoto(testCtx, { source_url: SOURCE })).rejects.toMatchObject({
      code: "tool_failed_after_charge",
    });
  });

  it("rejects a private URL before any fetch", async () => {
    const { calls } = mockFetch(() => jsonResponse({ url: RESULT }));
    await expect(colorizePhoto(testCtx, { source_url: "http://127.0.0.1/a.jpg" })).rejects.toMatchObject({
      code: "blocked_url",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("upscale_image", () => {
  it("sends img and upscale, and merges optional face_enhance", async () => {
    const { calls } = mockFetch(() => jsonResponse({ url: RESULT }));
    const plain = await upscaleImage(testCtx, { source_url: SOURCE });
    expect(calls[0]?.url).toBe("https://ai.test/api/restoration");
    expect(calls[0]?.body).toEqual({ img: SOURCE, upscale: 2 });
    expect(plain).toMatchObject({ scale: 2, result_url: RESULT, charge: { charged: 2, charge_id: "ch_test_123" } });
    expect(plain.face_enhance).toBeUndefined();

    const enhanced = await upscaleImage(testCtx, {
      source_url: SOURCE,
      scale: 4,
      face_enhance: true,
      bucket: "californian",
    });
    expect(calls[1]?.body).toEqual({
      img: SOURCE,
      upscale: 4,
      face_enhance: true,
      bucket: "californian",
    });
    expect(enhanced).toMatchObject({ scale: 4, face_enhance: true, bucket: "californian" });
    expectNoChargeCall(calls);
  });

  it("uses RESTORATION_BUCKET when the caller omits bucket", async () => {
    const { calls } = mockFetch(() => jsonResponse({ url: RESULT }));
    await upscaleImage(
      { ...testCtx, env: { ...testCtx.env, RESTORATION_BUCKET: "californian" } },
      { source_url: SOURCE, scale: 2 },
    );
    expect(calls[0]?.body).toEqual({ img: SOURCE, upscale: 2, bucket: "californian" });
  });
});

describe("remove_background", () => {
  it("GETs /ai/segment and subject paths", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ success: true, message: "", data: { urls: [{ url: RESULT }] } }),
    );
    const general = await removeBackground(testCtx, { source_url: SOURCE });
    expect(calls[0]?.url).toBe(`https://usa.test/ai/segment?pic=${encodeURIComponent(SOURCE)}`);
    expect(calls[0]?.init.method).toBe("GET");
    expect(general).toMatchObject({ subject: "general", result_url: RESULT });

    await removeBackground(testCtx, { source_url: SOURCE, subject: "furniture" });
    expect(calls[1]?.url).toBe(`https://usa.test/ai/segmentfurniture?pic=${encodeURIComponent(SOURCE)}`);

    await removeBackground(testCtx, { source_url: SOURCE, subject: "head" });
    expect(calls[2]?.url).toContain("/ai/segmenthead?pic=");
    expectNoChargeCall(calls);
  });
});

describe("cartoonize", () => {
  it("uses v1 by default and v2 when style or variant is set", async () => {
    const { calls } = mockFetch(() => jsonResponse({ url: RESULT }));
    const v1 = await cartoonize(testCtx, { source_url: SOURCE });
    expect(calls[0]?.url).toBe("https://api.test/api/cartoonize");
    expect(calls[0]?.body).toEqual({ img: SOURCE });
    expect(v1.cartoon_api).toBe("v1");

    await cartoonize(testCtx, { source_url: SOURCE, style: "handdrawn" });
    expect(calls[1]?.url).toBe("https://api.test/api/cartoonize/v2");
    expect(calls[1]?.body).toEqual({ img: SOURCE, style: "handdrawn" });

    await cartoonize(testCtx, { source_url: SOURCE, variant: "anime" });
    expect(calls[2]?.body).toEqual({ img: SOURCE, variant: "anime" });
    expectNoChargeCall(calls);
  });
});

describe("extend_image and resize_image", () => {
  it("POSTs pic and ratio for outpaint", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ success: true, data: { urls: [{ url: RESULT, ali_url: RESULT }] } }),
    );
    const result = await extendImage(testCtx, { source_url: SOURCE, ratio: "16:9" });
    expect(calls[0]?.url).toBe("https://usa.test/ai/image-outpainting");
    expect(calls[0]?.body).toEqual({ pic: SOURCE, ratio: "16:9" });
    expect(result).toMatchObject({ ratio: "16:9", result_url: RESULT, charge: { charged: 2 } });
  });

  it("rejects a ratio that is not W:H", async () => {
    const { calls } = mockFetch(() => jsonResponse({ url: RESULT }));
    await expect(extendImage(testCtx, { source_url: SOURCE, ratio: "wide" })).rejects.toThrow(/ratio/);
    expect(calls).toHaveLength(0);
  });

  it("GETs pic, width and height for resize", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ success: true, data: { urls: [{ url: RESULT }] } }),
    );
    const result = await resizeImage(testCtx, { source_url: SOURCE, width: 320, height: 240 });
    const expected = new URL("https://usa.test/ai/change-img-size");
    expected.searchParams.set("pic", SOURCE);
    expected.searchParams.set("width", "320");
    expected.searchParams.set("height", "240");
    expect(calls[0]?.url).toBe(expected.toString());
    expect(calls[0]?.init.method).toBe("GET");
    expect(result).toMatchObject({ width: 320, height: 240, result_url: RESULT, charge: { charged: 1 } });
    expectNoChargeCall(calls);
  });
});
