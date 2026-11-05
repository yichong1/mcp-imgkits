import { describe, expect, it } from "vitest";
import type { CfImages } from "../src/env";
import { bytesToBase64, compressImage } from "../src/tools/compress-image";
import { expectNoChargeCall, imageResponse, mockFetch, SOURCE, testCtx, type FetchCall } from "./helpers";

const INPUT = new Uint8Array([1, 2, 3, 4, 5]);
const OUTPUT = new Uint8Array([9, 8, 7]);

function binding(transformCalls: Array<Record<string, unknown>>): CfImages {
  return {
    input() {
      const chain = {
        transform(transform: { width?: number; height?: number; fit?: "scale-down" }) {
          transformCalls.push(transform);
          return chain;
        },
        async output(options: { format: string; quality?: number }) {
          transformCalls.push(options);
          return {
            response: () => imageResponse(OUTPUT, options.format),
            contentType: () => options.format,
          };
        },
      };
      return chain;
    },
    async info() {
      return { format: "image/jpeg", fileSize: OUTPUT.byteLength, width: 64, height: 48 };
    },
  };
}

describe("compress_image", () => {
  it("re-encodes with the Images binding and does not call an ImgKits host", async () => {
    const transforms: Array<Record<string, unknown>> = [];
    const { calls } = mockFetch(() => imageResponse(INPUT));
    const result = await compressImage(
      { ...testCtx, env: { ...testCtx.env, IMAGES: binding(transforms) } },
      { source_url: SOURCE, quality: 60, max_width: 800, format: "webp" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SOURCE);
    expect(calls[0]?.init.method).toBe("GET");
    expect(String(calls[0]?.url)).not.toMatch(/imgkits\.com|ai\.test|usa\.test|api\.test/);
    expect(transforms[0]).toEqual({ fit: "scale-down", width: 800 });
    expect(transforms[1]).toMatchObject({ format: "image/webp", quality: 60 });
    expect(result).toMatchObject({
      ok: true,
      tool: "compress_image",
      encoder: "images-binding",
      mime_type: "image/webp",
      bytes: OUTPUT.byteLength,
      width: 64,
      height: 48,
      quality: 60,
      image_base64: bytesToBase64(OUTPUT),
      charge: { charged: 1, charge_id: "ch_test_123" },
    });
    expect(result.result_url).toBeUndefined();
    expectNoChargeCall(calls);
  });

  it("rejects an oversized download before billing", async () => {
    const big = new Uint8Array(8);
    const { calls } = mockFetch(
      () =>
        new Response(big, {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": String(9 * 1024 * 1024) },
        }),
    );
    await expect(
      compressImage({ ...testCtx, env: { ...testCtx.env, IMAGES: binding([]) } }, { source_url: SOURCE }),
    ).rejects.toMatchObject({ code: "image_too_large" });
    expect(calls).toHaveLength(1);
  });

  it("falls back to cf.image when the binding is absent", async () => {
    const { calls } = mockFetch(() => imageResponse(OUTPUT, "image/jpeg"));
    const result = await compressImage(testCtx, { source_url: SOURCE, format: "jpeg", quality: 40 });
    const cf = (calls[0]?.init as FetchCall["init"] & { cf?: { image?: { format?: string; quality?: number } } }).cf;
    expect(cf?.image).toMatchObject({ format: "jpeg", quality: 40, fit: "scale-down" });
    expect(result).toMatchObject({ encoder: "cf-image", mime_type: "image/jpeg", bytes: OUTPUT.byteLength });
    expectNoChargeCall(calls);
  });

  it("rejects redirects", async () => {
    mockFetch(() => new Response(null, { status: 302, headers: { location: "https://cdn.example.net/other.jpg" } }));
    await expect(
      compressImage({ ...testCtx, env: { ...testCtx.env, IMAGES: binding([]) } }, { source_url: SOURCE }),
    ).rejects.toMatchObject({ code: "image_redirect" });
  });
});
