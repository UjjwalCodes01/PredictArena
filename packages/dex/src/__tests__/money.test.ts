import { describe, it, expect } from "vitest";
import {
  parseAmount, formatAmount, formatFixed, priceToPercent, probabilityToPrice,
  quantizeDown, quantizeUp, formatStt, MoneyError,
} from "../money.js";

const USDC = 6;

describe("parseAmount", () => {
  const cases: Array<[string, number, bigint]> = [
    ["1", USDC, 1_000_000n],
    ["0.000001", USDC, 1n],
    ["1.5", USDC, 1_500_000n],
    ["10000", USDC, 10_000_000_000n],
    ["0", USDC, 0n],
    ["-1.25", USDC, -1_250_000n],
    ["1", 18, 10n ** 18n],
    ["0.1", 18, 10n ** 17n],
  ];
  for (const [input, decimals, want] of cases) {
    it(`"${input}" @${decimals}dp -> ${want}`, () => expect(parseAmount(input, decimals)).toBe(want));
  }

  it("round-trips through formatAmount (the property CLAUDE.md asks for)", () => {
    for (const v of ["0", "1", "0.000001", "1234.567891", "-42.5", "999999999.999999"]) {
      expect(formatAmount(parseAmount(v, USDC), USDC)).toBe(v);
    }
  });

  it("rejects more precision than the token has, rather than truncating a stake", () => {
    expect(() => parseAmount("1.1234567", USDC)).toThrow(MoneyError);
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["1e6", "abc", "", "1.2.3", "0x10", " ", "1,000", "Infinity", "NaN"]) {
      expect(() => parseAmount(bad, USDC)).toThrow(MoneyError);
    }
  });

  it("is exact where a float would not be", () => {
    // 0.1 + 0.2 in base units is exactly 0.3 — the classic float failure.
    expect(parseAmount("0.1", USDC) + parseAmount("0.2", USDC)).toBe(parseAmount("0.3", USDC));
    // A value beyond Number.MAX_SAFE_INTEGER survives intact.
    expect(parseAmount("9007199254.740993", USDC)).toBe(9_007_199_254_740_993n);
  });
});

describe("formatFixed", () => {
  it("truncates and never rounds up — a user must not see more than they hold", () => {
    expect(formatFixed(999_999n, USDC, 2)).toBe("0.99");
    expect(formatFixed(1_999_999n, USDC, 3)).toBe("1.999");
    expect(formatFixed(1n, USDC, 2)).toBe("0.00");
  });

  it("matches the measured Phase 0 probe values", () => {
    expect(formatFixed(9_999_928_100n, USDC, 4)).toBe("9999.9281");
    expect(formatFixed(1_751_000n, USDC, 4)).toBe("1.7510");
    expect(formatFixed(999_800n, USDC, 4)).toBe("0.9998");
  });

  it("handles zero places and negatives", () => {
    expect(formatFixed(10_000_000_000n, USDC, 0)).toBe("10000");
    expect(formatFixed(-1_500_000n, USDC, 2)).toBe("-1.50");
  });

  it("rejects negative decimals or places", () => {
    expect(() => formatFixed(1n, -1, 2)).toThrow(MoneyError);
    expect(() => formatFixed(1n, USDC, -1)).toThrow(MoneyError);
  });
});

describe("priceToPercent", () => {
  const cases: Array<[bigint, string]> = [
    [534_000n, "53.4%"], [554_000n, "55.4%"], [626_000n, "62.6%"],
    [20_000n, "2.0%"], [980_000n, "98.0%"], [500_000n, "50.0%"], [1_000n, "0.1%"],
  ];
  for (const [price, want] of cases) {
    it(`${price} -> ${want}`, () => expect(priceToPercent(price, USDC)).toBe(want));
  }
});

describe("probabilityToPrice", () => {
  it("converts a probability string to collateral base units", () => {
    expect(probabilityToPrice("0.62", USDC)).toBe(620_000n);
    expect(probabilityToPrice("0.05", USDC)).toBe(50_000n);
  });

  it("rejects 0 and 1 — neither is a tradable probability", () => {
    expect(() => probabilityToPrice("0", USDC)).toThrow(MoneyError);
    expect(() => probabilityToPrice("1", USDC)).toThrow(MoneyError);
    expect(() => probabilityToPrice("1.5", USDC)).toThrow(MoneyError);
  });

  it("avoids the float drift that gets orders rejected with InvalidPrice", () => {
    // (0.05).toFixed(18) is "0.050000000000000003" — three wei off the tick grid.
    expect(probabilityToPrice("0.05", 18)).toBe(50_000_000_000_000_000n);
  });
});

describe("quantize", () => {
  it("snaps down and up to the grid", () => {
    expect(quantizeDown(2_816_901n, 1_000n)).toBe(2_816_000n);
    expect(quantizeUp(2_816_001n, 1_000n)).toBe(2_817_000n);
  });
  it("leaves exact multiples alone", () => {
    expect(quantizeDown(5_000n, 1_000n)).toBe(5_000n);
    expect(quantizeUp(5_000n, 1_000n)).toBe(5_000n);
  });
  it("floors sub-lot values to zero, which callers must treat as unfillable", () => {
    expect(quantizeDown(999n, 1_000n)).toBe(0n);
  });
  it("rejects a non-positive step", () => {
    expect(() => quantizeDown(1n, 0n)).toThrow(MoneyError);
    expect(() => quantizeUp(1n, -1n)).toThrow(MoneyError);
  });
});

describe("formatStt", () => {
  it("uses 18 decimals, never the collateral's 6", () => {
    expect(formatStt(10n ** 18n)).toBe("1.0000");
    expect(formatStt(600_000_000_000_000_000n)).toBe("0.6000");
    expect(formatStt(50n * 10n ** 18n)).toBe("50.0000");
    // The same number read as 6dp would be a trillion — the bug this prevents.
    expect(formatFixed(10n ** 18n, USDC, 4)).toBe("1000000000000.0000");
  });
});
