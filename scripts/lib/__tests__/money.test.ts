/**
 * Money math tests. CLAUDE.md requires these to be table-driven and to exist
 * BEFORE the code they cover ships — this file is the Phase 0 audit paying that
 * debt for the formatters already in use.
 *
 * The values are not invented: most are taken from the real Phase 0 probe
 * (docs/dex-notes.md §13), so a regression here would contradict a measured,
 * on-chain result.
 */
import { describe, it, expect } from "vitest";
import { formatFixed, priceToPercent, formatStt, NATIVE_DECIMALS, MoneyError } from "../money.js";

const USDC = 6;

describe("formatFixed", () => {
  const cases: Array<[bigint, number, number, string, string]> = [
    [9_999_928_100n, USDC, 4, "9999.9281", "tUSDC balance after the winning probe"],
    [1_751_000n, USDC, 4, "1.7510", "contracts won on probe 2"],
    [999_800n, USDC, 4, "0.9998", "escrow paid"],
    [0n, USDC, 2, "0.00", "zero"],
    [1n, USDC, 6, "0.000001", "one base unit"],
    [1n, USDC, 2, "0.00", "sub-display dust reads as zero, not rounded up"],
    [999_999n, USDC, 2, "0.99", "truncates, never rounds up"],
    [-1_500_000n, USDC, 2, "-1.50", "negative"],
    [10_000_000_000n, USDC, 0, "10000", "zero places drops the point"],
    [50_000_000_000_000_000_000n, 18, 4, "50.0000", "50 STT from the faucet"],
  ];

  for (const [raw, decimals, places, want, label] of cases) {
    it(`${label}: ${raw} @${decimals}dp/${places} -> ${want}`, () => {
      expect(formatFixed(raw, decimals, places)).toBe(want);
    });
  }

  it("never rounds a balance up (a user must never be shown more than they hold)", () => {
    // 0.999999 tUSDC displayed to 2dp must be 0.99, not 1.00.
    expect(formatFixed(999_999n, USDC, 2)).toBe("0.99");
    expect(formatFixed(1_999_999n, USDC, 3)).toBe("1.999");
  });

  it("rejects negative decimals or places rather than producing garbage", () => {
    expect(() => formatFixed(1n, -1, 2)).toThrow(MoneyError);
    expect(() => formatFixed(1n, USDC, -1)).toThrow(MoneyError);
  });

  it("is exact at magnitudes where a float would already have failed", () => {
    // 2^53 + 1 base units: Number cannot represent this distinctly.
    const raw = 9_007_199_254_740_993n;
    expect(formatFixed(raw, USDC, 6)).toBe("9007199254.740993");
  });
});

describe("priceToPercent", () => {
  const cases: Array<[bigint, string, string]> = [
    [534_000n, "53.4%", "actual fill on probe 1"],
    [554_000n, "55.4%", "actual fill on probe 2"],
    [626_000n, "62.6%", "limit price offered on probe 1"],
    [20_000n, "2.0%", "thin Down ask seen in the survey"],
    [980_000n, "98.0%", "heavily favoured Up bid"],
    [500_000n, "50.0%", "even odds"],
    [1_000n, "0.1%", "one tick on a 6dp venue"],
  ];
  for (const [price, want, label] of cases) {
    it(`${label}: ${price} -> ${want}`, () => {
      expect(priceToPercent(price, USDC)).toBe(want);
    });
  }

  it("treats price as a probability in collateral units", () => {
    // A winning contract redeems for exactly 1 unit of collateral, so a price
    // of 0.62 means 620_000 base units on a 6-decimal venue.
    expect(priceToPercent(620_000n, USDC)).toBe("62.0%");
  });
});

describe("formatStt", () => {
  it("uses 18 decimals, not the collateral's 6", () => {
    expect(NATIVE_DECIMALS).toBe(18);
    expect(formatStt(600_000_000_000_000_000n)).toBe("0.6000");
  });

  it("renders the measured gas floor and faucet grant", () => {
    // ~0.6 STT is the SDK's 10M gas ceiling at 60 gwei: the mempool admits a
    // transaction only when its ceiling is funded.
    expect(formatStt(600_000_000_000_000_000n)).toBe("0.6000");
    expect(formatStt(50_000_000_000_000_000_000n)).toBe("50.0000");
    expect(formatStt(0n)).toBe("0.0000");
  });

  it("does not confuse an 18dp amount with a 6dp one", () => {
    // 1 STT formatted as if it were tUSDC would read as a trillion.
    expect(formatStt(10n ** 18n)).toBe("1.0000");
    expect(formatFixed(10n ** 18n, USDC, 4)).toBe("1000000000000.0000");
  });
});
