import { describe, expect, it, vi } from "vitest";
import { chargeCredits } from "../src/charge";

describe("chargeCredits (gateway-trust helper)", () => {
  it("trusts the gateway charge and returns cost metadata without network I/O", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = chargeCredits({ cost: 2, tool: "translate_text" });

    expect(result).toEqual({ ok: true, charged: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes X-Mcp-Charge-Id through as charge_id", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = chargeCredits({ cost: 5, tool: "translate_document", chargeId: " ch_gateway_123 " });

    expect(result).toEqual({ ok: true, charged: 5, charge_id: "ch_gateway_123" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a blank charge id", () => {
    expect(chargeCredits({ cost: 1, tool: "translate_text", chargeId: "   " })).toEqual({
      ok: true,
      charged: 1,
    });
  });

  it("does not report a charge id for a zero-cost tool", () => {
    const result = chargeCredits({ cost: 0, tool: "detect_language", chargeId: "ch_ignored" });

    expect(result).toEqual({ ok: true, charged: 0 });
  });

  it("is synchronous and never posts to /v1/charge", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetchMock);

    for (const cost of [0, 1, 2, 3, 5]) {
      const result = chargeCredits({ cost, tool: "translate_image", chargeId: "ch_x" });
      expect(result.ok).toBe(true);
      expect(result.charged).toBe(cost);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a negative or non-integer cost", () => {
    expect(() => chargeCredits({ cost: -1, tool: "translate_text" })).toThrowError(/non-negative integer/);
    expect(() => chargeCredits({ cost: 1.5, tool: "translate_text" })).toThrowError(/non-negative integer/);

    try {
      chargeCredits({ cost: -1, tool: "translate_text" });
      throw new Error("expected chargeCredits to throw");
    } catch (error) {
      expect(error).toMatchObject({ name: "ChargeError", code: "invalid_cost" });
    }
  });
});
