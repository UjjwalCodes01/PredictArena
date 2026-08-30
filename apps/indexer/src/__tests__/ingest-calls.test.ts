/**
 * Fill aggregation. Pure, so it is tested without a chain or a database.
 *
 * This is where a bug would quietly produce wrong league entries -- a player
 * charged for three calls because their order swept three price levels, or a
 * market-making bot appearing on the leaderboard.
 */
import { describe, it, expect } from "vitest";
import { aggregateFills, directionOf, type FillLike } from "../ingest-calls";

const lower = (a: string): string => a.toLowerCase();

const fill = (over: Partial<FillLike> = {}): FillLike => ({
  taker: "0xAbC0000000000000000000000000000000000001",
  takerSide: "BUY_YES",
  quantity: "1000000",
  quoteQuantity: "500000",
  timestamp: "1700000000",
  txHash: "0xtx1",
  ...over,
});

describe("directionOf", () => {
  const cases: Array<[string | null, string | null]> = [
    ["BUY_YES", "UP"],
    ["BUY_NO", "DOWN"],
    ["SELL_YES", null],
    ["SELL_NO", null],
    [null, null],
    ["nonsense", null],
  ];
  for (const [side, want] of cases) {
    it(`${side} -> ${want}`, () => expect(directionOf(side)).toBe(want));
  }

  it("treats a SELL as closing a position, not as making a call", () => {
    expect(directionOf("SELL_YES")).toBeNull();
    expect(directionOf("SELL_NO")).toBeNull();
  });
});

describe("aggregateFills", () => {
  it("collapses a multi-level sweep into ONE call", () => {
    // One order, three price levels, one transaction.
    const fills = [
      fill({ quantity: "1000000", quoteQuantity: "300000", timestamp: "1700000005" }),
      fill({ quantity: "2000000", quoteQuantity: "620000", timestamp: "1700000003" }),
      fill({ quantity: "500000", quoteQuantity: "160000", timestamp: "1700000004" }),
    ];
    const out = [...aggregateFills(fills, lower).values()];
    expect(out).toHaveLength(1);
    expect(out[0]!.quantity).toBe(3_500_000n);
    expect(out[0]!.stake).toBe(1_080_000n);
    // Placement is the EARLIEST fill: the order was sent once.
    expect(out[0]!.placedAtSec).toBe(1_700_000_003);
  });

  it("keeps different transactions separate", () => {
    const out = aggregateFills([fill({ txHash: "0xa" }), fill({ txHash: "0xb" })], lower);
    expect(out.size).toBe(2);
  });

  it("separates the two directions even within one transaction", () => {
    const out = aggregateFills(
      [fill({ txHash: "0xa", takerSide: "BUY_YES" }), fill({ txHash: "0xa", takerSide: "BUY_NO" })],
      lower,
    );
    expect(out.size).toBe(2);
    expect([...out.values()].map((c) => c.direction).sort()).toEqual(["DOWN", "UP"]);
  });

  it("skips SELL fills entirely", () => {
    expect(aggregateFills([fill({ takerSide: "SELL_YES" }), fill({ takerSide: "SELL_NO" })], lower).size).toBe(0);
  });

  it("skips maker-only fills — bots must not reach the leaderboard", () => {
    expect(aggregateFills([fill({ taker: null, takerSide: null })], lower).size).toBe(0);
  });

  it("falls back to takerOrder when the flat taker fields are absent", () => {
    const out = [...aggregateFills(
      [fill({ taker: null, takerSide: null, takerOrder: { owner: "0xDEF", side: "BUY_NO" } })],
      lower,
    ).values()];
    expect(out).toHaveLength(1);
    expect(out[0]!.direction).toBe("DOWN");
    expect(out[0]!.wallet).toBe("0xdef");
  });

  it("normalises the wallet address — checksum casing must not split a player in two", () => {
    const out = [...aggregateFills([fill()], lower).values()];
    expect(out[0]!.wallet).toBe("0xabc0000000000000000000000000000000000001");
  });

  it("keeps amounts as exact bigints", () => {
    // Beyond Number.MAX_SAFE_INTEGER: a float would lose this.
    const out = [...aggregateFills(
      [fill({ quantity: "9007199254740993", quoteQuantity: "9007199254740993" })],
      lower,
    ).values()];
    expect(out[0]!.quantity).toBe(9_007_199_254_740_993n);
    expect(out[0]!.stake).toBe(9_007_199_254_740_993n);
  });

  it("skips fills with no transaction hash rather than inventing an id", () => {
    expect(aggregateFills([fill({ txHash: "" })], lower).size).toBe(0);
  });

  it("returns an empty map for no fills", () => {
    expect(aggregateFills([], lower).size).toBe(0);
  });
});
