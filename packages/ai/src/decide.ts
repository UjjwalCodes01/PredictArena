/**
 * The decision rule. Pure: no I/O, no clock, no randomness, no model call.
 *
 * This is deliberately separate from the model. What Claude produces is an
 * ESTIMATE; whether that estimate is worth acting on is arithmetic, and
 * arithmetic is testable. Keeping the two apart means the interesting property
 * — "it only trades when it disagrees with the market by enough" — is pinned
 * by table-driven tests rather than hoped for.
 *
 * All comparisons happen in collateral base units as bigint. A binary contract
 * settles at exactly 1.0 collateral, so a probability and a price live on the
 * same scale and subtract directly. That is also why no float may appear here:
 * the probability sits beside an amount in every expression below.
 */
import { BPS_UNIT, type BookPrices, type Confidence, type Decision, type Forecast } from "./types";

/**
 * Minimum edge before the forecaster will trade, in basis points.
 *
 * Set above plausible model error rather than at zero. At zero it would trade
 * on rounding, pay the spread every time, and grind its edge negative while
 * looking busy — which is exactly the failure mode that makes an AI player a
 * gimmick instead of a benchmark.
 */
export const MIN_EDGE_BPS = 600;

/**
 * Refuse the tails.
 *
 * Model error is worst where the market is most confident, and a two-point
 * miss on a 3c longshot looks like enormous edge while being noise. These are
 * also the levels where the book is thinnest, so a fill is least likely to
 * resemble the quote.
 */
export const MIN_ASK_BPS = 500;
export const MAX_ASK_BPS = 9_500;

/**
 * How much more edge a shakier estimate must show, times ten.
 *
 * Integer tenths so the multiplier never introduces a float, matching the
 * streak multiplier in the scoring engine.
 */
export function edgeRequirementX10(confidence: Confidence): number {
  switch (confidence) {
    case "HIGH":
      return 10;
    case "MEDIUM":
      return 15;
    case "LOW":
      return 25;
  }
}

/** Basis points to collateral base units. Exact: both scales are powers of ten. */
export function bpsToUnits(bps: number, decimals: number): bigint {
  if (!Number.isInteger(bps)) {
    throw new TypeError(`Basis points must be an integer, got ${bps}.`);
  }
  return (BigInt(bps) * 10n ** BigInt(decimals)) / BigInt(BPS_UNIT);
}

/** Collateral base units back to basis points, truncating. For display only. */
export function unitsToBps(units: bigint, decimals: number): number {
  return Number((units * BigInt(BPS_UNIT)) / 10n ** BigInt(decimals));
}

export interface DecideOptions {
  readonly forecast: Forecast;
  readonly book: BookPrices;
  readonly decimals: number;
  /** Override the edge floor. Tests use it; production does not. */
  readonly minEdgeBps?: number;
}

/**
 * Should the forecaster trade this window, and on which side?
 *
 * Edge is what the model thinks an outcome is worth minus what the book is
 * charging for it. Both sides are evaluated, the better one is chosen, and it
 * still has to clear a confidence-scaled floor before anything is placed.
 */
export function decide(opts: DecideOptions): Decision {
  const { forecast, book, decimals } = opts;
  const unit = 10n ** BigInt(decimals);

  const fairUp = bpsToUnits(forecast.probabilityUpBps, decimals);
  const fairDown = unit - fairUp;

  const floor = bpsToUnits(opts.minEdgeBps ?? MIN_EDGE_BPS, decimals);
  const required = (floor * BigInt(edgeRequirementX10(forecast.confidence))) / 10n;

  const lowAsk = bpsToUnits(MIN_ASK_BPS, decimals);
  const highAsk = bpsToUnits(MAX_ASK_BPS, decimals);

  // A side is only playable if something is actually resting on it at a level
  // worth touching. Both filters have to happen before picking a winner, or an
  // untradable side with a huge notional edge would win and then pass — which
  // reports the wrong reason to the player.
  const tradable = (ask: bigint | null): boolean =>
    ask !== null && ask >= lowAsk && ask <= highAsk;

  const upOk = tradable(book.up);
  const downOk = tradable(book.down);

  if (book.up === null && book.down === null) {
    return { kind: "PASS", reason: "NO_BOOK", forecast, edge: 0n, side: null };
  }
  if (!upOk && !downOk) {
    // Something is resting, but only outside the band we will touch.
    return { kind: "PASS", reason: "PRICE_EXTREME", forecast, edge: 0n, side: null };
  }

  const edgeUp = upOk && book.up !== null ? fairUp - book.up : null;
  const edgeDown = downOk && book.down !== null ? fairDown - book.down : null;

  // Pick the better of the two playable sides.
  let side: "UP" | "DOWN";
  let edge: bigint;
  if (edgeUp !== null && (edgeDown === null || edgeUp >= edgeDown)) {
    side = "UP";
    edge = edgeUp;
  } else {
    side = "DOWN";
    edge = edgeDown as bigint;
  }

  if (edge < required) {
    return { kind: "PASS", reason: "NO_EDGE", forecast, edge, side };
  }

  const ask = (side === "UP" ? book.up : book.down) as bigint;
  return { kind: "PLACE", side, ask, edge, forecast };
}
