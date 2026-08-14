import { describe, it, expect } from "vitest";
import { referralTier, depositSizeMultiplier } from "../../src/scoring/weights.js";

describe("referralTier", () => {
  it("returns full tier for the first 10 credits", () => {
    expect(referralTier(0)).toEqual({ tier: "full", multiplier: 1 });
    expect(referralTier(9)).toEqual({ tier: "full", multiplier: 1 });
  });

  it("returns half tier for credits 10-19", () => {
    expect(referralTier(10)).toEqual({ tier: "half", multiplier: 0.5 });
    expect(referralTier(19)).toEqual({ tier: "half", multiplier: 0.5 });
  });

  it("returns floor tier from credit 20 onward, with no ceiling", () => {
    expect(referralTier(20)).toEqual({ tier: "floor", multiplier: 0.1 });
    expect(referralTier(1000)).toEqual({ tier: "floor", multiplier: 0.1 });
  });
});

describe("depositSizeMultiplier", () => {
  it("returns 1 at or below the dust threshold", () => {
    // CAMPAIGN_DEPOSIT_DUST_THRESHOLD_WEI defaults to 0.001 ETH in test env
    expect(depositSizeMultiplier(1_000_000_000_000_000n)).toBe(1);
    expect(depositSizeMultiplier(500_000_000_000_000n)).toBe(1);
  });

  it("increases with deposit size but never exceeds the cap", () => {
    const small = depositSizeMultiplier(2_000_000_000_000_000n);   // 2x dust
    const large = depositSizeMultiplier(1_000_000_000_000_000_000n); // 1000x dust
    expect(small).toBeGreaterThan(1);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(4);
  });
});
