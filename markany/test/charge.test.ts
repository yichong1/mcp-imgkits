import { describe, expect, it } from "vitest";
import { chargeCredits } from "../src/charge";

describe("chargeCredits (gateway-trust helper)", () => {
  it("trusts the gateway charge and returns cost metadata without network I/O", () => {
    const result = chargeCredits({ cost: 2, tool: "add_watermark" });
    expect(result).toEqual({ ok: true, charged: 2 });
  });

  it("passes X-Mcp-Charge-Id through as charge_id", () => {
    const result = chargeCredits({ cost: 3, tool: "remove_watermark", chargeId: " ch_gateway_123 " });
    expect(result).toEqual({ ok: true, charged: 3, charge_id: "ch_gateway_123" });
  });

  it("ignores a blank charge id", () => {
    expect(chargeCredits({ cost: 2, tool: "embed_blind_watermark", chargeId: "   " })).toEqual({
      ok: true,
      charged: 2,
    });
  });

  it("does not report a charge id for a zero-cost tool", () => {
    const result = chargeCredits({ cost: 0, tool: "decode_blind_watermark", chargeId: "ch_ignored" });
    expect(result).toEqual({ ok: true, charged: 0 });
  });

  it("rejects a negative or non-integer cost", () => {
    expect(() => chargeCredits({ cost: -1, tool: "add_watermark" })).toThrowError(/non-negative integer/);
    expect(() => chargeCredits({ cost: 1.5, tool: "add_watermark" })).toThrowError(/non-negative integer/);

    try {
      chargeCredits({ cost: -1, tool: "add_watermark" });
      throw new Error("expected chargeCredits to throw");
    } catch (error) {
      expect(error).toMatchObject({ name: "ChargeError", code: "invalid_cost" });
    }
  });
});
