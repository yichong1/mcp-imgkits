import { describe, expect, it, beforeEach } from "vitest";
import {
  DEFAULT_REMOVE_WATERMARK_RATE_LIMIT,
  DEFAULT_REMOVE_WATERMARK_RATE_WINDOW_MS,
  removeWatermarkRateLimit,
  removeWatermarkRateWindowMs,
} from "../src/config";
import { consumeRemoveWatermarkRateLimit, hashCallerKey, resetRemoveWatermarkRateLimits } from "../src/rate-limit";

describe("remove_watermark rate limit defaults", () => {
  beforeEach(() => {
    resetRemoveWatermarkRateLimits();
  });

  it("defaults to 5 calls per 60 seconds", () => {
    expect(DEFAULT_REMOVE_WATERMARK_RATE_LIMIT).toBe(5);
    expect(DEFAULT_REMOVE_WATERMARK_RATE_WINDOW_MS).toBe(60_000);
    expect(removeWatermarkRateLimit({})).toBe(5);
    expect(removeWatermarkRateWindowMs({})).toBe(60_000);
  });

  it("drops hits that fall outside the sliding window", () => {
    expect(consumeRemoveWatermarkRateLimit("caller", 1, 1_000, 1_000).allowed).toBe(true);
    expect(consumeRemoveWatermarkRateLimit("caller", 1, 1_000, 1_500)).toMatchObject({
      allowed: false,
      retryAfterMs: 500,
    });
    expect(consumeRemoveWatermarkRateLimit("caller", 1, 1_000, 2_001).allowed).toBe(true);
  });

  it("hashes caller keys so the raw token is not the bucket id", async () => {
    const hashed = await hashCallerKey("sk_live_secret_value");
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toContain("sk_live");
  });
});
