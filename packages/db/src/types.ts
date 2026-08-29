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
  /** Unix seconds of the most recent win. Null if none. Used to break ties. */
  readonly lastWinAtSec: number | null;
}

/** Minimum settled calls before a calibration figure is shown at all. */
export const CALIBRATION_MIN_SETTLED = 5;

/** Base points for a win, before the streak multiplier. */
export const POINTS_PER_WIN = 10;
