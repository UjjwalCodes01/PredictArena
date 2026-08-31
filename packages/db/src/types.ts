/**
 * Shared domain types.
 *
 * These describe the PROJECTION of chain truth, not truth itself. Every field
 * here is derivable from the chain plus the window it refers to; nothing is
 * authoritative on its own.
 */

/** Position status. A boolean cannot express VOID, so an enum it is. */
export type CallStatus = "PENDING" | "WON" | "LOST" | "VOID" | "FAILED";

export type Direction = "UP" | "DOWN";

/** The subset of a call the scoring engine needs. Pure data, no DB types. */
export interface ScorableCall {
  readonly id: string;
  readonly wallet: string;
  readonly windowId: string;
  readonly direction: Direction;
  readonly status: CallStatus;
  /** Unix seconds the call was placed — orders the farming cap. */
  readonly placedAtSec: number;
  /** Unix seconds the window closed — orders streaks. */
  readonly closesAtSec: number;
  /** ISO week of the window close, e.g. "2026-W35". */
  readonly weekId: string;
  /**
   * Collateral committed, base units. With `quantity` this yields the price
   * paid per contract — which IS the probability this call asserted.
   */
  readonly stake: bigint;
  /** Contracts bought, base units. Zero means no derivable price. */
  readonly quantity: bigint;
}

export interface Standing {
  readonly rank: number;
  readonly wallet: string;
  readonly points: number;
  readonly wins: number;
  readonly losses: number;
  readonly voids: number;
  /** Settled calls that scored, excluding voids. The calibration denominator. */
  readonly settled: number;
  readonly currentStreak: number;
  readonly bestStreak: number;
  /**
   * Percent, 0–100, rounded to one decimal. `null` under the 5-call minimum —
   * the UI shows "—" rather than a number nobody should trust.
   */
  readonly calibration: number | null;
  /**
   * Brier score, 0–1, three decimals. Lower is better.
   *
   * The standard measure of forecast accuracy: the mean squared error between
   * what you asserted and what happened. On this venue the price paid IS the
   * asserted probability, so buying UP at 0.62 is a claim that UP is 62%
   * likely.
   *
   * 0.000 is perfect. **0.250 is what you score by saying "50%" every time**,
   * which is the line between forecasting and guessing.
   *
   * `null` under the minimum sample — a Brier from three calls is noise.
   */
  readonly brier: number | null;
  /**
   * Edge in percentage points, one decimal. Positive means skill.
   *
   * Realized win rate minus the average probability the market charged you.
   * Back UP at 60c and win 70% of the time and your edge is +10.0: you are
   * finding sides the market has underpriced.
   *
   * This exists because Brier alone rewards buying heavy favourites — which is
   * confidence, not skill. Edge is the number that answers "am I actually good
   * at this, or just lucky?", because luck averages to zero over enough calls.
   *
   * `null` under the minimum sample.
   */
  readonly edge: number | null;
  /** Mean probability the market charged, 0–100. Context for `edge`. */
  readonly avgImplied: number | null;
  /** Unix seconds of the most recent win. Null if none. Used to break ties. */
  readonly lastWinAtSec: number | null;
}

/** Minimum settled calls before a calibration figure is shown at all. */
export const CALIBRATION_MIN_SETTLED = 5;

/** Base points for a win, before the streak multiplier. */
export const POINTS_PER_WIN = 10;
