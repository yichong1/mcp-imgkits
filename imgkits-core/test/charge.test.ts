import { describe, expect, it, vi } from "vitest";
import { chargeCredits } from "../src/charge";
import { costFor } from "../src/config";
import { testEnv } from "./helpers";

describe("chargeCredits (gateway-trust helper)", () => {
  it("trusts the gateway charge and returns cost metadata without network I/O", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = chargeCredits({ cost: 2, tool: "colorize_photo" });
    expect(result).toEqual({ ok: true, charged: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes X-Mcp-Charge-Id through as charge_id", () => {
    const result = chargeCredits({ cost: 2, tool: "upscale_image", chargeId: " ch_gateway_123 " });
    expect(result).toEqual({ ok: true, charged: 2, charge_id: "ch_gateway_123" });
  });

  it("ignores a blank charge id", () => {
    expect(chargeCredits({ cost: 1, tool: "resize_image", chargeId: "   " })).toEqual({
      ok: true,
      charged: 1,
    });
  });

  it("does not report a charge id for a zero-cost tool", () => {
    expect(chargeCredits({ cost: 0, tool: "compress_image", chargeId: "ch_ignored" })).toEqual({
      ok: true,
      charged: 0,
    });
  });

  it("rejects a negative or non-integer cost", () => {
    expect(() => chargeCredits({ cost: -1, tool: "colorize_photo" })).toThrowError(/non-negative integer/);
    expect(() => chargeCredits({ cost: 1.5, tool: "colorize_photo" })).toThrowError(/non-negative integer/);
    try {
      chargeCredits({ cost: -1, tool: "colorize_photo" });
      throw new Error("expected chargeCredits to throw");
    } catch (error) {
      expect(error).toMatchObject({ name: "ChargeError", code: "invalid_cost" });
    }
  });

  it("reads COST_* overrides and falls back when the var is not an integer", () => {
    expect(costFor({ ...testEnv, COST_COLORIZE_PHOTO: "5" }, "colorize_photo")).toBe(5);
    expect(costFor({ ...testEnv, COST_UPSCALE_IMAGE: "9" }, "upscale_image")).toBe(9);
    expect(costFor({ ...testEnv, COST_COLORIZE_PHOTO: "nope" }, "colorize_photo")).toBe(2);
    expect(costFor({}, "compress_image")).toBe(1);
  });
});
