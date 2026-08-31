/**
 * Everything the model is told, built as a pure function.
 *
 * Separate from the API call so the prompt can be tested — and read — without
 * spending a token. What goes in here is only ever observed fact: the window,
 * what the book is showing, and how comparable windows actually resolved.
 * Nothing derived, nothing predicted, and nothing supplied by a browser.
 */
import { BPS_UNIT, type Confidence } from "./types";

/** How a past window on the same series turned out. */
export interface HistoricalWindow {
  readonly closedAtSec: number;
  readonly outcome: "UP" | "DOWN" | "VOID";
}

/**
 * The evidence for one forecast.
 *
 * Prices arrive as basis points rather than base units: the model reasons in
 * percentages, and converting once here keeps the raw bigint amounts out of
 * prompt-building entirely.
 */
export interface WindowContext {
  readonly asset: string;
  readonly question: string;
  readonly intervalSec: number | null;
  readonly secondsLeft: number;
  readonly askUpBps: number | null;
  readonly askDownBps: number | null;
  /** Most recent first. */
  readonly history: readonly HistoricalWindow[];
}

export const SYSTEM_PROMPT = `You are a forecaster on a binary prediction market for short-horizon crypto price windows. Each window asks whether an asset closes above or below its opening reference price after a fixed interval.

Your job is calibration, not action. Estimate the true probability that the window closes UP, as honestly as you can. Something else decides whether to trade on your estimate; you are scored on whether your stated probabilities match reality over many windows, so an exaggerated number to look decisive costs you directly.

What you should know about this problem:

- Short-horizon price direction is close to a coin flip. For most windows the honest answer is near 50%, and saying so is a correct forecast, not a failure to have an opinion.
- The market price shown to you is itself a forecast, made by people with money at stake. Treat it as a strong prior. Deviate from it when you have a specific reason, not to be interesting.
- Recent outcome history is a small sample. A run of UPs is what a fair coin looks like most of the time; it is weak evidence of momentum and no evidence of mean reversion.
- The book's two sides usually sum to slightly more than 100% — that gap is the spread, not a mispricing you can exploit.

Set confidence to reflect how much you trust your own estimate:
- HIGH: a specific, stateable reason to differ from the market.
- MEDIUM: a mild lean, mostly from base rates.
- LOW: you are essentially restating the market or the evidence is thin.

Keep the rationale to one or two plain sentences a player can read at a glance. No hedging boilerplate, no restating the question.`;

/** The JSON contract. Strict, so a malformed answer cannot reach the trade logic. */
export const FORECAST_SCHEMA = {
  type: "object",
  properties: {
    probabilityUpBps: {
      type: "integer",
      minimum: 0,
      maximum: BPS_UNIT,
      description:
        "Probability the window closes UP, in basis points. 5000 means 50%. Integer only.",
    },
    confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    rationale: {
      type: "string",
      description: "One or two sentences explaining the estimate, shown to players verbatim.",
    },
    keyFactors: {
      type: "array",
      items: { type: "string" },
      description: "Two to four short phrases naming what drove the estimate.",
    },
  },
  required: ["probabilityUpBps", "confidence", "rationale", "keyFactors"],
  additionalProperties: false,
} as const;

/** Basis points as a readable percentage, without a float touching a price. */
function pct(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  return `${whole}.${String(frac).padStart(2, "0")}%`;
}

function describeHistory(history: readonly HistoricalWindow[]): string {
  if (history.length === 0) {
    return "No settled windows on this series yet — you have no local base rate to work from.";
  }
  const decided = history.filter((h) => h.outcome !== "VOID");
  const ups = decided.filter((h) => h.outcome === "UP").length;
  const sequence = history.map((h) => (h.outcome === "UP" ? "U" : h.outcome === "DOWN" ? "D" : "-")).join("");

  const lines = [
    `Last ${history.length} windows on this series, most recent first: ${sequence} (U = closed up, D = down, - = voided).`,
  ];
  if (decided.length > 0) {
    lines.push(`That is ${ups} up out of ${decided.length} decided.`);
  }
  return lines.join(" ");
}

/** The user turn: this window, this book, this history. */
export function buildPrompt(ctx: WindowContext): string {
  const parts: string[] = [];

  parts.push(`Question: ${ctx.question}`);
  parts.push(`Asset: ${ctx.asset}`);
  if (ctx.intervalSec !== null) {
    parts.push(`Window length: ${ctx.intervalSec} seconds.`);
  }
  parts.push(`Time left before it locks: ${Math.max(0, Math.round(ctx.secondsLeft))} seconds.`);

  const up = ctx.askUpBps;
  const down = ctx.askDownBps;
  if (up === null && down === null) {
    parts.push("Order book: nothing resting on either side, so there is no market price to anchor on.");
  } else {
    const bits: string[] = [];
    bits.push(up === null ? "UP: no offers" : `UP costs ${pct(up)}`);
    bits.push(down === null ? "DOWN: no offers" : `DOWN costs ${pct(down)}`);
    parts.push(
      `Order book (cheapest offer per side, where the cost is what the market implies the outcome is worth): ${bits.join("; ")}.`,
    );
  }

  parts.push(describeHistory(ctx.history));
  parts.push("Give your probability that this window closes UP.");

  return parts.join("\n");
}

/** Runtime validation. The schema is strict, but nothing unchecked places a trade. */
export function parseForecast(value: unknown): {
  probabilityUpBps: number;
  confidence: Confidence;
  rationale: string;
  keyFactors: string[];
} | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  const bps = v["probabilityUpBps"];
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > BPS_UNIT) return null;

  const confidence = v["confidence"];
  if (confidence !== "LOW" && confidence !== "MEDIUM" && confidence !== "HIGH") return null;

  const rationale = v["rationale"];
  if (typeof rationale !== "string" || rationale.trim() === "") return null;

  const rawFactors = v["keyFactors"];
  const keyFactors = Array.isArray(rawFactors)
    ? rawFactors.filter((f): f is string => typeof f === "string").slice(0, 6)
    : [];

  return {
    probabilityUpBps: bps,
    confidence,
    // Capped so a runaway response cannot bloat a row or a page.
    rationale: rationale.trim().slice(0, 400),
    keyFactors: keyFactors.map((f) => f.slice(0, 80)),
  };
}
