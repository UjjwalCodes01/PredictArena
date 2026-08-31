/**
 * The prompt, and the boundary where a model response becomes trusted data.
 *
 * `parseForecast` is the one place an outside answer turns into something that
 * can move money, so it is tested like untrusted input — because that is what
 * it is. A response the validator cannot vouch for must produce null, never a
 * default that quietly trades.
 */
import { describe, expect, it } from "vitest";
import { buildPrompt, parseForecast, SYSTEM_PROMPT, FORECAST_SCHEMA } from "../prompt";
import type { WindowContext } from "../prompt";

const base: WindowContext = {
  asset: "BTC",
  question: "Will BTC close above its opening price?",
  intervalSec: 300,
  secondsLeft: 210,
  askUpBps: 5_400,
  askDownBps: 4_800,
  history: [
    { closedAtSec: 1_000, outcome: "UP" },
    { closedAtSec: 900, outcome: "DOWN" },
    { closedAtSec: 800, outcome: "UP" },
  ],
};

describe("buildPrompt", () => {
  it("states the question, the book and the history", () => {
    const p = buildPrompt(base);
    expect(p).toContain("Will BTC close above its opening price?");
    expect(p).toContain("54.00%");
    expect(p).toContain("48.00%");
    expect(p).toContain("UDU");
    expect(p).toContain("2 up out of 3 decided");
  });

  it("says so plainly when there is no book, rather than implying a price", () => {
    const p = buildPrompt({ ...base, askUpBps: null, askDownBps: null });
    expect(p).toContain("nothing resting on either side");
    expect(p).not.toContain("%.");
  });

  it("handles a one-sided book without inventing the other side", () => {
    const p = buildPrompt({ ...base, askDownBps: null });
    expect(p).toContain("UP costs 54.00%");
    expect(p).toContain("DOWN: no offers");
  });

  it("does not fabricate a base rate from an empty history", () => {
    const p = buildPrompt({ ...base, history: [] });
    expect(p).toContain("No settled windows on this series yet");
    expect(p).not.toContain("out of");
  });

  it("counts voided windows out of the base rate", () => {
    const p = buildPrompt({
      ...base,
      history: [
        { closedAtSec: 3, outcome: "UP" },
        { closedAtSec: 2, outcome: "VOID" },
        { closedAtSec: 1, outcome: "DOWN" },
      ],
    });
    // Three windows shown, but only two of them decided anything.
    expect(p).toContain("U-D");
    expect(p).toContain("1 up out of 2 decided");
  });

  it("never goes negative on a window that has already passed its close", () => {
    const p = buildPrompt({ ...base, secondsLeft: -30 });
    expect(p).toContain("Time left before it locks: 0 seconds");
  });

  it("is deterministic — the same context builds the same prompt", () => {
    expect(buildPrompt(base)).toBe(buildPrompt(base));
  });
});

describe("SYSTEM_PROMPT", () => {
  it("tells the model that near-50% is a correct answer", () => {
    // The single most important instruction: without it the model reaches for
    // a confident number because confident numbers look like better answers.
    expect(SYSTEM_PROMPT).toContain("near 50%");
  });

  it("frames the market price as a prior rather than a target to beat", () => {
    expect(SYSTEM_PROMPT).toContain("strong prior");
  });
});

describe("FORECAST_SCHEMA", () => {
  it("is strict, so a stray field cannot ride along", () => {
    expect(FORECAST_SCHEMA.additionalProperties).toBe(false);
    expect([...FORECAST_SCHEMA.required]).toEqual([
      "probabilityUpBps", "confidence", "rationale", "keyFactors",
    ]);
  });

  it("constrains the probability to the basis-point range", () => {
    expect(FORECAST_SCHEMA.properties.probabilityUpBps.type).toBe("integer");
    expect(FORECAST_SCHEMA.properties.probabilityUpBps.minimum).toBe(0);
    expect(FORECAST_SCHEMA.properties.probabilityUpBps.maximum).toBe(10_000);
  });
});

describe("parseForecast", () => {
  const good = {
    probabilityUpBps: 6_200,
    confidence: "MEDIUM",
    rationale: "  Slight upward lean from the base rate.  ",
    keyFactors: ["base rate", "thin book"],
  };

  it("accepts a well-formed answer and trims it", () => {
    const f = parseForecast(good);
    expect(f).not.toBeNull();
    expect(f?.probabilityUpBps).toBe(6_200);
    expect(f?.confidence).toBe("MEDIUM");
    expect(f?.rationale).toBe("Slight upward lean from the base rate.");
    expect(f?.keyFactors).toEqual(["base rate", "thin book"]);
  });

  it.each([
    ["null", null],
    ["a string", "6200"],
    ["a number", 6_200],
    ["an array", []],
  ])("rejects %s", (_label, value) => {
    expect(parseForecast(value)).toBeNull();
  });

  it.each([
    ["a fractional probability, which is how a float gets in", { ...good, probabilityUpBps: 62.5 }],
    ["a probability above the range", { ...good, probabilityUpBps: 10_001 }],
    ["a negative probability", { ...good, probabilityUpBps: -1 }],
    ["a probability sent as a string", { ...good, probabilityUpBps: "6200" }],
    ["an unknown confidence level", { ...good, confidence: "VERY_HIGH" }],
    ["a lowercase confidence level", { ...good, confidence: "high" }],
    ["a missing rationale", { ...good, rationale: undefined }],
    ["an empty rationale", { ...good, rationale: "   " }],
  ])("rejects %s", (_label, value) => {
    expect(parseForecast(value)).toBeNull();
  });

  it("accepts the exact boundaries", () => {
    expect(parseForecast({ ...good, probabilityUpBps: 0 })?.probabilityUpBps).toBe(0);
    expect(parseForecast({ ...good, probabilityUpBps: 10_000 })?.probabilityUpBps).toBe(10_000);
  });

  it("survives missing or malformed factors rather than failing the forecast", () => {
    // Factors are decoration. Losing them must not cost a valid estimate.
    expect(parseForecast({ ...good, keyFactors: undefined })?.keyFactors).toEqual([]);
    expect(parseForecast({ ...good, keyFactors: "not an array" })?.keyFactors).toEqual([]);
    expect(parseForecast({ ...good, keyFactors: [1, "kept", null] })?.keyFactors).toEqual(["kept"]);
  });

  it("caps a runaway response so it cannot bloat a row or a page", () => {
    const f = parseForecast({
      ...good,
      rationale: "x".repeat(5_000),
      keyFactors: Array.from({ length: 50 }, () => "y".repeat(500)),
    });
    expect(f?.rationale.length).toBe(400);
    expect(f?.keyFactors.length).toBe(6);
    expect(f?.keyFactors[0]?.length).toBe(80);
  });
});
