import { describe, expect, it } from "vitest";
import { extractOutputUrl, getUpstream, postJson, unwrapUpstream } from "../src/upstream";
import { headerOf, jsonResponse, mockFetch, testEnv } from "./helpers";

describe("upstream envelopes", () => {
  it("unwraps {success,message,data} and nested urls", () => {
    const data = unwrapUpstream({
      success: true,
      message: "",
      data: { urls: [{ url: "https://cdn.example.net/out.png" }] },
    });
    expect(extractOutputUrl(data)).toBe("https://cdn.example.net/out.png");
  });

  it("reads a bare {url} restoration/deoldify body", () => {
    expect(extractOutputUrl(unwrapUpstream({ url: "https://cdn.example.net/deoldify.jpg" }))).toBe(
      "https://cdn.example.net/deoldify.jpg",
    );
  });

  it("does not treat a null url as a result", () => {
    expect(extractOutputUrl(unwrapUpstream({ url: null }))).toBeUndefined();
  });

  it("throws on success:false", () => {
    expect(() => unwrapUpstream({ success: false, message: "bad image", data: [] })).toThrow(/bad image/);
  });

  it("throws on ok:2", () => {
    expect(() => unwrapUpstream({ ok: 2, msg: "An internal server error occurred." })).toThrow(/internal server error/i);
  });
});

describe("upstream HTTP", () => {
  it("POSTs JSON with no Authorization header", async () => {
    const { calls } = mockFetch(() => jsonResponse({ url: "https://cdn.example.net/out.jpg" }));
    const payload = await postJson(testEnv, "https://ai.test", "/api/deoldify", {
      img: "https://cdn.example.net/in.jpg",
    });
    expect(payload).toEqual({ url: "https://cdn.example.net/out.jpg" });
    expect(calls[0]?.url).toBe("https://ai.test/api/deoldify");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ img: "https://cdn.example.net/in.jpg" });
    expect(headerOf(calls[0]!, "authorization")).toBeUndefined();
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(calls[0]?.url.includes("/v1/charge")).toBe(false);
  });

  it("GETs a query path with no Authorization header", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ success: true, data: { urls: [{ url: "https://cdn.example.net/cut.png" }] } }),
    );
    const payload = await getUpstream(testEnv, "https://usa.test", "/ai/segment?pic=https%3A%2F%2Fcdn.example.net%2Fa.jpg");
    expect(extractOutputUrl(payload)).toBe("https://cdn.example.net/cut.png");
    expect(calls[0]?.init.method).toBe("GET");
    expect(headerOf(calls[0]!, "authorization")).toBeUndefined();
  });

  it("rejects HTML error bodies", async () => {
    mockFetch(
      () =>
        new Response("<!doctype html><title>500</title>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
    );
    await expect(postJson(testEnv, "https://ai.test", "/api/inpaint", { img: "https://cdn.example.net/a.jpg" })).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("does not follow redirects", async () => {
    mockFetch(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    await expect(getUpstream(testEnv, "https://usa.test", "/ai/segment?pic=1")).rejects.toMatchObject({
      code: "upstream_redirect",
    });
  });
});
