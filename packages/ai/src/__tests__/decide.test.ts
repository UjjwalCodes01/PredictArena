/**
 * The decision rule, pinned.
 *
 * The claim the whole AI angle rests on is "it passes unless it disagrees with
 * the market by enough". That is a property of this file and nothing else, so
 * it is tested exhaustively and without touching the network.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_ASK_BPS, MIN_ASK_BPS, MIN_EDGE_BPS,
  bpsToUnits, decide, edgeRequirementX10, unitsToBps,
} from "../decide";
import type { Confidence, Forecast } from "../types";

const DECIMALS = 6;
const UNIT = 1_000_000n;

function forecast(upBps: number, confidence: Confidence = "HIGH"): Forecast {
  return { probabilityUpBps: upBps, confidence, rationale: "test", keyFactors: [] };
}

describe("bpsToUnits", () => {
  it("converts exactly on both scales", () => {
    expect(bpsToUnits(10_000, DECIMALS)).toBe(UNIT);
    expect(bpsToUnits(5_000, DECIMALS)).toBe(500_000n);
    expect(bpsToUnits(0, DECIMALS)).toBe(0n);
    expect(bpsToUnits(1, DECIMALS)).toBe(100n);
  });

  it("round-trips through unitsToBps", () => {
    for (const bps of [0, 1, 137, 5_000, 9_999, 10_000]) {
      expect(unitsToBps(bpsToUnits(bps, DECIMALS), DECIMALS)).toBe(bps);
    }
  });

  it("refuses a non-integer, which is how a float would sneak in", () => {
    expect(() => bpsToUnits(50.5, DECIMALS)).toThrow(TypeError);
  });
});

describe("edgeRequirementX10", () => {
  it("demands more from a shakier estimate", () => {
    expect(edgeRequirementX10("HIGH")).toBe(10);
    expect(edgeRequirementX10("MEDIUM")).toBe(15);
    expect(edgeRequirementX10("LOW")).toBe(25);
  });
});

describe("decide", () => {
  it("places UP when the model prices UP above the book", () => {
    // Model: 70% UP. Book asks 60c. Ten points of edge.
    const d = decide({
      forecast: forecast(7_000),
      book: { up: 600_000n, down: 380_000n },
      decimals: DECIMALS,
    });
    expect(d.kind).toBe("PLACE");
    expect(d.side).toBe("UP");
    expect(d.edge).toBe(100_000n);
  });

  it("places DOWN when that is the better side", () => {
    const d = decide({
      forecast: forecast(3_000),
      book: { up: 400_000n, down: 600_000n },
      decimals: DECIMALS,
    });
    expect(d.kind).toBe("PLACE");
    expect(d.side).toBe("DOWN");
    expect(d.edge).toBe(100_000n);
  });

  it("passes when the market already agrees", () => {
    const d = decide({
      forecast: forecast(5_500),
      book: { up: 550_000n, down: 450_000n },
      decimals: DECIMALS,
    });
    expect(d.kind).toBe("PASS");
    if (d.kind === "PASS") expect(d.reason).toBe("NO_EDGE");
    expect(d.edge).toBe(0n);
  });

  it("passes on negative edge rather than trading anyway", () => {
    const d = decide({
      forecast: forecast(5_000),
      book: { up: 700_000n, down: 700_000n },
      decimals: DECIMALS,
    });
    expect(d.kind).toBe("PASS");
    expect(d.edge).toBeLessThan(0n);
  });

  it("scales the requirement by confidence: same edge, different answers", () => {
    // Ten points of edge: enough for HIGH and MEDIUM, not for LOW.
    const book = { up: 600_000n, down: 380_000n };
    const at = (c: Confidence) => decide({ forecast: forecast(7_000, c), book, decimals: DECIMALS });

    expect(at("HIGH").kind).toBe("PLACE");
    expect(at("MEDIUM").kind).toBe("PLACE");
    const low = at("LOW");
    expect(low.kind).toBe("PASS");
    if (low.kind === "PASS") expect(low.reason).toBe("NO_EDGE");
  });

  it("treats the threshold as inclusive", () => {
    const required = bpsToUnits(MIN_EDGE_BPS, DECIMALS);
    const ask = 500_000n;
    const exact = decide({
      forecast: forecast(unitsToBps(ask + required, DECIMALS)),
      book: { up: ask, down: 400_000n },
      decimals: DECIMALS,
    });
    expect(exact.edge).toBe(required);
    expect(exact.kind).toBe("PLACE");

    const oneShort = decide({
      forecast: forecast(unitsToBps(ask + required, DECIMALS) - 1),
      book: { up: ask, down: 400_000n },
      decimals: DECIMALS,
    });
    expect(oneShort.kind).toBe("PASS");
  });

  it("passes with NO_BOOK when nothing is resting at all", () => {
    const d = decide({
      forecast: forecast(9_000),
      book: { up: null, down: null },
      decimals: DECIMALS,
    });
    expect(d.kind).toBe("PASS");
    if (d.kind === "PASS") expect(d.reason).toBe("NO_BOOK");
    expect(d.side).toBeNull();
  });

  it("refuses both tails", () => {
    const d = decide({
      forecast: forecast(9_000),
      book: { up: bpsToUnits(MIN_ASK_BPS - 1, DECIMALS), down: bpsToUnits(MAX_ASK_BPS + 1, DECIMALS) },
      decimals: DECIMALS,
    });
    expect(d.kind).toBe("PASS");
    if (d.kind === "PASS") expect(d.reason).toBe("PRICE_EXTREME");
  });

  it("still trades the playable side when only one side is extreme", () => {
    const d = decide({
      forecast: forecast(3_000),
      book: { up: 20_000n, down: 600_000n },
      decimals: DECIMALS,
    });
    expect(d.kind).toBe("PLACE");
    expect(d.side).toBe("DOWN");
  });

  it("does not let an untradable side win the comparison", () => {
    // The trap: UP is priced at 2c, so a 90% model shows 88 points of apparent
    // edge there — far more than DOWN offers. Filtering AFTER picking a winner
    // would select UP, then pass, reporting the wrong reason and hiding a
    // genuinely playable side. UP must be excluded before the comparison.
    const d = decide({
      forecast: forecast(9_000),
      book: { up: 20_000n, down: 600_000n },
      decimals: DECIMALS,
    });
    expect(d.side).toBe("DOWN");
    expect(d.kind).toBe("PASS");
    if (d.kind === "PASS") expect(d.reason).toBe("NO_EDGE");
  });

  it("handles a one-sided book", () => {
    const d = decide({
      forecast: forecast(8_000),
      book: { up: 600_000n, down: null },
      decimals: DECIMALS,
    });
    expect(d.kind).toBe("PLACE");
    expect(d.side).toBe("UP");
    expect(d.edge).toBe(200_000n);
  });

  it("is deterministic — the same inputs always decide the same way", () => {
    const args = {
      forecast: forecast(6_800, "MEDIUM" as const),
      book: { up: 570_000n, down: 400_000n },
      decimals: DECIMALS,
    };
    const first = decide(args);
    for (let i = 0; i < 20; i += 1) {
      expect(decide(args)).toEqual(first);
    }
  });

  it("never places at a price the model prices below", () => {
    // Property sweep: across the whole grid, a PLACE must always carry a
    // non-negative edge and an ask inside the band.
    for (let up = 0; up <= 10_000; up += 250) {
      for (let ask = 0; ask <= 10_000; ask += 250) {
        const d = decide({
          forecast: forecast(up),
          book: { up: bpsToUnits(ask, DECIMALS), down: bpsToUnits(10_000 - ask, DECIMALS) },
          decimals: DECIMALS,
        });
        if (d.kind === "PLACE") {
          expect(d.edge).toBeGreaterThanOrEqual(bpsToUnits(MIN_EDGE_BPS, DECIMALS));
          expect(d.ask).toBeGreaterThanOrEqual(bpsToUnits(MIN_ASK_BPS, DECIMALS));
          expect(d.ask).toBeLessThanOrEqual(bpsToUnits(MAX_ASK_BPS, DECIMALS));
        }
      }
    }
  });
});
