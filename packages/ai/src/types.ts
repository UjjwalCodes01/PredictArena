/**
 * What the forecaster asserts, and what it decides to do about it.
 *
 * Every number here is an INTEGER. A forecast is a probability, and a
 * probability sits directly beside a price the moment we look for an edge —
 * so letting a float in here would put one next to money (CLAUDE.md hard rule
 * 3). Probabilities travel as basis points and are converted to price units as
 * bigint before any comparison happens.
 */

export type Direction = "UP" | "DOWN";

/**
 * How much the model trusts its own estimate.
 *
 * Distinct from the probability itself: "confidently 50/50" and "no idea" are
 * both 5000 bps, and only one of them is worth acting on. It raises the edge
 * the model must see before it is allowed to trade.
 */
export type Confidence = "LOW" | "MEDIUM" | "HIGH";

/** Basis points. 10000 = certainty. */
export const BPS_UNIT = 10_000;

/**
 * One forecast on one window, as the model returned it.
 *
 * This is an ASSERTION, not a result. Whether it was right is derived later
 * from the chain, never from anything stored alongside it.
 */
export interface Forecast {
  /** Probability the window closes UP, 0–10000. Integer. */
  readonly probabilityUpBps: number;
  readonly confidence: Confidence;
  /** One or two sentences, shown to players verbatim. */
  readonly rationale: string;
  /** Short phrases that drove the estimate. Display only. */
  readonly keyFactors: readonly string[];
}

/**
 * Why the forecaster declined to trade.
 *
 * Passing is the common case and a deliberate feature: a forecaster that bets
 * every window is a coin flip with extra steps. These reasons are shown in the
 * UI so a pass reads as a decision rather than a failure.
 */
export type PassReason =
  | "NO_EDGE"
  | "NO_BOOK"
  | "PRICE_EXTREME"
  | "BUDGET_SPENT"
  | "WINDOW_CLOSING";

interface DecisionBase {
  readonly forecast: Forecast;
  /**
   * Edge on the side the model preferred, in price base units. Signed: a
   * negative value means the market is charging more than the model thinks the
   * outcome is worth.
   */
  readonly edge: bigint;
  /** The side the edge was measured on, even when we pass. */
  readonly side: Direction | null;
}

export interface PlaceDecision extends DecisionBase {
  readonly kind: "PLACE";
  readonly side: Direction;
  /** What the book was asking for that side, base units. */
  readonly ask: bigint;
}

export interface PassDecision extends DecisionBase {
  readonly kind: "PASS";
  readonly reason: PassReason;
}

export type Decision = PlaceDecision | PassDecision;

/** The prices the book is showing, per outcome, in collateral base units. */
export interface BookPrices {
  readonly up: bigint | null;
  readonly down: bigint | null;
}
