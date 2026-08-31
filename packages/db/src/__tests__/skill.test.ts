/**
 * Forecast skill: Brier score and edge.
 *
 * The thesis these numbers exist to serve: anyone can win a coin flip, so a
 * leaderboard ranked on wins measures luck as much as judgement. Brier asks
 * how accurate your stated probabilities were; edge asks whether you pick
 * sides the market has underpriced.
 *
 * On this venue you never type a probability — the price you paid IS your
 * claim. Buying UP at 0.62 asserts UP is 62% likely.
 */
import { describe, it, expect } from "vitest";
import { computeStandings, impliedProbability, SKILL_MIN_SETTLED, BRIER_COIN_FLIP } from "../scoring.js";
import type { CallStatus, ScorableCall } from "../types.js";

const WEEK = "2026-W35";
let seq = 0;

/** Named prices, so a probability never sits next to a bigint amount. */
const EVEN = 0.5;
const FAVOURITE = 0.8;

/** A call at a chosen price. `price` is a fraction, e.g. 0.62. */
function at(wallet: string, status: CallStatus, price: number, over: Partial<ScorableCall> = {}): ScorableCall {
  seq += 1;
  // 1 tUSDC of stake buys 1/price contracts.
  const stake = 1_000_000n;
  const quantity = BigInt(Math.round(1_000_000 / price));
  return {
    id: `s${seq}`,
    wallet,
    windowId: `w${seq}`,
    direction: "UP",
    status,
    placedAtSec: 1_000_000 + seq * 100,
    closesAtSec: 1_000_000 + seq * 100 + 60,
    weekId: WEEK,
    stake,
    quantity,
    ...over,
  };
}

const only = (calls: ScorableCall[]) => computeStandings(calls, WEEK)[0]!;

describe("impliedProbability", () => {
  const cases: Array<[bigint, bigint, number | null, string]> = [
    [1_000_000n, 2_000_000n, 0.5, "1 tUSDC for 2 contracts is even money"],
    [1_000_000n, 1_250_000n, 0.8, "a favourite"],
    [1_000_000n, 10_000_000n, 0.1, "a longshot"],
    [1_000_000n, 1_000_000n, 1, "certainty is the ceiling, not an error"],
    [1_000_000n, 0n, null, "no contracts means no derivable price"],
    [0n, 2_000_000n, null, "no stake means no derivable price"],
    // A price above 1 cannot be a probability; fees or bad data could produce
    // it, and it must drop out rather than poison the average.
    [2_000_000n, 1_000_000n, null, "above 1 is rejected"],
  ];
  for (const [stake, quantity, want, why] of cases) {
    it(why, () => {
      const got = impliedProbability(stake, quantity);
      if (want === null) expect(got).toBeNull();
      else expect(got).toBeCloseTo(want, 6);
    });
  }
});

describe("Brier score", () => {
  it("is null below the minimum — a score from three calls is noise", () => {
    const calls = Array.from({ length: SKILL_MIN_SETTLED - 1 }, () => at("0xA", "WON", 0.5));
    expect(only(calls).brier).toBeNull();
  });

  it("is reported once the minimum is met", () => {
    const calls = Array.from({ length: SKILL_MIN_SETTLED }, () => at("0xA", "WON", 0.5));
    expect(only(calls).brier).not.toBeNull();
  });

  it("scores exactly 0.25 for someone who always says 50% and splits", () => {
    // Five at even money, three won: mean squared error is 0.25 either way.
    const calls = [
      at("0xA", "WON", 0.5), at("0xA", "WON", 0.5), at("0xA", "WON", 0.5),
      at("0xA", "LOST", 0.5), at("0xA", "LOST", 0.5),
    ];
    expect(only(calls).brier).toBeCloseTo(BRIER_COIN_FLIP, 3);
  });

  it("rewards confident and correct", () => {
    // Five calls at 0.9, all won: (0.9-1)^2 = 0.01 each.
    const calls = Array.from({ length: 5 }, () => at("0xA", "WON", 0.9));
    expect(only(calls).brier).toBeCloseTo(0.01, 3);
  });

  it("punishes confident and wrong", () => {
    const calls = Array.from({ length: 5 }, () => at("0xA", "LOST", 0.9));
    expect(only(calls).brier).toBeCloseTo(0.81, 3);
  });

  it("treats a won longshot as poor forecasting, not brilliance", () => {
    // Winning at 10% is a big payout and a terrible forecast: you said it was
    // unlikely and it happened. Brier is the honest read; profit is not.
    const calls = Array.from({ length: 5 }, () => at("0xA", "WON", 0.1));
    expect(only(calls).brier).toBeCloseTo(0.81, 3);
  });
});

describe("edge — the 'good or lucky' number", () => {
  it("is zero when you win exactly as often as the price implied", () => {
    // Six at 0.5, three won: realized 50%, implied 50%.
    const calls = [
      at("0xB", "WON", 0.5), at("0xB", "WON", 0.5), at("0xB", "WON", 0.5),
      at("0xB", "LOST", 0.5), at("0xB", "LOST", 0.5), at("0xB", "LOST", 0.5),
    ];
    expect(only(calls).edge).toBeCloseTo(0, 1);
  });

  it("is positive when you beat the price you paid", () => {
    // Five at 0.5, four won: realized 80% against an implied 50%.
    const calls = [
      at("0xB", "WON", 0.5), at("0xB", "WON", 0.5), at("0xB", "WON", 0.5),
      at("0xB", "WON", 0.5), at("0xB", "LOST", 0.5),
    ];
    expect(only(calls).edge).toBeCloseTo(30, 1);
  });

  it("is negative when the market was right and you were not", () => {
    const calls = [
      at("0xB", "WON", 0.5),
      at("0xB", "LOST", 0.5), at("0xB", "LOST", 0.5),
      at("0xB", "LOST", 0.5), at("0xB", "LOST", 0.5),
    ];
    expect(only(calls).edge).toBeCloseTo(-30, 1);
  });

  it("gives no credit for winning heavy favourites — that is the whole point", () => {
    // Five at 0.9, all won. Brier is excellent, but the edge is only +10:
    // the market already said this would happen.
    const s = only(Array.from({ length: 5 }, () => at("0xC", "WON", 0.9)));
    expect(s.brier).toBeCloseTo(0.01, 3);
    expect(s.edge).toBeCloseTo(10, 1);
  });

  it("reports the average price paid, for context", () => {
    const s = only(Array.from({ length: 5 }, () => at("0xC", "WON", 0.8)));
    expect(s.avgImplied).toBeCloseTo(80, 1);
  });
});

describe("what must NOT count", () => {
  it("excludes voids — they have no outcome to score against", () => {
    const calls = [
      ...Array.from({ length: 5 }, () => at("0xD", "WON", 0.5)),
      at("0xD", "VOID", 0.5),
    ];
    const s = only(calls);
    // Five priced wins at 0.5: (0.5-1)^2 = 0.25 each.
    expect(s.brier).toBeCloseTo(0.25, 3);
    expect(s.voids).toBe(1);
  });

  it("excludes calls with no derivable price, and does not count them toward the minimum", () => {
    // Four priced, one unpriced: still under the threshold, so null.
    const unpriced = at("0xE", "WON", EVEN);
    const noQuantity: ScorableCall = { ...unpriced, quantity: 0n };
    const calls = [...Array.from({ length: 4 }, () => at("0xE", "WON", EVEN)), noQuantity];
    const s = only(calls);
    expect(s.wins).toBe(5);
    expect(s.brier).toBeNull();
    expect(s.edge).toBeNull();
  });

  it("never lets an unpriced call distort the average", () => {
    const base = at("0xF", "WON", FAVOURITE);
    const unpriced: ScorableCall = { ...base, quantity: 0n, stake: 0n };
    const calls = [...Array.from({ length: 5 }, () => at("0xF", "WON", FAVOURITE)), unpriced];
    expect(only(calls).avgImplied).toBeCloseTo(80, 1);
  });

  it("ignores PENDING calls entirely", () => {
    const calls = [
      ...Array.from({ length: 5 }, () => at("0xG", "WON", 0.5)),
      at("0xG", "PENDING", 0.9),
    ];
    expect(only(calls).brier).toBeCloseTo(0.25, 3);
  });
});

describe("stability", () => {
  it("is order-independent", () => {
    const calls = [
      at("0xH", "WON", 0.7), at("0xH", "LOST", 0.3), at("0xH", "WON", 0.6),
      at("0xH", "LOST", 0.8), at("0xH", "WON", 0.5),
    ];
    const forward = only([...calls]);
    const reversed = only([...calls].reverse());
    expect(reversed.brier).toBe(forward.brier);
    expect(reversed.edge).toBe(forward.edge);
  });

  it("stays inside its theoretical bounds", () => {
    const s = only(Array.from({ length: 6 }, (_, i) => at("0xI", i % 2 ? "WON" : "LOST", 0.5)));
    expect(s.brier!).toBeGreaterThanOrEqual(0);
    expect(s.brier!).toBeLessThanOrEqual(1);
    expect(s.edge!).toBeGreaterThanOrEqual(-100);
    expect(s.edge!).toBeLessThanOrEqual(100);
  });
});
